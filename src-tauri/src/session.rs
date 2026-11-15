//! 会话持久化：token + 用户资料存到应用数据目录。
//!
//! token 仍以 JSON 保存（不引入系统钥匙串依赖），依靠应用数据目录的系统隔离：
//! Windows 的 %APPDATA% 仅本人可访问，Android/iOS 为应用沙盒；Unix 系平台另外把文件
//! 限定为 0600，避免默认 umask 下同机其他用户可读。

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    // 旧版本没有 origin：不能推断其 token 属于哪个镜像，升级后必须重新登录。
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub user: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_are_bound_to_origin() {
        let store = SessionStore::new();
        store.set(
            "https://huangguoai.com",
            "secret-token".into(),
            json!({"id": 1}),
        );
        assert_eq!(
            store.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(store.token("https://huangguoai.ai"), None);
        assert_eq!(store.token("https://evil.example"), None);
        assert!(store.user("https://evil.example").is_null());
        store.clear();
        assert_eq!(store.token("https://huangguoai.com"), None);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "hghub-session-{tag}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn session_file_round_trips_through_atomic_replace() {
        let dir = temp_dir("roundtrip");
        let store = SessionStore::new();
        store.bind(dir.clone());
        store.set("https://huangguoai.com", "secret-token".into(), json!({"id": 7}));
        let reloaded = SessionStore::new();
        reloaded.bind(dir.clone());
        assert_eq!(
            reloaded.token("https://huangguoai.com").as_deref(),
            Some("secret-token")
        );
        assert_eq!(reloaded.user("https://huangguoai.com")["id"], 7);
        store.clear();
        let cleared = SessionStore::new();
        cleared.bind(dir.clone());
        assert_eq!(cleared.token("https://huangguoai.com"), None);
        assert!(!dir.join("session.json.tmp").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn session_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let path = dir.join("session.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let store = SessionStore::new();
        store.bind(dir.clone());
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600, "existing file is tightened at startup");
        store.set("https://huangguoai.com", "secret-token".into(), json!(null));
        assert_eq!(mode(&path), 0o600, "rewritten file stays owner-only");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_sessions_are_not_assigned_to_current_line() {
        let store = SessionStore::new();
        *store.current.lock().unwrap() =
            serde_json::from_str(r#"{"token":"legacy","user":{"id":1}}"#).unwrap();
        assert_eq!(store.token("https://huangguoai.com"), None);
        assert!(store.user("https://huangguoai.com").is_null());
    }
}

pub struct SessionStore {
    pub file: Mutex<Option<PathBuf>>,
    pub current: Mutex<Session>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            file: Mutex::new(None),
            current: Mutex::new(Session::default()),
        }
    }

    pub fn bind(&self, dir: PathBuf) {
        let mut path = dir;
        path.push("session.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            // 旧版本按默认权限写入（Linux 上通常 0644）；启动时收紧，无需重新登录。
            restrict_to_owner(&path);
            if let Ok(sess) = serde_json::from_str::<Session>(&text) {
                *self.current.lock().unwrap() = sess;
            }
        }
        *self.file.lock().unwrap() = Some(path);
    }

    pub fn token(&self, origin: &str) -> Option<String> {
        let cur = self.current.lock().unwrap();
        (cur.origin == origin && !cur.token.is_empty()).then(|| cur.token.clone())
    }

    pub fn user(&self, origin: &str) -> serde_json::Value {
        let cur = self.current.lock().unwrap();
        if cur.origin == origin && !cur.token.is_empty() {
            cur.user.clone()
        } else {
            serde_json::Value::Null
        }
    }

    pub fn set(&self, origin: &str, token: String, user: serde_json::Value) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.origin = origin.to_string();
            cur.token = token;
            cur.user = user;
        }
        self.persist();
    }

    pub fn clear(&self) {
        {
            let mut cur = self.current.lock().unwrap();
            cur.token.clear();
            cur.origin.clear();
            cur.user = serde_json::Value::Null;
        }
        self.persist();
    }

    fn persist(&self) {
        // 先持有文件锁再取快照：并发的 set/clear 按顺序落盘，旧快照不会最后写入并在重启后复活。
        let file = self.file.lock().unwrap();
        let Some(path) = file.as_ref() else { return };
        let snapshot = self.current.lock().unwrap().clone();
        if let Ok(text) = serde_json::to_string_pretty(&snapshot) {
            let _ = write_private(path, text.as_bytes());
        }
    }
}

/// 先写同目录临时文件再替换：中途崩溃或断电不会留下半截 JSON。
/// 替换失败（例如文件被其他程序占用）时退回原来的直接写入。
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("json.tmp");
    let replaced = (|| -> std::io::Result<()> {
        let _ = std::fs::remove_file(&temp);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if replaced.is_err() {
        let _ = std::fs::remove_file(&temp);
        std::fs::write(path, bytes)?;
        restrict_to_owner(path);
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) {}
