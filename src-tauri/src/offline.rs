//! 手动离线缓存：按集把 HLS 清单、分片和密钥下载到应用数据目录，播放时经 hg 协议从本地读取。
//!
//! - 队列一次只下载一个文件，按加入顺序逐集进行；前端在线播放时调用 [`set_paused`]，
//!   下载在两个文件之间停下等待，不和播放抢带宽，也不对上游形成突发请求。
//! - 网络中断（超时、连不上、5xx）不算失败：同一个文件隔几秒重试几次，仍不通就把这一集放回队列、
//!   保留已下载的文件，队列停下来等唤醒（回到应用、网络恢复或新的缓存操作，见 [`resume`]），不定时重试。
//! - 地址签名过期（401/403/404/410）就重新取地址接着下；只有连续几次刷新都没有新进度才算失败。
//! - 文件永久保留，只在用户删除时清理（卸载应用时随应用数据一起删除）。
//! - 目录：`<root>/<剧 id>/series.json`（剧集信息）、`cover`（封面）；
//!   `<root>/<剧 id>/<集>/meta.json`、`index.m3u8`（写入即表示完成）、`s<n>.ts` / `k<n>.key` / `m<n>.mp4`。
//!
//! 本模块不依赖 Tauri：取播放地址、下载字节、通知进度都由调用方注入（见 lib.rs）。

use crate::media::{absolutize, image_kind, map_uri_attributes, upstream_status};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// 一集的缓存状态，同时写在 meta.json 并作为进度事件发给前端。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Episode {
    pub vid: i64,
    pub ep: u32,
    /// 剧名（离线列表展示用）
    pub title: String,
    /// queued | downloading | done | error
    pub state: String,
    pub done: usize,
    pub total: usize,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 加入队列的先后，越小越先下载
    pub seq: u64,
    /// 下载 hevc 流（前端在本机播放过 hevc 时选用；与 main 同分辨率、体积约一半）
    #[serde(default)]
    pub hevc: bool,
}

struct Offline {
    root: PathBuf,
    paused: AtomicBool,
    /// 上一集因网络中断停下：等下一次唤醒再继续，不立刻重试
    stalled: AtomicBool,
    wake: Notify,
    seq: AtomicU64,
    cancelled: Mutex<HashSet<(i64, u32)>>,
    io: Mutex<()>,
}

/// 一集没下完的两种结局
#[derive(Debug, PartialEq)]
enum Failure {
    /// 网络不通：回到队列、保留进度，等唤醒后接着下
    Interrupted(String),
    /// 不会自己恢复（地址拿不到、写入失败、播放列表变了……）：标记失败，等用户点重试
    Fatal(String),
}

/// 同一个文件遇到网络错误时的重试间隔（之后仍不通就停下等唤醒）
#[cfg(not(test))]
const RETRY_DELAYS_MS: [u64; 3] = [3_000, 10_000, 30_000];
#[cfg(test)]
const RETRY_DELAYS_MS: [u64; 3] = [5, 5, 5];

fn http_status(error: &str) -> Option<u16> {
    error.strip_prefix("HTTP ")?.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// 网络中断类错误：超时、连不上、连接被断开、上游 408/425/429/5xx。
/// 上游明确拒绝（其余 4xx）、业务错误（如「暂无播放地址」）和本地写入失败都不算。
fn is_interruption(error: &str) -> bool {
    if let Some(status) = http_status(error) {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    let lower = error.to_ascii_lowercase();
    error.contains("超时")
        || [
            "timed out",
            "timeout",
            "error sending request",
            "connect",
            "connection",
            "dns",
            "tunnel",
            "reset",
            "broken pipe",
            "unexpected eof",
            "decoding response body",
            "network",
        ]
        .iter()
        .any(|k| lower.contains(k))
}

/// 记进 meta.json、显示给用户的原因：只留简短说明，不带地址（地址里有签名）。
fn reason(error: &str) -> String {
    if let Some(status) = http_status(error) {
        return format!("HTTP {status}");
    }
    let lower = error.to_ascii_lowercase();
    if error.contains("超时") || lower.contains("timed out") || lower.contains("timeout") {
        return "网络超时".into();
    }
    if lower.contains("dns") {
        return "域名解析失败".into();
    }
    if lower.contains("error sending request") || lower.contains("connect") || lower.contains("tunnel") {
        return "网络连接失败".into();
    }
    if is_interruption(error) {
        return "下载中断".into();
    }
    let text: String = error.split("http").next().unwrap_or("").trim().chars().take(40).collect();
    if text.is_empty() { "下载失败".into() } else { text }
}

static OFFLINE: OnceCell<Arc<Offline>> = OnceCell::new();

fn state() -> Result<&'static Arc<Offline>, String> {
    OFFLINE.get().ok_or_else(|| "离线缓存尚未初始化".to_string())
}

/// 启动时绑定缓存目录；上次中断的下载重新排队，空闲时续传。
pub fn bind(root: PathBuf) {
    let _ = OFFLINE.set(Offline::new(root));
}

pub fn list() -> Result<Value, String> {
    Ok(state()?.list())
}

pub fn enqueue(vid: i64, eps: &[u32], title: &str, detail: &Value, hevc: bool) -> Result<Vec<Episode>, String> {
    state()?.enqueue(vid, eps, title, detail, hevc)
}

pub fn delete(vid: i64, ep: Option<u32>) -> Result<(), String> {
    state()?.delete(vid, ep)
}

pub fn set_paused(paused: bool) {
    if let Some(offline) = OFFLINE.get() {
        offline.set_paused(paused);
    }
}

/// 网络中断后停下的队列接着下（前端在回到应用、网络恢复或用户点了中断的集时调用）。
pub fn resume() {
    if let Some(offline) = OFFLINE.get() {
        offline.kick();
    }
}

pub fn has_cover(vid: i64) -> bool {
    OFFLINE.get().is_some_and(|o| o.series_dir(vid).join("cover").exists())
}

pub fn save_cover(vid: i64, bytes: &[u8]) -> Result<(), String> {
    write_atomic(&state()?.series_dir(vid).join("cover"), bytes).map_err(|_| "无法保存封面".to_string())
}

/// hg 协议 `/offline/` 之后的路径：`<剧>/<集>/<文件>` 或 `<剧>/cover`。
pub fn read(rest: &str) -> Option<(&'static str, Vec<u8>)> {
    OFFLINE.get()?.read(rest)
}

/// 后台下载循环：队列空或被暂停时等待唤醒，不轮询。
pub async fn run_worker<P, PF, F, FF, E>(play_url: P, fetch: F, emit: E)
where
    P: Fn(i64, u32, bool) -> PF + Send + Sync + 'static,
    PF: Future<Output = Result<String, String>> + Send,
    F: Fn(String) -> FF + Send + Sync + 'static,
    FF: Future<Output = Result<Arc<Vec<u8>>, String>> + Send,
    E: Fn(&Episode) + Send + Sync + 'static,
{
    if let Some(offline) = OFFLINE.get() {
        offline.clone().run(play_url, fetch, emit).await;
    }
}

impl Offline {
    fn new(root: PathBuf) -> Arc<Self> {
        let _ = fs::create_dir_all(&root);
        let mut max_seq = 0;
        for mut ep in scan(&root) {
            max_seq = max_seq.max(ep.seq);
            if ep.state == "downloading" {
                ep.state = "queued".into();
                let _ = save_meta(&root, &ep);
            }
        }
        Arc::new(Self {
            root,
            paused: AtomicBool::new(false),
            stalled: AtomicBool::new(false),
            wake: Notify::new(),
            seq: AtomicU64::new(max_seq + 1),
            cancelled: Mutex::new(HashSet::new()),
            io: Mutex::new(()),
        })
    }

    fn series_dir(&self, vid: i64) -> PathBuf {
        self.root.join(vid.to_string())
    }

    fn episode_dir(&self, vid: i64, ep: u32) -> PathBuf {
        self.series_dir(vid).join(ep.to_string())
    }

    fn list(&self) -> Value {
        let _io = self.io.lock().unwrap();
        let mut episodes = scan(&self.root);
        episodes.sort_by_key(|e| e.seq);
        // 旧版本记下的是原始错误（可能带签名地址），列出来时统一换成简短原因
        for ep in &mut episodes {
            ep.error = ep.error.as_deref().map(reason);
        }
        let mut series = serde_json::Map::new();
        for vid in episodes.iter().map(|e| e.vid).collect::<HashSet<_>>() {
            if let Ok(text) = fs::read_to_string(self.series_dir(vid).join("series.json")) {
                if let Ok(detail) = serde_json::from_str::<Value>(&text) {
                    series.insert(vid.to_string(), detail);
                }
            }
        }
        json!({ "episodes": episodes, "series": series })
    }

    fn enqueue(&self, vid: i64, eps: &[u32], title: &str, detail: &Value, hevc: bool) -> Result<Vec<Episode>, String> {
        if vid <= 0 {
            return Err("无效的剧集".into());
        }
        let _io = self.io.lock().unwrap();
        let dir = self.series_dir(vid);
        fs::create_dir_all(&dir).map_err(|_| "无法创建缓存目录")?;
        write_atomic(&dir.join("series.json"), detail.to_string().as_bytes()).map_err(|_| "无法保存剧集信息")?;
        let mut changed = Vec::new();
        for &ep in eps {
            let existing = read_meta(&self.root, vid, ep);
            // 已缓存、排队或下载中的集不重复加入；失败的集重新排队，已下载的文件保留续传
            if existing.as_ref().is_some_and(|e| e.state != "error") {
                continue;
            }
            // 续传按文件名认已下载的部分：重试时换了流（如设备后来不再优先 HEVC）就清掉旧流的文件从头下，两路分片不能混用
            let resume = existing.filter(|e| e.hevc == hevc);
            let dir = self.episode_dir(vid, ep);
            if resume.is_none() && dir.exists() {
                fs::remove_dir_all(&dir).map_err(|_| "无法清理旧的缓存文件")?;
            }
            fs::create_dir_all(&dir).map_err(|_| "无法创建缓存目录")?;
            let seq = self.seq.fetch_add(1, Ordering::SeqCst);
            let meta = match resume {
                Some(e) => Episode { state: "queued".into(), error: None, seq, ..e },
                None => Episode {
                    vid,
                    ep,
                    title: title.to_string(),
                    state: "queued".into(),
                    done: 0,
                    total: 0,
                    bytes: 0,
                    error: None,
                    seq,
                    hevc,
                },
            };
            save_meta(&self.root, &meta).map_err(|_| "无法保存缓存状态")?;
            self.cancelled.lock().unwrap().remove(&(vid, ep));
            changed.push(meta);
        }
        if !changed.is_empty() {
            self.kick();
        }
        Ok(changed)
    }

    /// 唤醒下载循环；网络中断后停着的队列也一起恢复
    fn kick(&self) {
        self.stalled.store(false, Ordering::SeqCst);
        self.wake.notify_one();
    }

    fn delete(&self, vid: i64, ep: Option<u32>) -> Result<(), String> {
        let _io = self.io.lock().unwrap();
        let eps: Vec<u32> = match ep {
            Some(ep) => vec![ep],
            None => scan_series(&self.series_dir(vid)).iter().map(|e| e.ep).collect(),
        };
        self.cancelled.lock().unwrap().extend(eps.iter().map(|&ep| (vid, ep)));
        let path = match ep {
            Some(ep) => self.episode_dir(vid, ep),
            None => self.series_dir(vid),
        };
        if path.exists() {
            fs::remove_dir_all(&path).map_err(|_| "无法删除缓存文件")?;
        }
        // 最后一集删完后，只剩剧集信息与封面的目录一并清理
        if ep.is_some() && scan_series(&self.series_dir(vid)).is_empty() {
            let _ = fs::remove_dir_all(self.series_dir(vid));
        }
        Ok(())
    }

    fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        if !paused {
            self.kick();
        }
    }

    fn is_cancelled(&self, ep: &Episode) -> bool {
        self.cancelled.lock().unwrap().contains(&(ep.vid, ep.ep))
    }

    fn read(&self, rest: &str) -> Option<(&'static str, Vec<u8>)> {
        let digits = |s: &str| !s.is_empty() && s.len() <= 12 && s.bytes().all(|b| b.is_ascii_digit());
        let parts: Vec<&str> = rest.split('/').collect();
        let path = match parts.as_slice() {
            [vid, "cover"] if digits(vid) => self.root.join(vid).join("cover"),
            [vid, ep, file] if digits(vid) && digits(ep) && safe_file(file) => self.root.join(vid).join(ep).join(file),
            _ => return None,
        };
        let body = fs::read(&path).ok()?;
        let ctype = match path.extension().and_then(|e| e.to_str()) {
            Some("m3u8") => "application/vnd.apple.mpegurl",
            Some("ts") => "video/mp2t",
            Some("mp4" | "m4s") => "video/mp4",
            Some("aac") => "audio/aac",
            Some(_) => "application/octet-stream",
            None => image_kind(&body).unwrap_or("image/jpeg"),
        };
        Some((ctype, body))
    }

    async fn run<P, PF, F, FF, E>(self: Arc<Self>, play_url: P, fetch: F, emit: E)
    where
        P: Fn(i64, u32, bool) -> PF,
        PF: Future<Output = Result<String, String>>,
        F: Fn(String) -> FF,
        FF: Future<Output = Result<Arc<Vec<u8>>, String>>,
        E: Fn(&Episode),
    {
        loop {
            self.wait_resume().await;
            // 上一集网络中断：等唤醒（回到应用、网络恢复、离开播放页、新的缓存操作）再试，不自己定时重试
            if self.stalled.load(Ordering::SeqCst) {
                self.wake.notified().await;
                continue;
            }
            let job = {
                let _io = self.io.lock().unwrap();
                scan(&self.root)
                    .into_iter()
                    .filter(|e| e.state == "queued")
                    .min_by_key(|e| e.seq)
            };
            match job {
                Some(ep) => self.download(ep, &play_url, &fetch, &emit).await,
                None => self.wake.notified().await,
            }
        }
    }

    async fn wait_resume(&self) {
        while self.paused.load(Ordering::SeqCst) {
            self.wake.notified().await;
        }
    }

    async fn download<P, PF, F, FF, E>(&self, mut ep: Episode, play_url: &P, fetch: &F, emit: &E)
    where
        P: Fn(i64, u32, bool) -> PF,
        PF: Future<Output = Result<String, String>>,
        F: Fn(String) -> FF,
        FF: Future<Output = Result<Arc<Vec<u8>>, String>>,
        E: Fn(&Episode),
    {
        ep.state = "downloading".into();
        ep.error = None;
        let _ = save_meta(&self.root, &ep);
        emit(&ep);
        let result = self.fetch_episode(&mut ep, play_url, fetch, emit).await;
        if self.cancelled.lock().unwrap().remove(&(ep.vid, ep.ep)) {
            let _ = fs::remove_dir_all(self.episode_dir(ep.vid, ep.ep));
            return;
        }
        match result {
            Ok(()) => ep.state = "done".into(),
            // 回到队列，已下载的文件留着；error 只是给界面看的中断原因，下次开始下载时清掉
            Err(Failure::Interrupted(e)) => {
                ep.state = "queued".into();
                ep.error = Some(reason(&e));
                self.stalled.store(true, Ordering::SeqCst);
            }
            Err(Failure::Fatal(e)) => {
                ep.state = "error".into();
                ep.error = Some(reason(&e));
            }
        }
        let _ = save_meta(&self.root, &ep);
        emit(&ep);
    }

    /// 取地址和清单；网络不通时隔几秒重试几次，仍不通就算中断
    async fn plan_for<P, PF, F, FF>(&self, ep: &Episode, play_url: &P, fetch: &F) -> Result<Plan, Failure>
    where
        P: Fn(i64, u32, bool) -> PF,
        PF: Future<Output = Result<String, String>>,
        F: Fn(String) -> FF,
        FF: Future<Output = Result<Arc<Vec<u8>>, String>>,
    {
        let mut failures = 0;
        loop {
            match load_plan(ep, play_url, fetch).await {
                Ok(plan) => return Ok(plan),
                Err(e) if !is_interruption(&e) => return Err(Failure::Fatal(e)),
                Err(e) if failures >= RETRY_DELAYS_MS.len() => return Err(Failure::Interrupted(e)),
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[failures])).await;
                    failures += 1;
                }
            }
        }
    }

    async fn fetch_episode<P, PF, F, FF, E>(&self, ep: &mut Episode, play_url: &P, fetch: &F, emit: &E) -> Result<(), Failure>
    where
        P: Fn(i64, u32, bool) -> PF,
        PF: Future<Output = Result<String, String>>,
        F: Fn(String) -> FF,
        FF: Future<Output = Result<Arc<Vec<u8>>, String>>,
        E: Fn(&Episode),
    {
        let dir = self.episode_dir(ep.vid, ep.ep);
        let mut plan = self.plan_for(ep, play_url, fetch).await?;
        ep.total = plan.files.len();
        ep.done = plan.files.iter().filter(|r| dir.join(&r.file).exists()).count();
        ep.bytes = plan
            .files
            .iter()
            .filter_map(|r| fs::metadata(dir.join(&r.file)).ok())
            .map(|m| m.len())
            .sum();
        let _ = save_meta(&self.root, ep);
        emit(ep);
        let write_failed = || Failure::Fatal("写入缓存失败，请检查存储空间".into());
        // 连续刷新地址而没有新进度的次数；下到一个文件就清零，所以暂停很久或一集下很久都不会耗尽
        let mut refreshes = 0;
        // 当前文件连续遇到网络错误的次数
        let mut failures = 0;
        let mut i = 0;
        while i < plan.files.len() {
            self.wait_resume().await;
            if self.is_cancelled(ep) {
                return Err(Failure::Fatal("已取消".into()));
            }
            let path = dir.join(&plan.files[i].file);
            if path.exists() {
                i += 1;
                continue;
            }
            match fetch(plan.files[i].url.clone()).await {
                Ok(bytes) => {
                    if self.is_cancelled(ep) {
                        return Err(Failure::Fatal("已取消".into()));
                    }
                    write_atomic(&path, &bytes).map_err(|_| write_failed())?;
                    ep.done += 1;
                    ep.bytes += bytes.len() as u64;
                    let _ = save_meta(&self.root, ep);
                    emit(ep);
                    refreshes = 0;
                    failures = 0;
                    i += 1;
                }
                // 播放地址带时效签名：过期（比如在线播放时暂停了很久）就重新取地址，按同样的序号接着下载
                Err(e) if upstream_status(&e) != 502 => {
                    if refreshes >= 3 {
                        return Err(Failure::Fatal(e));
                    }
                    refreshes += 1;
                    plan = self.plan_for(ep, play_url, fetch).await?;
                    if plan.files.len() != ep.total {
                        return Err(Failure::Fatal("播放列表已变化，请删除后重新缓存".into()));
                    }
                }
                Err(e) if is_interruption(&e) => {
                    if failures >= RETRY_DELAYS_MS.len() {
                        return Err(Failure::Interrupted(e));
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[failures])).await;
                    failures += 1;
                }
                Err(e) => return Err(Failure::Fatal(e)),
            }
        }
        write_atomic(&dir.join("index.m3u8"), plan.text.as_bytes()).map_err(|_| write_failed())?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Resource {
    url: String,
    file: String,
}

struct Plan {
    text: String,
    files: Vec<Resource>,
}

async fn load_plan<P, PF, F, FF>(ep: &Episode, play_url: &P, fetch: &F) -> Result<Plan, String>
where
    P: Fn(i64, u32, bool) -> PF,
    PF: Future<Output = Result<String, String>>,
    F: Fn(String) -> FF,
    FF: Future<Output = Result<Arc<Vec<u8>>, String>>,
{
    let mut url = play_url(ep.vid, ep.ep, ep.hevc).await?;
    let mut text = utf8(fetch(url.clone()).await?)?;
    if let Some(variant) = pick_variant(&text, &url) {
        text = utf8(fetch(variant.clone()).await?)?;
        url = variant;
    }
    plan(&text, &url)
}

fn utf8(bytes: Arc<Vec<u8>>) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "播放列表不是 UTF-8 文本".to_string())
}

/// 多码率主清单选 BANDWIDTH 最高的子清单；媒体清单返回 None。
fn pick_variant(text: &str, base: &str) -> Option<String> {
    let mut best: Option<(u64, String)> = None;
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let Some(attrs) = line.trim().strip_prefix("#EXT-X-STREAM-INF:") else { continue };
        let bandwidth = attrs
            .split(',')
            .find_map(|a| a.trim().strip_prefix("BANDWIDTH="))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let uri = lines.by_ref().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#'));
        if let Some(uri) = uri {
            if best.as_ref().map_or(true, |(b, _)| bandwidth > *b) {
                best = Some((bandwidth, absolutize(base, uri)));
            }
        }
    }
    best.map(|(_, url)| url)
}

/// 把媒体清单改写成引用本地文件的版本，并列出要下载的资源（相同地址只下载一次）。
fn plan(text: &str, base: &str) -> Result<Plan, String> {
    let body = text.trim_start_matches('\u{feff}');
    if !body.starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    let mut files: Vec<Resource> = Vec::new();
    let mut by_url: HashMap<String, String> = HashMap::new();
    let mut add = |url: String, prefix: char, ext: &str| -> String {
        if let Some(name) = by_url.get(&url) {
            return name.clone();
        }
        let name = format!("{prefix}{}.{ext}", by_url.len());
        by_url.insert(url.clone(), name.clone());
        files.push(Resource { url, file: name.clone() });
        name
    };
    let mut out = String::with_capacity(body.len());
    for raw in body.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with("#EXT-X-KEY:") {
            out.push_str(&map_uri_attributes(line, |uri| add(absolutize(base, uri), 'k', "key")));
        } else if line.starts_with("#EXT-X-MAP:") {
            out.push_str(&map_uri_attributes(line, |uri| add(absolutize(base, uri), 'm', ext_of(uri, "mp4"))));
        } else if line.starts_with('#') {
            // 其余带外部地址的标签（内容引导、插播等）离线时用不上，直接丢弃
            if line.contains("URI=\"") || line.starts_with("#EXT-X-CONTENT-STEERING") {
                continue;
            }
            out.push_str(line);
        } else {
            out.push_str(&add(absolutize(base, line.trim()), 's', ext_of(line, "ts")));
        }
        out.push('\n');
    }
    Ok(Plan { text: out, files })
}

fn ext_of(uri: &str, fallback: &'static str) -> &'static str {
    let path = uri.split(['?', '#']).next().unwrap_or(uri).to_ascii_lowercase();
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("ts") => "ts",
        Some("m4s") => "m4s",
        Some("mp4") => "mp4",
        Some("aac") => "aac",
        _ => fallback,
    }
}

fn safe_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    !stem.is_empty()
        && stem.len() <= 16
        && stem.bytes().all(|b| b.is_ascii_alphanumeric())
        && matches!(ext, "m3u8" | "ts" | "key" | "mp4" | "m4s" | "aac")
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension("part");
    fs::write(&temp, bytes)?;
    fs::rename(&temp, path)
}

/// 只在集目录已存在时写入：用户删除后不会被进度更新重新建出来。
fn save_meta(root: &Path, ep: &Episode) -> std::io::Result<()> {
    let dir = root.join(ep.vid.to_string()).join(ep.ep.to_string());
    if !dir.is_dir() {
        return Err(std::io::ErrorKind::NotFound.into());
    }
    write_atomic(&dir.join("meta.json"), serde_json::to_string(ep).unwrap_or_default().as_bytes())
}

fn read_meta(root: &Path, vid: i64, ep: u32) -> Option<Episode> {
    let text = fs::read_to_string(root.join(vid.to_string()).join(ep.to_string()).join("meta.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn scan_series(series_dir: &Path) -> Vec<Episode> {
    let Ok(entries) = fs::read_dir(series_dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| fs::read_to_string(e.path().join("meta.json")).ok())
        .filter_map(|text| serde_json::from_str::<Episode>(&text).ok())
        .collect()
}

fn scan(root: &Path) -> Vec<Episode> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    entries.flatten().flat_map(|s| scan_series(&s.path())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    fn temp_root(tag: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("hghub-offline-{tag}-{}-{unique}", std::process::id()))
    }

    async fn wait_until(root: &Path, done: impl Fn(&[Episode]) -> bool) -> Vec<Episode> {
        for _ in 0..250 {
            let eps = scan(root);
            if done(&eps) {
                return eps;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out waiting for downloads: {:?}", scan(root));
    }

    const MEDIA: &str = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth=1\",IV=0x01\n#EXTINF:6,\nseg0.ts?auth=1\n#EXTINF:6,\nseg1.ts?auth=1\n#EXT-X-ENDLIST\n";

    #[test]
    fn plan_rewrites_segments_keys_and_maps_to_local_files() {
        let text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example/key?auth=9\",IV=0x01\n\
#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://evil.example/steer\"\n\
#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-URI=\"https://evil.example/ad\"\n\
#EXTINF:6,\n#EXT-X-BYTERANGE:1000@0\nall.m4s?auth=9\n#EXTINF:6,\n#EXT-X-BYTERANGE:1000@1000\nall.m4s?auth=9\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example/key?auth=9\",IV=0x02\n#EXTINF:4,\nlast.ts\n#EXT-X-ENDLIST\n";
        let local = plan(text, "https://cdn.example/v/index.m3u8?auth=9").unwrap();
        let names: Vec<_> = local.files.iter().map(|r| (r.file.as_str(), r.url.as_str())).collect();
        assert_eq!(
            names,
            [
                ("m0.mp4", "https://cdn.example/v/init.mp4"),
                ("k1.key", "https://k.example/key?auth=9"),
                ("s2.m4s", "https://cdn.example/v/all.m4s?auth=9"),
                ("s3.ts", "https://cdn.example/v/last.ts"),
            ]
        );
        assert!(local.text.contains("#EXT-X-MAP:URI=\"m0.mp4\""));
        assert_eq!(local.text.matches("URI=\"k1.key\"").count(), 2, "shared key downloaded once");
        assert_eq!(local.text.matches("\ns2.m4s\n").count(), 2, "byte ranges point into one local file");
        assert!(local.text.contains("#EXT-X-BYTERANGE:1000@1000"));
        assert!(!local.text.contains("evil.example") && !local.text.contains("https://"));
        assert!(plan("<html>", "https://cdn.example/x.m3u8").is_err());
    }

    #[test]
    fn master_playlists_pick_the_highest_bandwidth_variant() {
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS=\"avc1.4d401f,mp4a.40.2\"\nlow/index.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\nhigh/index.m3u8\n";
        assert_eq!(
            pick_variant(master, "https://cdn.example/v/master.m3u8").as_deref(),
            Some("https://cdn.example/v/high/index.m3u8")
        );
        assert_eq!(pick_variant(MEDIA, "https://cdn.example/v/index.m3u8"), None);
    }

    #[test]
    fn local_reads_reject_traversal_and_unknown_files() {
        let root = temp_root("read");
        let offline = Offline::new(root.clone());
        fs::create_dir_all(root.join("7").join("2")).unwrap();
        fs::write(root.join("7").join("2").join("s0.ts"), b"segment").unwrap();
        fs::write(root.join("7").join("2").join("meta.json"), b"{}").unwrap();
        fs::write(root.join("7").join("cover"), b"\xFF\xD8\xFF\xE0cover-bytes").unwrap();
        assert_eq!(offline.read("7/2/s0.ts"), Some(("video/mp2t", b"segment".to_vec())));
        assert_eq!(offline.read("7/cover").map(|(t, _)| t), Some("image/jpeg"));
        for bad in ["7/2/meta.json", "7/2/../../secret.ts", "7/../2/s0.ts", "x/2/s0.ts", "7/2/s 0.ts", "7/2", ""] {
            assert!(offline.read(bad).is_none(), "{bad}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_downloads_one_file_at_a_time_and_refreshes_expired_signatures() {
        let root = temp_root("queue");
        let offline = Offline::new(root.clone());
        let plays = Arc::new(AtomicUsize::new(0));
        let inflight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let expired_once = Arc::new(AtomicBool::new(false));
        let play_url = {
            let plays = plays.clone();
            move |vid: i64, ep: u32, hevc: bool| {
                let n = plays.fetch_add(1, Ordering::SeqCst) + 1;
                let stream = if hevc { "hevc" } else { "main" };
                async move { Ok(format!("https://cdn.example/{vid}/{ep}/{stream}/index.m3u8?auth={n}")) }
            }
        };
        let fetch = {
            let (inflight, peak, expired_once) = (inflight.clone(), peak.clone(), expired_once.clone());
            move |url: String| {
                let (inflight, peak, expired_once) = (inflight.clone(), peak.clone(), expired_once.clone());
                async move {
                    let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    inflight.fetch_sub(1, Ordering::SeqCst);
                    if url.contains("index.m3u8") {
                        return Ok(Arc::new(MEDIA.as_bytes().to_vec()));
                    }
                    // 第 1 集的第二个分片第一次请求时签名「过期」
                    if url.contains("/1/main/seg1.ts") && !expired_once.swap(true, Ordering::SeqCst) {
                        return Err("HTTP 403 Forbidden".to_string());
                    }
                    Ok(Arc::new(format!("bytes of {}", url.split('?').next().unwrap()).into_bytes()))
                }
            }
        };
        let events = Arc::new(Mutex::new(Vec::<Episode>::new()));
        let emit = {
            let events = events.clone();
            move |ep: &Episode| events.lock().unwrap().push(ep.clone())
        };
        let worker = tokio::spawn(offline.clone().run(play_url, fetch, emit));
        let detail = json!({"id": 5, "title": "剧", "episodes": [{"ep_num": 1}, {"ep_num": 2}]});
        assert_eq!(offline.enqueue(5, &[1], "剧", &detail, false).unwrap().len(), 1);
        assert_eq!(offline.enqueue(5, &[1, 2], "剧", &detail, true).unwrap().len(), 1, "no duplicates");
        let eps = wait_until(&root, |eps| eps.len() == 2 && eps.iter().all(|e| e.state == "done")).await;
        assert!(eps.iter().all(|e| e.total == 3 && e.done == 3 && e.bytes > 0));
        assert_eq!(peak.load(Ordering::SeqCst), 1, "never more than one request at a time");
        assert_eq!(plays.load(Ordering::SeqCst), 3, "one refresh after the expired signature");
        let local = fs::read_to_string(root.join("5").join("1").join("index.m3u8")).unwrap();
        assert!(local.contains("URI=\"k0.key\"") && local.contains("\ns1.ts\n") && !local.contains("https://"));
        assert_eq!(offline.read("5/1/s2.ts").unwrap().1, b"bytes of https://cdn.example/5/1/main/seg1.ts".to_vec());
        // 每集按加入时选的流下载：第 2 集选了 hevc
        assert_eq!(offline.read("5/2/s2.ts").unwrap().1, b"bytes of https://cdn.example/5/2/hevc/seg1.ts".to_vec());
        assert!(read_meta(&root, 5, 2).unwrap().hevc && !read_meta(&root, 5, 1).unwrap().hevc);
        assert_eq!(offline.list()["series"]["5"]["title"], "剧");
        let states: Vec<String> = events.lock().unwrap().iter().filter(|e| e.ep == 1).map(|e| e.state.clone()).collect();
        assert_eq!(states.first().map(String::as_str), Some("downloading"));
        assert_eq!(states.last().map(String::as_str), Some("done"));
        worker.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn retrying_with_another_stream_starts_over() {
        let root = temp_root("switch");
        let offline = Offline::new(root.clone());
        let dir = root.join("4").join("1");
        let failed = Episode { vid: 4, ep: 1, title: "剧".into(), state: "error".into(), done: 1, total: 3, bytes: 4, error: Some("x".into()), seq: 1, hevc: false };
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("s1.ts"), b"main").unwrap();
        save_meta(&root, &failed).unwrap();
        // 同一路流重试：保留已下载的文件续传
        offline.enqueue(4, &[1], "剧", &json!({}), false).unwrap();
        assert!(dir.join("s1.ts").exists());
        assert_eq!(read_meta(&root, 4, 1).unwrap().done, 1);
        // 换成 hevc 重试：main 的残留文件清掉，从头下载
        save_meta(&root, &failed).unwrap();
        let queued = offline.enqueue(4, &[1], "剧", &json!({}), true).unwrap();
        assert!(queued[0].hevc && queued[0].done == 0 && queued[0].state == "queued");
        assert!(!dir.join("s1.ts").exists());
        assert!(read_meta(&root, 4, 1).unwrap().hevc);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paused_queue_waits_and_deleted_episodes_are_removed() {
        let root = temp_root("pause");
        let offline = Offline::new(root.clone());
        let fetches = Arc::new(AtomicUsize::new(0));
        let fetch = {
            let fetches = fetches.clone();
            move |url: String| {
                fetches.fetch_add(1, Ordering::SeqCst);
                async move {
                    if url.contains("index.m3u8") {
                        Ok(Arc::new(MEDIA.as_bytes().to_vec()))
                    } else {
                        Ok(Arc::new(b"data".to_vec()))
                    }
                }
            }
        };
        let worker = tokio::spawn(offline.clone().run(
            |vid: i64, ep: u32, _hevc: bool| async move { Ok(format!("https://cdn.example/{vid}/{ep}/index.m3u8")) },
            fetch,
            |_: &Episode| {},
        ));
        offline.set_paused(true);
        offline.enqueue(9, &[1, 2], "剧", &json!({}), false).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(fetches.load(Ordering::SeqCst), 0, "online playback pauses the queue");
        offline.delete(9, Some(2)).unwrap();
        offline.set_paused(false);
        let eps = wait_until(&root, |eps| eps.iter().any(|e| e.ep == 1 && e.state == "done")).await;
        assert!(eps.iter().all(|e| e.ep == 1), "deleted episode is not downloaded: {eps:?}");
        assert!(!root.join("9").join("2").exists());
        offline.delete(9, None).unwrap();
        assert!(!root.join("9").exists());
        // 重启时，中断的下载回到队列
        fs::create_dir_all(root.join("3").join("1")).unwrap();
        let stuck = Episode { vid: 3, ep: 1, title: "x".into(), state: "downloading".into(), done: 1, total: 3, bytes: 4, error: None, seq: 7, hevc: false };
        save_meta(&root, &stuck).unwrap();
        let reopened = Offline::new(root.clone());
        assert_eq!(read_meta(&root, 3, 1).unwrap().state, "queued");
        assert_eq!(reopened.seq.load(Ordering::SeqCst), 8);
        worker.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn network_interruptions_keep_progress_and_wait_for_a_wake() {
        let root = temp_root("interrupt");
        let offline = Offline::new(root.clone());
        let online = Arc::new(AtomicBool::new(false));
        let fetches = Arc::new(AtomicUsize::new(0));
        let fetch = {
            let (online, fetches) = (online.clone(), fetches.clone());
            move |url: String| {
                let (online, fetches) = (online.clone(), fetches.clone());
                async move {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    if url.contains("index.m3u8") {
                        return Ok(Arc::new(MEDIA.as_bytes().to_vec()));
                    }
                    // 下到第二个分片时「断网」（比如切到后台被系统断了网）
                    if url.contains("seg1") && !online.load(Ordering::SeqCst) {
                        return Err(format!("error sending request for url ({url}) ← operation timed out"));
                    }
                    Ok(Arc::new(b"data".to_vec()))
                }
            }
        };
        let worker = tokio::spawn(offline.clone().run(
            |vid: i64, ep: u32, _hevc: bool| async move { Ok(format!("https://cdn.example/{vid}/{ep}/index.m3u8")) },
            fetch,
            |_: &Episode| {},
        ));
        offline.enqueue(6, &[1], "剧", &json!({}), false).unwrap();
        // 重试几次仍不通：回到队列，已下的文件留着，记下简短原因（不带地址）
        let eps = wait_until(&root, |eps| eps.iter().any(|e| e.state == "queued" && e.error.is_some())).await;
        assert_eq!(eps[0].error.as_deref(), Some("网络超时"));
        assert_eq!(eps[0].done, 2, "the key and the first segment are kept");
        assert!(root.join("6").join("1").join("s1.ts").exists());
        let idle = fetches.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(fetches.load(Ordering::SeqCst), idle, "an interrupted queue waits for a wake, no timed retries");
        // 回到应用 / 网络恢复：接着下剩下的分片
        online.store(true, Ordering::SeqCst);
        offline.kick();
        let eps = wait_until(&root, |eps| eps.iter().all(|e| e.state == "done")).await;
        assert!(eps[0].error.is_none() && eps[0].done == 3);
        worker.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn expired_signatures_refresh_as_long_as_the_download_progresses() {
        let root = temp_root("refresh");
        let offline = Offline::new(root.clone());
        let plays = Arc::new(AtomicUsize::new(0));
        let play_url = {
            let plays = plays.clone();
            move |vid: i64, ep: u32, _hevc: bool| {
                let n = plays.fetch_add(1, Ordering::SeqCst) + 1;
                async move {
                    if vid == 8 {
                        return Err("暂无播放地址".to_string());
                    }
                    Ok(format!("https://cdn.example/{vid}/{ep}/index.m3u8?auth={n}"))
                }
            }
        };
        // 每个签名只够下一个文件（比如在线播放时下载暂停了很久）：要刷新的次数比 3 次多，但每次刷新后都有进度
        let used = Arc::new(Mutex::new(HashSet::<String>::new()));
        let fetch = {
            let used = used.clone();
            move |url: String| {
                let used = used.clone();
                async move {
                    let auth = url.split("auth=").nth(1).unwrap_or("").to_string();
                    if url.contains("index.m3u8") {
                        let segs: String = (0..5).map(|i| format!("#EXTINF:6,\nseg{i}.ts?auth={auth}\n")).collect();
                        return Ok(Arc::new(format!("#EXTM3U\n#EXT-X-TARGETDURATION:6\n{segs}#EXT-X-ENDLIST\n").into_bytes()));
                    }
                    if !used.lock().unwrap().insert(auth) {
                        return Err("HTTP 403 Forbidden".to_string());
                    }
                    Ok(Arc::new(b"data".to_vec()))
                }
            }
        };
        let worker = tokio::spawn(offline.clone().run(play_url, fetch, |_: &Episode| {}));
        offline.enqueue(8, &[1], "拿不到地址的剧", &json!({}), false).unwrap();
        offline.enqueue(7, &[1], "剧", &json!({}), false).unwrap();
        let eps = wait_until(&root, |eps| eps.len() == 2 && eps.iter().all(|e| e.state == "done" || e.state == "error")).await;
        let ok = eps.iter().find(|e| e.vid == 7).unwrap();
        assert_eq!((ok.state.as_str(), ok.done, ok.total), ("done", 5, 5));
        // 不会自己恢复的错误：标记失败，不卡住后面的集
        let failed = eps.iter().find(|e| e.vid == 8).unwrap();
        assert_eq!((failed.state.as_str(), failed.error.as_deref()), ("error", Some("暂无播放地址")));
        assert_eq!(plays.load(Ordering::SeqCst), 6, "one failed lookup, then one address per segment");
        worker.abort();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failure_reasons_are_short_and_never_carry_signed_addresses() {
        assert_eq!(reason("HTTP 403 Forbidden"), "HTTP 403");
        assert_eq!(reason("请求超时"), "网络超时");
        assert_eq!(reason("error sending request for url (https://cdn.example/a.ts?auth_key=1-2-3) ← tcp connect error"), "网络连接失败");
        assert_eq!(reason("error decoding response body ← operation timed out"), "网络超时");
        assert_eq!(reason("暂无播放地址"), "暂无播放地址");
        assert_eq!(reason("播放列表格式不对 https://cdn.example/a.m3u8?auth_key=9"), "播放列表格式不对");
        // 已经是简短原因的再过一遍不变（列表会对旧版本记下的原始错误再整理一次）
        for short in ["HTTP 403", "网络超时", "网络连接失败", "域名解析失败", "下载中断", "暂无播放地址", "播放列表已变化，请删除后重新缓存"] {
            assert_eq!(reason(short), short);
        }
        assert!(is_interruption("HTTP 503 Service Unavailable") && is_interruption("请求超时"));
        assert!(!is_interruption("HTTP 404 Not Found") && !is_interruption("暂无播放地址") && !is_interruption("写入缓存失败，请检查存储空间"));
    }
}
