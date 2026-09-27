use crate::models::ConnectionConfig;
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path, sync::Mutex};
use tauri::Manager;
use zeroize::Zeroizing;

const FORMAT: &str = "relagrid-connections-v1-aes256gcm-dpapi";
const INVALID: &str = "接続設定を復号できません。ファイルの破損、またはWindowsユーザーが異なる可能性があります。元のファイルは保持されます。";

#[derive(Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    id: u32,
    group: Option<String>,
    config: ConnectionConfig,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Connections {
    connections: Vec<SavedConnection>,
    groups: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: String,
    protected_key: String,
    data: Connections,
}

#[derive(Default)]
pub struct StoreState(Mutex<bool>);

fn validate(data: &Connections) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for entry in &data.connections {
        if entry.id == 0
            || !ids.insert(entry.id)
            || entry.config.port == 0
            || entry.config.host.trim().is_empty()
            || entry.config.database.trim().is_empty()
            || entry.config.username.trim().is_empty()
        {
            return Err("接続設定の形式が不正です。".into());
        }
    }
    Ok(())
}

// Bind each password to its connection metadata to reject ciphertext swapping.
fn aad(entry: &SavedConnection) -> Vec<u8> {
    serde_json::to_vec(&(
        FORMAT,
        entry.id,
        &entry.group,
        &entry.config.host,
        entry.config.port,
        &entry.config.username,
        &entry.config.database,
        entry.config.read_only,
    ))
    .expect("serializable metadata")
}

fn seal(data: &Connections) -> Result<Vec<u8>, String> {
    validate(data)?;
    let key = Zeroizing::new(Aes256Gcm::generate_key(OsRng).to_vec());
    let protected_key = STANDARD.encode(os_protect(&key, false)?);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| INVALID)?;
    let mut data = data.clone();
    for entry in &mut data.connections {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: entry.config.password.as_bytes(),
                    aad: &aad(entry),
                },
            )
            .map_err(|_| "パスワードを暗号化できませんでした。")?;
        let mut bytes = nonce.to_vec();
        bytes.extend(ciphertext);
        entry.config.password = STANDARD.encode(bytes);
    }
    serde_json::to_vec_pretty(&Envelope {
        format: FORMAT.into(),
        protected_key,
        data,
    })
    .map_err(|_| "接続設定をJSONに変換できませんでした。".into())
}

fn unseal(bytes: &[u8]) -> Result<Connections, String> {
    let mut envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    if envelope.format != FORMAT {
        return Err(INVALID.into());
    }
    let protected = STANDARD
        .decode(&envelope.protected_key)
        .map_err(|_| INVALID)?;
    let key = Zeroizing::new(os_protect(&protected, true)?);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| INVALID)?;
    validate(&envelope.data)?;
    for entry in &mut envelope.data.connections {
        let bytes = STANDARD
            .decode(&entry.config.password)
            .map_err(|_| INVALID)?;
        if bytes.len() < 12 + 16 {
            return Err(INVALID.into());
        }
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&bytes[..12]),
                Payload {
                    msg: &bytes[12..],
                    aad: &aad(entry),
                },
            )
            .map_err(|_| INVALID)?;
        entry.config.password = String::from_utf8(plaintext).map_err(|_| INVALID)?;
    }
    Ok(envelope.data)
}

#[cfg(windows)]
fn os_protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| INVALID)?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI allocates output; inputs stay alive throughout the call. No machine-wide flag:
    // only the current Windows user's DPAPI credentials can unwrap this AES key.
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows DPAPIによる鍵の保護・復元に失敗しました。".into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        if decrypt {
            use zeroize::Zeroize;
            std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
        }
        LocalFree(output.pbData as _);
        Ok(result)
    }
}

#[cfg(not(windows))]
fn os_protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("接続設定の安全な保存はWindows版で利用できます。".into())
}

fn read(path: &Path) -> Result<Connections, String> {
    match std::fs::read(path) {
        Ok(bytes) => unseal(&bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Connections::default()),
        Err(_) => Err("接続設定ファイルを読み込めませんでした。".into()),
    }
}

fn write(path: &Path, data: &Connections) -> Result<(), String> {
    // Never replace unreadable/corrupt settings, even if they changed since startup.
    read(path)?;
    let bytes = seal(data)?;
    let parent = path.parent().ok_or("接続設定の保存先が不正です。")?;
    std::fs::create_dir_all(parent).map_err(|_| "接続設定フォルダーを作成できません。")?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "接続設定を保存できません。")?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "接続設定を書き込めませんでした。")?;
    file.persist(path)
        .map_err(|_| "接続設定ファイルを置き換えられませんでした。")?;
    Ok(())
}

#[tauri::command]
pub fn load_connections(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
) -> Result<Connections, String> {
    let mut ready = state.0.lock().map_err(|_| "接続設定が使用中です。")?;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "設定フォルダーを取得できません。")?
        .join("connections.json");
    let result = read(&path);
    *ready = result.is_ok();
    result
}

#[tauri::command]
pub fn save_connections(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
    data: Connections,
) -> Result<(), String> {
    let ready = state.0.lock().map_err(|_| "接続設定が使用中です。")?;
    if !*ready {
        return Err("接続設定の読み込みが完了していないため保存できません。".into());
    }
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "設定フォルダーを取得できません。")?
        .join("connections.json");
    write(&path, &data)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    fn sample() -> Connections {
        Connections {
            groups: vec!["開発".into()],
            connections: vec![SavedConnection {
                id: 1,
                group: Some("開発".into()),
                config: ConnectionConfig {
                    host: "localhost".into(),
                    port: 3306,
                    username: "reader".into(),
                    password: "secret-日本語".into(),
                    database: "app".into(),
                    read_only: true,
                },
            }],
        }
    }
    #[test]
    fn dpapi_aes_round_trip_and_fresh_nonces() {
        let data = sample();
        let first = seal(&data).unwrap();
        assert!(!String::from_utf8_lossy(&first).contains("secret"));
        assert_ne!(first, seal(&data).unwrap());
        assert_eq!(
            unseal(&first).unwrap().connections[0].config.password,
            "secret-日本語"
        );
        let mut empty = sample();
        empty.connections[0].config.password.clear();
        assert_eq!(
            unseal(&seal(&empty).unwrap()).unwrap().connections[0]
                .config
                .password,
            ""
        );
    }
    #[test]
    fn rejects_tampering_and_wrong_key() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&seal(&sample()).unwrap()).unwrap();
        value["data"]["connections"][0]["config"]["host"] = "elsewhere".into();
        assert!(unseal(&serde_json::to_vec(&value).unwrap()).is_err());
        value["data"]["connections"][0]["config"]["host"] = "localhost".into();
        let other: serde_json::Value = serde_json::from_slice(&seal(&sample()).unwrap()).unwrap();
        value["protectedKey"] = other["protectedKey"].clone();
        assert!(unseal(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    #[test]
    fn rejects_invalid_nonce_ciphertext_and_version() {
        let bytes = seal(&sample()).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let encoded = original["data"]["connections"][0]["config"]["password"]
            .as_str()
            .unwrap();
        let mut damaged = STANDARD.decode(encoded).unwrap();
        *damaged.last_mut().unwrap() ^= 1;
        for password in [
            "not-base64".to_owned(),
            STANDARD.encode([0; 11]),
            STANDARD.encode(damaged),
        ] {
            let mut value = original.clone();
            value["data"]["connections"][0]["config"]["password"] = password.into();
            assert!(unseal(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let mut value = original;
        value["format"] = "unknown-version".into();
        assert!(unseal(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(unseal(&serde_json::to_vec(&sample()).unwrap()).is_err());
    }
    #[test]
    fn persists_reloads_and_preserves_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        assert!(read(&path).unwrap().connections.is_empty());
        write(&path, &sample()).unwrap();
        assert_eq!(
            read(&path).unwrap().connections[0].config.password,
            "secret-日本語"
        );
        let mut updated = sample();
        updated.connections[0].config.password = "new".into();
        write(&path, &updated).unwrap();
        assert_eq!(read(&path).unwrap().connections[0].config.password, "new");
        std::fs::write(&path, b"broken").unwrap();
        assert!(write(&path, &sample()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"broken");
    }
}
