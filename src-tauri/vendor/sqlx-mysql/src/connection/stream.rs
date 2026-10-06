use std::collections::VecDeque;
use std::ops::{Deref, DerefMut};

use bytes::{Buf, Bytes, BytesMut};

use crate::collation::{CharSet, Collation};
use crate::error::Error;
use crate::io::MySqlBufExt;
use crate::io::{ProtocolDecode, ProtocolEncode};
use crate::net::{BufferedSocket, Socket};
use crate::protocol::response::{EofPacket, ErrPacket, OkPacket, Status};
use crate::protocol::{Capabilities, Packet};
use crate::{MySqlConnectOptions, MySqlDatabaseError};

// RelaGrid receive guard: inspect the advertised length before reading or
// allocating its payload. Smaller than a continuation segment (0xFF_FF_FF),
// so oversized logical packets cannot reach the assembly allocation below.
const MAX_RECEIVE_PACKET_BYTES: usize = 8_000_000;

fn check_receive_packet_size(packet_size: usize) -> Result<(), Error> {
    if packet_size > MAX_RECEIVE_PACKET_BYTES {
        return Err(err_protocol!(
            "MySQL receive packet exceeds RelaGrid's {} byte safety limit (advertised: {})",
            MAX_RECEIVE_PACKET_BYTES,
            packet_size
        ));
    }
    Ok(())
}

pub struct MySqlStream<S = Box<dyn Socket>> {
    // Wrapping the socket in `Box` allows us to unsize in-place.
    pub(crate) socket: BufferedSocket<S>,
    pub(crate) server_version: (u16, u16, u16),
    pub(super) capabilities: Capabilities,
    pub(crate) sequence_id: u8,
    pub(crate) waiting: VecDeque<Waiting>,
    pub(crate) charset: CharSet,
    pub(crate) collation: Collation,
    pub(crate) is_tls: bool,
    // An oversized response leaves unread bytes: never parse or reuse it again.
    pub(super) receive_failed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Waiting {
    // waiting for a result set
    Result,

    // waiting for a row within a result set
    Row,
}

impl<S: Socket> MySqlStream<S> {
    pub(crate) fn with_socket(
        charset: CharSet,
        collation: Collation,
        options: &MySqlConnectOptions,
        socket: S,
    ) -> Self {
        let mut capabilities = Capabilities::PROTOCOL_41
            | Capabilities::IGNORE_SPACE
            | Capabilities::DEPRECATE_EOF
            | Capabilities::FOUND_ROWS
            | Capabilities::TRANSACTIONS
            | Capabilities::SECURE_CONNECTION
            | Capabilities::PLUGIN_AUTH_LENENC_DATA
            | Capabilities::MULTI_STATEMENTS
            | Capabilities::MULTI_RESULTS
            | Capabilities::PLUGIN_AUTH
            | Capabilities::PS_MULTI_RESULTS
            | Capabilities::SSL;

        if options.database.is_some() {
            capabilities |= Capabilities::CONNECT_WITH_DB;
        }

        Self {
            waiting: VecDeque::new(),
            capabilities,
            server_version: (0, 0, 0),
            sequence_id: 0,
            collation,
            charset,
            socket: BufferedSocket::new(socket),
            is_tls: false,
            receive_failed: false,
        }
    }

    pub(crate) async fn wait_until_ready(&mut self) -> Result<(), Error> {
        if self.receive_failed {
            return Err(err_protocol!(
                "MySQL connection is unusable after receive safety limit"
            ));
        }
        if !self.socket.write_buffer().is_empty() {
            self.socket.flush().await?;
        }

        while !self.waiting.is_empty() {
            while self.waiting.front() == Some(&Waiting::Row) {
                let packet = self.recv_packet().await?;

                if !packet.is_empty() && packet[0] == 0xfe && packet.len() < 9 {
                    let eof = packet.eof(self.capabilities)?;

                    if eof.status.contains(Status::SERVER_MORE_RESULTS_EXISTS) {
                        *self.waiting.front_mut().unwrap() = Waiting::Result;
                    } else {
                        self.waiting.pop_front();
                    };
                }
            }

            while self.waiting.front() == Some(&Waiting::Result) {
                let packet = self.recv_packet().await?;

                if !packet.is_empty() && (packet[0] == 0x00 || packet[0] == 0xff) {
                    let ok = packet.ok()?;

                    if !ok.status.contains(Status::SERVER_MORE_RESULTS_EXISTS) {
                        self.waiting.pop_front();
                    }
                } else {
                    *self.waiting.front_mut().unwrap() = Waiting::Row;
                    self.skip_result_metadata(packet).await?;
                }
            }
        }

        Ok(())
    }

    pub(crate) async fn send_packet<'en, T>(&mut self, payload: T) -> Result<(), Error>
    where
        T: ProtocolEncode<'en, Capabilities>,
    {
        self.sequence_id = 0;
        self.write_packet(payload)?;
        self.flush().await?;
        Ok(())
    }

    pub(crate) fn write_packet<'en, T>(&mut self, payload: T) -> Result<(), Error>
    where
        T: ProtocolEncode<'en, Capabilities>,
    {
        self.socket
            .write_with(Packet(payload), (self.capabilities, &mut self.sequence_id))
    }

    async fn recv_packet_part(&mut self) -> Result<Bytes, Error> {
        if self.receive_failed {
            return Err(err_protocol!(
                "MySQL connection is unusable after receive safety limit"
            ));
        }
        // https://dev.mysql.com/doc/dev/mysql-server/8.0.12/page_protocol_basic_packets.html
        // https://mariadb.com/kb/en/library/0-packet/#standard-packet

        let mut header: Bytes = self.socket.read(4).await?;

        // cannot overflow
        #[allow(clippy::cast_possible_truncation)]
        let packet_size = header.get_uint_le(3) as usize;
        let sequence_id = header.get_u8();

        if let Err(error) = check_receive_packet_size(packet_size) {
            self.receive_failed = true;
            return Err(error);
        }

        self.sequence_id = sequence_id.wrapping_add(1);

        let payload: Bytes = self.socket.read(packet_size).await?;

        // TODO: packet compression

        Ok(payload)
    }

    // receive the next packet from the database server
    // may block (async) on more data from the server
    pub(crate) async fn recv_packet(&mut self) -> Result<Packet<Bytes>, Error> {
        let payload = self.recv_packet_part().await?;
        let payload = if payload.len() < 0xFF_FF_FF {
            payload
        } else {
            let mut final_payload = BytesMut::with_capacity(0xFF_FF_FF * 2);
            final_payload.extend_from_slice(&payload);

            drop(payload); // we don't need the allocation anymore

            let mut last_read = 0xFF_FF_FF;
            while last_read == 0xFF_FF_FF {
                let part = self.recv_packet_part().await?;
                last_read = part.len();
                final_payload.extend_from_slice(&part);
            }
            final_payload.into()
        };

        if payload
            .first()
            .ok_or(err_protocol!("Packet empty"))?
            .eq(&0xff)
        {
            self.waiting.pop_front();

            // instead of letting this packet be looked at everywhere, we check here
            // and emit a proper Error
            return Err(
                MySqlDatabaseError(ErrPacket::decode_with(payload, self.capabilities)?).into(),
            );
        }

        Ok(Packet(payload))
    }

    pub(crate) async fn recv<'de, T>(&mut self) -> Result<T, Error>
    where
        T: ProtocolDecode<'de, Capabilities>,
    {
        self.recv_packet().await?.decode_with(self.capabilities)
    }

    pub(crate) async fn recv_ok(&mut self) -> Result<OkPacket, Error> {
        self.recv_packet().await?.ok()
    }

    pub(crate) async fn maybe_recv_eof(&mut self) -> Result<Option<EofPacket>, Error> {
        if self.capabilities.contains(Capabilities::DEPRECATE_EOF) {
            Ok(None)
        } else {
            self.recv().await.map(Some)
        }
    }

    async fn skip_result_metadata(&mut self, mut packet: Packet<Bytes>) -> Result<(), Error> {
        let num_columns: u64 = packet.get_uint_lenenc(); // column count

        for _ in 0..num_columns {
            let _ = self.recv_packet().await?;
        }

        self.maybe_recv_eof().await?;

        Ok(())
    }

    pub fn boxed_socket(self) -> MySqlStream {
        MySqlStream {
            socket: self.socket.boxed(),
            server_version: self.server_version,
            capabilities: self.capabilities,
            sequence_id: self.sequence_id,
            waiting: self.waiting,
            charset: self.charset,
            collation: self.collation,
            is_tls: self.is_tls,
            receive_failed: self.receive_failed,
        }
    }
}

impl<S> Deref for MySqlStream<S> {
    type Target = BufferedSocket<S>;

    fn deref(&self) -> &Self::Target {
        &self.socket
    }
}

impl<S> DerefMut for MySqlStream<S> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.socket
    }
}

#[cfg(test)]
mod relagrid_receive_tests {
    use super::*;
    use futures_util::FutureExt;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::task::{Context, Poll};

    struct HeaderSocket {
        bytes_read: Arc<AtomicUsize>,
        header: [u8; 4],
    }

    impl Socket for HeaderSocket {
        fn try_read(&mut self, buf: &mut dyn crate::io::ReadBuf) -> std::io::Result<usize> {
            let offset = self.bytes_read.load(Ordering::Relaxed);
            // Any request to consume payload fails this test immediately.
            assert!(offset < 4, "oversized packet payload was read");
            buf.put_slice(&self.header[offset..]);
            self.bytes_read.store(4, Ordering::Relaxed);
            Ok(4 - offset)
        }
        fn try_write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            unreachable!()
        }
        fn poll_read_ready(&mut self, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_write_ready(&mut self, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(&mut self, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn oversized_header_is_rejected_without_reading_payload() {
        let bytes_read = Arc::new(AtomicUsize::new(0));
        let length = (MAX_RECEIVE_PACKET_BYTES + 1).to_le_bytes();
        let socket = HeaderSocket {
            bytes_read: bytes_read.clone(),
            header: [length[0], length[1], length[2], 0],
        };
        let mut stream = MySqlStream::with_socket(
            CharSet::utf8mb4,
            Collation::utf8mb4_unicode_ci,
            &MySqlConnectOptions::default(),
            socket,
        );
        let result = stream
            .recv_packet()
            .now_or_never()
            .expect("header test must not block");
        assert!(result.is_err());
        assert_eq!(bytes_read.load(Ordering::Relaxed), 4);
        assert!(stream.recv_packet().now_or_never().unwrap().is_err());
        assert!(stream.wait_until_ready().now_or_never().unwrap().is_err());
        assert_eq!(bytes_read.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn packet_guard_checks_exact_boundary_and_continuation_segments() {
        assert!(check_receive_packet_size(0).is_ok());
        assert!(check_receive_packet_size(MAX_RECEIVE_PACKET_BYTES).is_ok());
        assert!(check_receive_packet_size(MAX_RECEIVE_PACKET_BYTES + 1).is_err());
        assert!(check_receive_packet_size(0xFF_FF_FF).is_err());
        assert!(check_receive_packet_size(usize::MAX).is_err());
    }
}
