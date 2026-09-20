mod database;
mod models;

use models::{ConnectionConfig, Preview, SchemaSnapshot};
use sqlx::MySqlPool;
use tauri::State;
use tokio::sync::Mutex;

struct Session {
    pool: MySqlPool,
    database: String,
    snapshot: SchemaSnapshot,
}
#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
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
async fn disconnect_database(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(session) = state.session.lock().await.take() {
        session.pool.close().await;
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_database,
            refresh_schema,
            preview_table,
            disconnect_database
        ])
        .run(tauri::generate_context!())
        .expect("RelaGrid could not start");
}
