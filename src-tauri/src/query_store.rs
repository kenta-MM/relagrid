use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path, sync::Mutex};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    id: u32,
    name: String,
    sql: String,
    connection_id: u32,
    connection_label: String,
    read_only: bool,
}

#[derive(Default)]
pub struct QueryStoreState(Mutex<bool>);

fn validate(data: &[SavedQuery]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if data
        .iter()
        .any(|query| query.id == 0 || !ids.insert(query.id))
    {
        return Err("保存クエリのIDが不正です。".into());
    }
    Ok(())
}

fn read(path: &Path) -> Result<Vec<SavedQuery>, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let data: Vec<SavedQuery> = serde_json::from_slice(&bytes)
                .map_err(|_| "保存クエリの形式が不正です。元のファイルは保持されます。")?;
            validate(&data)?;
            Ok(data)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(error) => Err(format!("保存クエリを読み込めません: {error}")),
    }
}

fn write(path: &Path, data: &[SavedQuery]) -> Result<(), String> {
    read(path)?;
    validate(data)?;
    let parent = path.parent().ok_or("クエリの保存先が不正です。")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_queries(
    app: tauri::AppHandle,
    state: tauri::State<'_, QueryStoreState>,
) -> Result<Vec<SavedQuery>, String> {
    let mut ready = state
        .0
        .lock()
        .map_err(|_| "クエリの保存処理が使用中です。")?;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("queries.json");
    let result = read(&path);
    *ready = result.is_ok();
    result
}

#[tauri::command]
pub fn save_queries(
    app: tauri::AppHandle,
    state: tauri::State<'_, QueryStoreState>,
    data: Vec<SavedQuery>,
) -> Result<(), String> {
    let ready = state
        .0
        .lock()
        .map_err(|_| "クエリの保存処理が使用中です。")?;
    if !*ready {
        return Err("保存クエリの読み込みが完了していないため保存できません。".into());
    }
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("queries.json");
    write(&path, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_failed_write_preserves_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queries.json");
        assert!(read(&path).unwrap().is_empty());
        let data = vec![SavedQuery {
            id: 1,
            name: "Query 1".into(),
            sql: "SELECT '日本語';\nSELECT 2;".into(),
            connection_id: 3,
            connection_label: "DB A".into(),
            read_only: true,
        }];
        write(&path, &data).unwrap();
        let restored = read(&path).unwrap();
        assert_eq!(restored[0].sql, data[0].sql);
        assert_eq!(restored[0].connection_id, 3);
        assert!(write(&path, &[data[0].clone(), data[0].clone()]).is_err());
        assert_eq!(read(&path).unwrap().len(), 1);
        std::fs::write(&path, "broken").unwrap();
        assert!(write(&path, &data).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
    }
}
