//! Shared UTC timestamps and the always-on debug journal.
use std::borrow::Cow;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};

static DEBUG_WRITER: Mutex<()> = Mutex::new(());
/// debug.log 超过上限时轮转为 debug.previous.log，只保留两份（合计约 2 MiB），与 playback.log 一致。
const DEBUG_MAX_FILE: u64 = 1024 * 1024;
/// 单条消息的字符上限；堆栈、网关错误页通常远小于此，异常长的输入截断后再落盘。
const DEBUG_MAX_MESSAGE: usize = 8 * 1024;

fn format_utc(at: OffsetDateTime) -> Result<String, String> {
    at.to_offset(UtcOffset::UTC)
        .format(&Rfc3339)
        .map_err(|_| "日志时间格式错误".to_string())
}

pub(crate) fn utc_timestamp() -> Result<String, String> {
    format_utc(OffsetDateTime::now_utc())
}

pub(crate) fn append_debug(dir: &Path, message: &str) -> Result<(), String> {
    append_debug_limited(dir, message, DEBUG_MAX_FILE)
}

fn append_debug_limited(dir: &Path, message: &str, limit: u64) -> Result<(), String> {
    let _writer = DEBUG_WRITER.lock().map_err(|_| "日志锁失败")?;
    fs::create_dir_all(dir).map_err(|_| "无法创建日志目录")?;
    let at = utc_timestamp()?;
    let prefix = format!("[{at}] [pid={}] ", std::process::id());
    let message = match message.char_indices().nth(DEBUG_MAX_MESSAGE) {
        Some((cut, _)) => Cow::Owned(format!("{}…[已截断]", &message[..cut])),
        None => Cow::Borrowed(message),
    };
    let mut record = String::new();
    // Stamp continuation lines too, including stack traces, HTML errors and pretty JSON.
    for line in message.lines() {
        record.push_str(&prefix);
        record.push_str(line);
        record.push('\n');
    }
    if record.is_empty() {
        record.push_str(&prefix);
        record.push('\n');
    }
    let path = dir.join("debug.log");
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size + record.len() as u64 > limit {
        // 轮转失败时继续追加：宁可暂时超限，也不丢弃这条记录。
        let previous = dir.join("debug.previous.log");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&path, &previous);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| f.write_all(record.as_bytes()))
        .map_err(|_| "无法写入调试日志".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn test_dir() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hghub-debug-log-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn timestamps_are_utc_even_when_input_has_another_offset() {
        let instant = OffsetDateTime::from_unix_timestamp(0)
            .unwrap()
            .replace_nanosecond(123_456_789)
            .unwrap();
        for offset in [
            UtcOffset::UTC,
            UtcOffset::from_hms(8, 0, 0).unwrap(),
            UtcOffset::from_hms(-7, 0, 0).unwrap(),
        ] {
            assert_eq!(
                format_utc(instant.to_offset(offset)).unwrap(),
                "1970-01-01T00:00:00.123456789Z"
            );
        }
    }

    #[test]
    fn debug_errors_and_continuation_lines_have_utc_and_preserve_history() {
        let dir = test_dir();
        let path = dir.join("debug.log");
        fs::write(&path, "legacy entry without timestamp\n").unwrap();
        append_debug(&dir, "[api] api_feed → HTTP 503\r\n<html>\r\nerror\n").unwrap();
        append_debug(&dir, "[reject] failure\n    at handler").unwrap();
        append_debug(&dir, "").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "legacy entry without timestamp");
        assert_eq!(lines.len(), 7);
        for line in &lines[1..] {
            let (at, rest) = line.strip_prefix('[').unwrap().split_once("] ").unwrap();
            assert!(at.ends_with('Z'));
            assert!(at.contains('T'));
            assert!(rest.starts_with(&format!("[pid={}] ", std::process::id())));
            assert!(!line.contains('\r'));
        }
        assert!(lines[1].ends_with("[api] api_feed → HTTP 503"));
        assert!(lines[5].ends_with("    at handler"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_multiline_records_remain_together() {
        let dir = test_dir();
        let writers: Vec<_> = (0..4)
            .map(|worker| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for entry in 0..8 {
                        append_debug(
                            &dir,
                            &format!("start {worker}/{entry}\nend {worker}/{entry}"),
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let text = fs::read_to_string(dir.join("debug.log")).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 64);
        for pair in lines.chunks_exact(2) {
            assert_eq!(pair[1], pair[0].replace("start ", "end "));
            assert!(pair[0].contains("Z] [pid="));
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn debug_log_rotates_into_two_bounded_files() {
        let dir = test_dir();
        let line = "[api] api_video → HTTP 503 Service Unavailable: <html><h1>nginx error</h1></html>";
        let mut written = 0u64;
        for i in 0..2_000 {
            let message = format!("{line} #{i}");
            append_debug_limited(&dir, &message, 64 * 1024).unwrap();
            written += message.len() as u64;
        }
        let current = fs::metadata(dir.join("debug.log")).unwrap().len();
        let previous = fs::metadata(dir.join("debug.previous.log")).unwrap().len();
        println!("debug.log growth: {written} message bytes written -> debug.log {current} + previous {previous} bytes on disk (limit 65536 each)");
        assert!(current <= 64 * 1024 && previous <= 64 * 1024);
        let text = fs::read_to_string(dir.join("debug.log")).unwrap();
        assert!(text.lines().last().unwrap().ends_with("#1999"));
        assert!(text.lines().all(|l| l.contains("Z] [pid=")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn oversized_debug_messages_are_truncated_on_a_char_boundary() {
        let dir = test_dir();
        let message = "错".repeat(DEBUG_MAX_MESSAGE + 500);
        append_debug(&dir, &message).unwrap();
        let text = fs::read_to_string(dir.join("debug.log")).unwrap();
        assert!(text.trim_end().ends_with("…[已截断]"));
        assert_eq!(text.matches('错').count(), DEBUG_MAX_MESSAGE);
        fs::remove_dir_all(dir).unwrap();
    }
}
