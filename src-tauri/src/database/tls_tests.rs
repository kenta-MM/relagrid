//! Loopback-only MySQL greeting/TLS fixture. No database or production credentials.
use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sqlx::{Connection, MySqlConnection};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;

const CA: &str = include_str!("../../test-fixtures/tls/ca.pem");
const CERT: &[u8] = include_bytes!("../../test-fixtures/tls/server.der");
const KEY: &[u8] = include_bytes!("../../test-fixtures/tls/server-key.der");

fn config(port: u16, trusted: bool) -> ConnectionConfig {
    ConnectionConfig {
        host: "127.0.0.1".into(),
        port,
        username: "fixture".into(),
        password: "fixture".into(),
        database: "fixture".into(),
        read_only: true,
        tls_ca_pem: trusted.then(|| CA.into()),
    }
}

fn handshake(cert: Option<&'static [u8]>, trusted: bool) -> (String, bool) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let flags: u32 = 0x0008_8208 | if cert.is_some() { 0x0800 } else { 0 };
        let mut greeting = vec![10];
        greeting.extend_from_slice(b"8.0.44-fixture\0");
        greeting.extend_from_slice(&1u32.to_le_bytes());
        greeting.extend_from_slice(b"12345678\0");
        greeting.extend_from_slice(&(flags as u16).to_le_bytes());
        greeting.push(45);
        greeting.extend_from_slice(&2u16.to_le_bytes());
        greeting.extend_from_slice(&((flags >> 16) as u16).to_le_bytes());
        greeting.push(21);
        greeting.extend_from_slice(&[0; 10]);
        greeting.extend_from_slice(b"abcdefghijkl\0mysql_native_password\0");
        let mut packet = vec![greeting.len() as u8, 0, 0, 0];
        packet.extend(greeting);
        socket.write_all(&packet).unwrap();
        let mut header = [0; 4];
        if socket.read_exact(&mut header).is_err() {
            return false;
        }
        let Some(cert) = cert else {
            panic!("client sent authentication without TLS")
        };
        let length = header[0] as usize | (header[1] as usize) << 8 | (header[2] as usize) << 16;
        assert_eq!(length, 32, "client must first request TLS");
        let mut request = vec![0; length];
        socket.read_exact(&mut request).unwrap();
        let tls_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert.to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
            )
            .unwrap();
        let tls = rustls::ServerConnection::new(Arc::new(tls_config)).unwrap();
        let mut stream = rustls::StreamOwned::new(tls, socket);
        if stream.read_exact(&mut header).is_err() {
            return false;
        }
        let length = header[0] as usize | (header[1] as usize) << 8 | (header[2] as usize) << 16;
        let mut authentication = vec![0; length];
        stream.read_exact(&mut authentication).unwrap();
        let error = b"\xff\x15\x04#28000fixture-auth-rejected";
        stream.write_all(&[error.len() as u8, 0, 0, 3]).unwrap();
        stream.write_all(error).unwrap();
        stream.flush().unwrap();
        true
    });
    let options = connection_options(&config(port, trusted)).unwrap();
    assert!(matches!(
        options.get_ssl_mode(),
        MySqlSslMode::VerifyIdentity
    ));
    let error = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                MySqlConnection::connect_with(&options),
            )
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
        });
    (error, server.join().unwrap())
}

#[test]
fn verified_tls_reaches_authentication_only_with_trusted_matching_certificate() {
    let (error, authenticated) = handshake(Some(CERT), true);
    assert!(authenticated, "{error}");
    assert!(error.contains("fixture-auth-rejected"), "{error}");
}

#[test]
fn untrusted_expired_wrong_host_and_non_tls_never_receive_credentials() {
    for (cert, trusted) in [
        (Some(CERT), false),
        (
            Some(include_bytes!("../../test-fixtures/tls/expired.der").as_slice()),
            true,
        ),
        (
            Some(include_bytes!("../../test-fixtures/tls/wrong-host.der").as_slice()),
            true,
        ),
        (None, true),
    ] {
        let (error, authenticated) = handshake(cert, trusted);
        assert!(
            !authenticated,
            "invalid endpoint received credentials: {error}"
        );
        assert!(!error.contains("fixture-auth-rejected"));
    }
}

#[test]
fn rejects_private_keys_and_oversized_ca_input() {
    for pem in ["-----BEGIN PRIVATE KEY-----".into(), "x".repeat(65537)] {
        let mut config = config(3307, false);
        config.tls_ca_pem = Some(pem);
        assert!(connection_options(&config).is_err());
    }
}
