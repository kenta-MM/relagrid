use futures_util::TryStreamExt;
use sqlx::Row;
use std::{
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;
use tokio::sync::{oneshot, Mutex};

const MAX_CHUNK: usize = 64 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct ExportFile {
    id: String,
    target: PathBuf,
    file: NamedTempFile,
    cancellation: Option<oneshot::Receiver<()>>,
}
impl ExportFile {
    fn new(target: PathBuf) -> Result<Self, String> {
        let parent = target.parent().ok_or("保存先が不正です")?;
        let file = tempfile::Builder::new()
            .prefix(".relagrid-export-")
            .suffix(".partial")
            .tempfile_in(parent)
            .map_err(|e| format!("一時ファイルを作成できません: {e}"))?;
        Ok(Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string(),
            target,
            file,
            cancellation: None,
        })
    }
    fn write(&mut self, text: &str) -> Result<(), String> {
        if text.len() > MAX_CHUNK {
            return Err("書き込み単位の上限を超えています".into());
        }
        self.file
            .write_all(text.as_bytes())
            .map_err(|e| format!("書き込みに失敗しました: {e}"))
    }
    fn finish(self) -> Result<(), String> {
        if let Err(error) = self.file.as_file().sync_all() {
            return Err(remove_after_failure(
                self.file,
                format!("保存内容を確定できません: {error}"),
            ));
        }
        if let Err(error) = self.file.persist(&self.target) {
            return Err(remove_after_failure(
                error.file,
                format!("完成ファイルを確定できません: {}", error.error),
            ));
        }
        Ok(())
    }
}

fn remove_after_failure(file: NamedTempFile, error: String) -> String {
    match file.close() {
        Ok(()) => error,
        Err(cleanup) => format!("{error}。一時ファイルの削除にも失敗しました: {cleanup}"),
    }
}

#[derive(Default)]
pub struct CsvExportState(
    Mutex<Option<ExportFile>>,
    Mutex<Option<(String, oneshot::Sender<()>)>>,
);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    rows: u64,
}

async fn stream_table(
    pool: &sqlx::MySqlPool,
    table: &crate::models::Table,
    file: &mut ExportFile,
    progress: &Channel<ExportProgress>,
) -> Result<u64, String> {
    use crate::database::mysql_sql::{export_cell_limit, export_query};
    if table.columns.is_empty() || table.columns.len() > 512 {
        return Err("全件出力は1〜512列のテーブルに対応しています".into());
    }
    let mut connection = pool.acquire().await.map_err(|e| e.to_string())?.detach();
    sqlx::query("SET SESSION TRANSACTION READ ONLY")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("SET SESSION time_zone = '+00:00'")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("SET SESSION MAX_EXECUTION_TIME=600000")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    file.file
        .write_all(b"\xEF\xBB\xBF")
        .map_err(|e| e.to_string())?;
    let mut writer = csv::WriterBuilder::new()
        .quote_style(csv::QuoteStyle::Always)
        .terminator(csv::Terminator::CRLF)
        .from_writer(file.file.as_file_mut());
    writer
        .write_record(table.columns.iter().map(|c| protect_cell(&c.name)))
        .map_err(|e| e.to_string())?;
    let sql = export_query(table);
    let mut stream = sqlx::query(&sql).fetch(&mut connection);
    let mut count = 0;
    let mut last_progress = std::time::Instant::now();
    while let Some(row) = stream
        .try_next()
        .await
        .map_err(|e| format!("全件取得に失敗しました: {e}"))?
    {
        let mut values = Vec::with_capacity(table.columns.len());
        let mut bytes = 0;
        for index in 0..table.columns.len() {
            let value: Option<Vec<u8>> = row.try_get(index).map_err(|_| {
                format!("レコード{}・列{}の取得に失敗しました", count + 2, index + 1)
            })?;
            let value = value.unwrap_or_default();
            bytes += value.len();
            if value.len() > export_cell_limit(table) || bytes > 8 * 1024 * 1024 {
                return Err(format!(
                    "レコード{}・列{}で値上限{}バイトを超えました。出力は確定しません",
                    count + 2,
                    index + 1,
                    export_cell_limit(table)
                ));
            }
            let value = String::from_utf8(value)
                .map_err(|_| format!("レコード{}・列{}のUTF-8が不正です", count + 2, index + 1))?;
            values.push(protect_cell(&value));
        }
        writer
            .write_record(values)
            .map_err(|e| format!("書き込みに失敗しました: {e}"))?;
        count += 1;
        if count % 100 == 0 {
            if last_progress.elapsed() >= std::time::Duration::from_millis(250) {
                writer.flush().map_err(|e| e.to_string())?;
                progress
                    .send(ExportProgress { rows: count })
                    .map_err(|_| "画面との通信が終了しました")?;
                last_progress = std::time::Instant::now();
            }
            tokio::task::yield_now().await;
        }
    }
    writer.flush().map_err(|e| e.to_string())?;
    progress
        .send(ExportProgress { rows: count })
        .map_err(|_| "画面との通信が終了しました")?;
    Ok(count)
}

fn protect_cell(value: &str) -> String {
    if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

#[tauri::command]
pub(crate) async fn export_table_csv(
    state: State<'_, CsvExportState>,
    database: State<'_, crate::AppState>,
    id: String,
    table_id: String,
    progress: Channel<ExportProgress>,
) -> Result<u64, String> {
    let mut active = state.0.lock().await;
    let file = active
        .as_mut()
        .filter(|file| file.id == id)
        .ok_or("出力は終了しています")?;
    let receiver = file.cancellation.take().ok_or("出力は開始済みです")?;
    let operation = async {
        // Keep the source connection fixed until the reader has been released.
        let guard = database.session.lock().await;
        let session = guard.as_ref().ok_or("データベースに接続してください")?;
        let table = session
            .snapshot
            .tables
            .iter()
            .find(|t| t.id == table_id)
            .ok_or("テーブルが見つかりません。スキーマを更新してください")?;
        stream_table(&session.pool, table, file, &progress).await
    };
    let bounded = async {
        tokio::time::timeout(std::time::Duration::from_secs(600), operation)
            .await
            .map_err(|_| "全件出力が10分の上限に達しました")?
    };
    let result = table_cancellable(bounded, receiver).await;
    state.1.lock().await.take();
    let file = active.take().unwrap();
    match result {
        Ok(count) => {
            file.finish()?;
            Ok(count)
        }
        Err(error) => Err(remove_after_failure(file.file, error)),
    }
}

async fn table_cancellable<T>(
    operation: impl std::future::Future<Output = Result<T, String>>,
    mut receiver: oneshot::Receiver<()>,
) -> Result<T, String> {
    const CANCELLED: &str = "全件出力を中断しました。完成ファイルは変更していません";
    if receiver.try_recv() != Err(oneshot::error::TryRecvError::Empty) {
        return Err(CANCELLED.into());
    }
    match futures_util::future::select(Box::pin(operation), receiver).await {
        futures_util::future::Either::Left((result, mut receiver)) => {
            if receiver.try_recv() == Ok(()) {
                Err(CANCELLED.into())
            } else {
                result
            }
        }
        futures_util::future::Either::Right(_) => Err(CANCELLED.into()),
    }
}

#[tauri::command]
pub async fn begin_csv_export(
    app: AppHandle,
    state: State<'_, CsvExportState>,
    name: String,
) -> Result<Option<String>, String> {
    let mut active = state.0.lock().await;
    if active.is_some() {
        return Err("別のCSV出力が進行中です".into());
    }
    // Native dialogs must not block the UI thread. The path never comes from IPC.
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("CSVの保存先")
            .set_file_name(name)
            .add_filter("CSV", &["csv"])
            .blocking_save_file()
    })
    .await
    .map_err(|_| "保存ダイアログを開けませんでした")?;
    let Some(path) = path else {
        return Ok(None);
    };
    let mut file = ExportFile::new(path.into_path().map_err(|_| "保存先が不正です")?)?;
    let id = file.id.clone();
    let (sender, receiver) = oneshot::channel();
    file.cancellation = Some(receiver);
    *state.1.lock().await = Some((id.clone(), sender));
    *active = Some(file);
    Ok(Some(id))
}

#[tauri::command]
pub async fn write_csv_export(
    state: State<'_, CsvExportState>,
    id: String,
    text: String,
) -> Result<(), String> {
    let mut active = state.0.lock().await;
    let file = active
        .as_mut()
        .filter(|file| file.id == id)
        .ok_or("出力は終了しています")?;
    // A failed write invalidates the session, so it cannot later be committed.
    if let Err(error) = file.write(&text) {
        return Err(remove_after_failure(active.take().unwrap().file, error));
    }
    Ok(())
}

#[tauri::command]
pub async fn finish_csv_export(state: State<'_, CsvExportState>, id: String) -> Result<(), String> {
    let mut active = state.0.lock().await;
    if active.as_ref().is_none_or(|file| file.id != id) {
        return Err("出力は終了しています".into());
    }
    state.1.lock().await.take();
    active.take().unwrap().finish()
}

#[tauri::command]
pub async fn abort_csv_export(state: State<'_, CsvExportState>, id: String) -> Result<(), String> {
    {
        let mut running = state.1.lock().await;
        if running.as_ref().is_some_and(|(current, _)| current == &id) {
            if let Some((_, sender)) = running.take() {
                let _ = sender.send(());
            }
        }
    }
    let mut active = state.0.lock().await;
    if active.as_ref().is_some_and(|file| file.id == id) {
        active
            .take()
            .unwrap()
            .file
            .close()
            .map_err(|e| format!("一時ファイルを削除できません: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn table_cancel_prevents_start_and_completion() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (sender, receiver) = oneshot::channel();
            sender.send(()).unwrap();
            let result = table_cancellable(
                async {
                    panic!("must not start");
                    #[allow(unreachable_code)]
                    Ok::<(), String>(())
                },
                receiver,
            )
            .await;
            assert!(result.unwrap_err().contains("中断"));
            let (sender, receiver) = oneshot::channel();
            let result = table_cancellable(
                async {
                    sender.send(()).unwrap();
                    Ok(42)
                },
                receiver,
            )
            .await;
            assert!(result.unwrap_err().contains("中断"));
        });
    }

    #[test]
    #[ignore = "Requires isolated MySQL fixture on 127.0.0.1:3307"]
    fn mysql_fixture_full_table_export() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let config = crate::models::ConnectionConfig { host: "127.0.0.1".into(), port: 3307, username: "root".into(), password: String::new(), database: "relagrid_fixture".into(), read_only: false };
            let pool = crate::database::mysql::connect(&config).await.unwrap();
            sqlx::query("CREATE TABLE CsvExportFixture (id BIGINT UNSIGNED PRIMARY KEY, text_value LONGTEXT, amount DECIMAL(40,12), payload BLOB, nullable_value TEXT, moment TIMESTAMP(6))").execute(&pool).await.unwrap();
            for index in 0..1205u64 {
                sqlx::query("INSERT INTO CsvExportFixture VALUES (?, ?, 12345678901234567890.123456789012, X'00FF', NULL, FROM_UNIXTIME(1767225600.123456))")
                    .bind(index).bind(if index == 0 { format!("日本語😀,\"quoted\"\r\n{}", "a".repeat(6000)) } else { format!("row-{index}") }).execute(&pool).await.unwrap();
            }
            let snapshot = crate::database::mysql::schema(&pool, &config.database).await.unwrap();
            let table = snapshot.tables.iter().find(|t| t.name.eq_ignore_ascii_case("CsvExportFixture")).unwrap();
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("all.csv");
            let mut file = ExportFile::new(path.clone()).unwrap();
            let channel = Channel::new(|_| Ok(()));
            assert_eq!(stream_table(&pool, table, &mut file, &channel).await.unwrap(), 1205);
            file.finish().unwrap();
            let mut reader = csv::Reader::from_path(&path).unwrap();
            assert_eq!(reader.headers().unwrap().get(0), Some("id"));
            let rows: Vec<_> = reader.records().map(Result::unwrap).collect();
            assert_eq!(rows.len(), 1205);
            let first = rows.iter().find(|r| r.get(0) == Some("0")).unwrap();
            assert!(first[1].contains("日本語😀,\"quoted\"\r\n"));
            assert!(first[1].len() > 6000);
            assert_eq!(&first[2], "12345678901234567890.123456789012");
            assert_eq!(&first[3], "00FF");
            assert_eq!(&first[4], "");
            assert_eq!(&first[5], "2026-01-01 00:00:00.123456");
            sqlx::query("UPDATE CsvExportFixture SET text_value=REPEAT('x',1048577) WHERE id=0").execute(&pool).await.unwrap();
            let mut failed = ExportFile::new(path.clone()).unwrap();
            assert!(stream_table(&pool, table, &mut failed, &channel).await.unwrap_err().contains("上限"));
            drop(failed);
            assert_eq!(csv::Reader::from_path(&path).unwrap().records().count(), 1205);
            sqlx::query("DROP TABLE CsvExportFixture").execute(&pool).await.unwrap();
            pool.close().await;
        });
    }
    #[test]
    fn only_finished_export_replaces_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.csv");
        std::fs::write(&path, "old").unwrap();
        let mut file = ExportFile::new(path.clone()).unwrap();
        let partial = file.file.path().to_owned();
        file.write("\u{feff}\"日本語😀\"\r\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        drop(file);
        assert!(!partial.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        let mut file = ExportFile::new(path.clone()).unwrap();
        file.write("complete").unwrap();
        file.finish().unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "complete");
    }
    #[test]
    fn oversized_chunk_and_failed_commit_leave_no_completed_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.csv");
        let mut file = ExportFile::new(path.clone()).unwrap();
        assert!(file.write(&"x".repeat(MAX_CHUNK + 1)).is_err());
        let partial = file.file.path().to_owned();
        std::fs::create_dir(&path).unwrap();
        assert!(file.finish().is_err());
        assert!(!partial.exists());
        assert!(path.is_dir());
    }
}
