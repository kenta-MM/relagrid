use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path, sync::Mutex};
use tauri::Manager;
use zeroize::Zeroizing;

const FORMAT: &str = "relagrid-queries-v1-dpapi";
const INVALID: &str = "保存クエリを復元できません。ファイルの破損またはWindowsユーザーの違いを確認してください。元のファイルは保持されます。";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    payload: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredQueries {
    Encrypted(Envelope),
    Legacy(Vec<SavedQuery>),
}

fn seal(data: &[SavedQuery]) -> Result<Vec<u8>, String> {
    validate(data)?;
    let plaintext = Zeroizing::new(serde_json::to_vec(data).map_err(|_| INVALID)?);
    let encrypted = crate::connection_store::os_protect(&plaintext, false).map_err(|_| INVALID)?;
    serde_json::to_vec_pretty(&Envelope {
        format: FORMAT.into(),
        payload: STANDARD.encode(encrypted),
    })
    .map_err(|_| INVALID.into())
}

fn unseal(envelope: Envelope) -> Result<Vec<SavedQuery>, String> {
    if envelope.format != FORMAT {
        return Err(INVALID.into());
    }
    let encrypted = STANDARD.decode(envelope.payload).map_err(|_| INVALID)?;
    let plaintext =
        Zeroizing::new(crate::connection_store::os_protect(&encrypted, true).map_err(|_| INVALID)?);
    let data: Vec<SavedQuery> = serde_json::from_slice(&plaintext).map_err(|_| INVALID)?;
    validate(&data)?;
    Ok(data)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    id: u32,
    name: String,
    sql: String,
    connection_id: u32,
    connection_label: String,
    read_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    database_kind: Option<crate::models::DatabaseKind>,
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
            let bytes = Zeroizing::new(bytes);
            match serde_json::from_slice::<StoredQueries>(&bytes).map_err(|_| INVALID)? {
                StoredQueries::Encrypted(envelope) => unseal(envelope),
                StoredQueries::Legacy(data) => {
                    // Do not expose a successful load until the plaintext file is replaced.
                    let encrypted = seal(&data)?;
                    persist(path, &encrypted)?;
                    Ok(data)
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(error) => Err(format!("保存クエリを読み込めません: {error}")),
    }
}

fn write(path: &Path, data: &[SavedQuery]) -> Result<(), String> {
    read(path)?;
    let bytes = seal(data)?;
    persist(path, &bytes)
}

fn persist(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("クエリの保存先が不正です。")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(bytes)
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn sample() -> Vec<SavedQuery> {
        vec![SavedQuery {
            id: 1,
            name: "Private query".into(),
            sql: "SELECT 'secret-日本語-token'".into(),
            connection_id: 8,
            connection_label: "private-host".into(),
            read_only: true,
            database_kind: None,
        }]
    }

    #[test]
    fn encrypts_all_fields_and_migrates_without_plaintext_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queries.json");
        let data = sample();
        std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        assert_eq!(read(&path).unwrap()[0].sql, data[0].sql);
        let bytes = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        for secret in ["secret-", "Private query", "private-host", "SELECT"] {
            assert!(!text.contains(secret));
        }
        assert!(text.contains(FORMAT));
        assert_eq!(read(&path).unwrap()[0].connection_id, 8);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        write(&path, &[]).unwrap();
        assert!(read(&path).unwrap().is_empty());
    }

    #[test]
    fn tampering_and_unknown_version_never_overwrite_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queries.json");
        for version in [FORMAT, "unknown"] {
            let mut envelope: Envelope = serde_json::from_slice(&seal(&sample()).unwrap()).unwrap();
            envelope.format = version.into();
            if version == FORMAT {
                let mut encrypted = STANDARD.decode(&envelope.payload).unwrap();
                let last = encrypted.len() - 1;
                encrypted[last] ^= 1;
                envelope.payload = STANDARD.encode(encrypted);
            }
            let corrupted = serde_json::to_vec(&envelope).unwrap();
            std::fs::write(&path, &corrupted).unwrap();
            assert!(read(&path).is_err());
            assert!(write(&path, &sample()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), corrupted);
        }
    }

    #[test]
    fn failed_migration_preserves_plaintext_and_removes_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queries.json");
        let original = serde_json::to_vec(&sample()).unwrap();
        std::fs::write(&path, &original).unwrap();
        // Permit reads but deny file replacement to simulate a failed migration.
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(read(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        drop(locked);
        assert!(read(&path).is_ok());
    }

    #[test]
    fn structurally_valid_but_invalid_ids_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queries.json");
        let query = SavedQuery {
            id: 0,
            name: "draft".into(),
            sql: "SELECT 1".into(),
            connection_id: 0,
            connection_label: "未接続".into(),
            read_only: true,
            database_kind: None,
        };
        let invalid = serde_json::to_vec(&vec![query]).unwrap();
        std::fs::write(&path, &invalid).unwrap();
        assert!(read(&path).is_err());
        assert!(write(&path, &[]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), invalid);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn database_kind_survives_encrypted_query_round_trip() {
        let mut data = sample();
        data[0].database_kind = Some(crate::models::DatabaseKind::SqlServer);
        let restored = unseal(serde_json::from_slice(&seal(&data).unwrap()).unwrap()).unwrap();
        assert_eq!(restored[0].database_kind, data[0].database_kind);
        let legacy = unseal(serde_json::from_slice(&seal(&sample()).unwrap()).unwrap()).unwrap();
        assert_eq!(legacy[0].database_kind, None);
    }

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
            database_kind: None,
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
