mod csv_export;
mod database;
mod models;

use models::{ConnectionConfig, Preview, QueryResult, SchemaSnapshot};
use sqlx::MySqlPool;
use tauri::State;
use tokio::sync::{oneshot, Mutex};

struct Session {
    pool: MySqlPool,
    database: String,
    snapshot: SchemaSnapshot,
    read_only: bool,
}
#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
    execution: Mutex<Option<(String, oneshot::Sender<()>)>>,
}

#[tauri::command]
async fn connect_database(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> Result<SchemaSnapshot, String> {
    let mut session = state.session.lock().await;
    let pool = database::mysql::connect(&config).await?;
    let snapshot = match database::mysql::schema(&pool, &config.database).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            pool.close().await;
            return Err(error);
        }
    };
    let old = session.replace(Session {
        pool,
        database: config.database,
        snapshot: snapshot.clone(),
        read_only: config.read_only,
    });
    if let Some(old) = old {
        old.pool.close().await;
    }
    Ok(snapshot)
}

#[tauri::command]
async fn refresh_schema(state: State<'_, AppState>) -> Result<SchemaSnapshot, String> {
    let mut guard = state.session.lock().await;
    let session = guard.as_mut().ok_or("データベースに接続してください。")?;
    let snapshot = database::mysql::schema(&session.pool, &session.database).await?;
    session.snapshot = snapshot.clone();
    Ok(snapshot)
}

#[tauri::command]
async fn preview_table(table_id: String, state: State<'_, AppState>) -> Result<Preview, String> {
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or("データベースに接続してください。")?;
    let table = session
        .snapshot
        .tables
        .iter()
        .find(|table| table.id == table_id)
        .ok_or("この接続に存在しないテーブルです。スキーマを更新してください。")?;
    database::mysql::preview(&session.pool, table).await
}

#[tauri::command]
async fn execute_query(
    sql: String,
    explain: bool,
    execution_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<QueryResult, String> {
    let (sender, receiver) = oneshot::channel();
    {
        let mut execution = state.execution.lock().await;
        if execution.is_some() {
            return Err("実行中のSQLが完了するまでお待ちください。".into());
        }
        *execution = Some((execution_id.unwrap_or_default(), sender));
    }
    let operation = async {
        let guard = state.session.lock().await;
        let session = guard.as_ref().ok_or("データベースに接続してください。")?;
        database::query::execute(&session.pool, &sql, session.read_only, explain).await
    };
    // Dropping the pending query also drops its detached connection and reader.
    let result = cancellable(operation, receiver).await;
    *state.execution.lock().await = None;
    result
}

async fn cancellable<T>(
    operation: impl std::future::Future<Output = Result<T, String>>,
    receiver: oneshot::Receiver<()>,
) -> Result<T, String> {
    match futures_util::future::select(Box::pin(operation), receiver).await {
        futures_util::future::Either::Left((result, _)) => result,
        futures_util::future::Either::Right(_) => Err(
            "実行を中断しました。更新SQLの場合は反映状況を確認してから再実行してください。".into(),
        ),
    }
}

#[tauri::command]
async fn cancel_query(execution_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut execution = state.execution.lock().await;
    if execution.as_ref().is_none_or(|(id, _)| id != &execution_id) {
        return Err("対象の実行を確認できません。まだ実行中なら中断を再度お試しください。".into());
    }
    cancel_matching(&mut execution, &execution_id);
    Ok(())
}

fn cancel_matching(execution: &mut Option<(String, oneshot::Sender<()>)>, execution_id: &str) {
    if execution.as_ref().is_some_and(|(id, _)| id == execution_id) {
        // Keep the slot occupied until execute_query has released the query resources.
        let (unused, _) = oneshot::channel();
        if let Some((_, sender)) = execution.as_mut() {
            let _ = std::mem::replace(sender, unused).send(());
        }
    }
}

#[tauri::command]
async fn disconnect_database(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(session) = state.session.lock().await.take() {
        session.pool.close().await;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(csv_export::CsvExportState::default())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_database,
            refresh_schema,
            preview_table,
            execute_query,
            cancel_query,
            csv_export::begin_csv_export,
            csv_export::write_csv_export,
            csv_export::finish_csv_export,
            csv_export::abort_csv_export,
            disconnect_database
        ])
        .run(tauri::generate_context!())
        .expect("RelaGrid could not start");
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn stale_cancel_does_not_interrupt_current_execution() {
        let (sender, mut receiver) = oneshot::channel();
        let mut execution = Some(("current".into(), sender));
        cancel_matching(&mut execution, "old");
        assert_eq!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        );
        cancel_matching(&mut execution, "current");
        assert_eq!(receiver.try_recv(), Ok(()));
        assert!(execution.is_some());
    }

    #[test]
    fn cancellation_releases_pending_operation_before_returning() {
        struct Resource(Arc<AtomicBool>);
        impl Drop for Resource {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let released = Arc::new(AtomicBool::new(false));
            let resource = Resource(released.clone());
            let (sender, receiver) = oneshot::channel();
            let operation = async move {
                let _resource = resource;
                sender.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            };
            assert!(cancellable(operation, receiver)
                .await
                .unwrap_err()
                .contains("中断"));
            assert!(released.load(Ordering::SeqCst));
            let (_sender, receiver) = oneshot::channel();
            assert_eq!(cancellable(async { Ok(42) }, receiver).await, Ok(42));
        });
    }
}
