//! Cancellation and bounded waits for metadata reads. No database I/O holds this lock.
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

const CANCELLED: &str = "読み込みを中断しました。";
pub const READ_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
struct Registry {
    epoch: u64,
    next_id: u64,
    jobs: HashMap<u64, oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct ReadOperations(Mutex<Registry>);

pub struct ReadTicket<'a> {
    registry: &'a ReadOperations,
    epoch: u64,
    id: u64,
    receiver: Option<oneshot::Receiver<()>>,
}

impl ReadOperations {
    pub fn publish<T>(&self, epoch: u64, update: impl FnOnce() -> T) -> Result<T, String> {
        let registry = self.0.lock().map_err(|_| CANCELLED)?;
        if registry.epoch != epoch {
            return Err(CANCELLED.into());
        }
        Ok(update())
    }
    pub fn register(&self) -> Result<ReadTicket<'_>, String> {
        let mut registry = self.0.lock().map_err(|_| CANCELLED)?;
        registry.next_id += 1;
        let id = registry.next_id;
        let (sender, receiver) = oneshot::channel();
        registry.jobs.insert(id, sender);
        Ok(ReadTicket {
            registry: self,
            epoch: registry.epoch,
            id,
            receiver: Some(receiver),
        })
    }

    pub fn cancel_all(&self) -> Result<(), String> {
        let mut registry = self.0.lock().map_err(|_| CANCELLED)?;
        registry.epoch += 1;
        for (_, sender) in registry.jobs.drain() {
            let _ = sender.send(());
        }
        Ok(())
    }
}

impl ReadTicket<'_> {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    // The epoch check and publication must be atomic with respect to cancellation.
    pub fn publish<T>(&self, update: impl FnOnce() -> T) -> Result<T, String> {
        self.registry.publish(self.epoch, update)
    }

    pub async fn run<T>(
        &mut self,
        operation: impl std::future::Future<Output = Result<T, String>>,
        timeout: Duration,
    ) -> Result<T, String> {
        self.publish(|| ())?;
        let receiver = self.receiver.take().ok_or(CANCELLED)?;
        let bounded = async {
            tokio::time::timeout(timeout, operation)
                .await
                .map_err(|_| {
                    "読み込みが時間上限を超えました。接続状態を確認して再試行してください。"
                        .to_owned()
                })?
        };
        let result = match futures_util::future::select(Box::pin(bounded), receiver).await {
            futures_util::future::Either::Left((result, _)) => result,
            futures_util::future::Either::Right(_) => Err(CANCELLED.into()),
        };
        result
    }
}

impl Drop for ReadTicket<'_> {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.0.lock() {
            registry.jobs.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn cancel_drops_the_pending_reader_and_prevents_stale_publication() {
        struct Reader(Arc<AtomicBool>);
        impl Drop for Reader {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let reads = ReadOperations::default();
                let mut ticket = reads.register().unwrap();
                let released = Arc::new(AtomicBool::new(false));
                let reader = Reader(released.clone());
                let operation = async {
                    let _reader = reader;
                    reads.cancel_all().unwrap();
                    std::future::pending::<Result<(), String>>().await
                };
                assert!(ticket
                    .run(operation, READ_TIMEOUT)
                    .await
                    .unwrap_err()
                    .contains("中断"));
                assert!(released.load(Ordering::SeqCst));
                assert!(ticket
                    .publish(|| panic!("must not restore an old session"))
                    .is_err());
                let mut next = reads.register().unwrap();
                assert_eq!(next.run(async { Ok(42) }, READ_TIMEOUT).await.unwrap(), 42);
            });
    }

    #[test]
    fn timeout_and_cancellation_before_start_do_not_leak_jobs() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let reads = ReadOperations::default();
                {
                    let mut ticket = reads.register().unwrap();
                    assert!(ticket
                        .run(
                            std::future::pending::<Result<(), String>>(),
                            Duration::from_millis(5)
                        )
                        .await
                        .unwrap_err()
                        .contains("時間上限"));
                }
                assert!(reads.0.lock().unwrap().jobs.is_empty());
                let mut ticket = reads.register().unwrap();
                reads.cancel_all().unwrap();
                assert!(ticket
                    .run::<()>(async { panic!("must not start") }, READ_TIMEOUT)
                    .await
                    .is_err());
            });
    }
}
