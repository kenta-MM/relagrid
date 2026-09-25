use std::{
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;
use tokio::sync::Mutex;

const MAX_CHUNK: usize = 64 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct ExportFile {
    id: String,
    target: PathBuf,
    file: NamedTempFile,
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
pub struct CsvExportState(Mutex<Option<ExportFile>>);

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
    let file = ExportFile::new(path.into_path().map_err(|_| "保存先が不正です")?)?;
    let id = file.id.clone();
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
    active.take().unwrap().finish()
}

#[tauri::command]
pub async fn abort_csv_export(state: State<'_, CsvExportState>, id: String) -> Result<(), String> {
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
