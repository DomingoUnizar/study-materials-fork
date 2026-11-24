//! 上游加密接口（`dx150-edge-v1`）。
//!
//! 站点已把业务接口从明文信封 `POST /api/edge/request` 迁移到四个加密通道：
//! `/api/{public,dynamic,playback,user}/request`。旧入口现在固定返回
//! `HTTP 503 {"status":0,"msg":"接口已停用"}`，所以业务请求必须走这里。
//!
//! 每条通道（每个 origin）先做一次 ECDH(P-256) 握手：
//!
//! ```text
//! POST /api/<scope>/request {"v":1,"type":"hello","client_pub":"<b64url>"}
//!   -> {"v":1,"type":"hello","kid","sid","site","server_pub","salt","server_time","expires_at"}
//! ```
//!
//! 之后用 HKDF-SHA256 以 `salt` + `dx150-edge-v1\n<scope>\n<site>\n<kid>\n<sid>\n<req|res>`
//! 派生两把 AES-256-GCM 密钥；每次调用用「seq + 服务器时钟」做 AAD，密文放在
//! `{"v":1,"type":"call","kid","sid","seq","ts","ciphertext"}` 里。响应同样是密文，
//! 解开后是 `{"status","headers","body"}`，`body` 为 base64 的原始响应体。
//!
//! 服务端约束（都实测过，改动时别踩）：seq 必须 1..=16384 且严格递增，重放回
//! `409 {"error":"replay"}`；路径必须落在该 scope 的路由表里，错 scope 回
//! `400 {"error":"请求无法处理"}`；握手会话 600 秒有效。
//!
//! 注意：这里**不要**带 `Origin` 请求头。带上的请求会被上游判为跨站而返回
//! `403 {"error":"origin_denied"}`（WebView 里做不了，必须由 Rust 侧发起）。

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine;
use once_cell::sync::Lazy;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::agreement;
use ring::hkdf;
use ring::rand::SystemRandom;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::net;

/// 协议名，参与 HKDF 的 info 串；上游升到大版本时要跟着改。
pub const PROTOCOL: &str = "dx150-edge-v1";

/// 单条会话最多允许的序号（上游限制）。
const MAX_SEQUENCE: u32 = 16384;
/// 会话到期前提前这么多秒重建，避免边界上失败。
const SESSION_SKEW_SECS: i64 = 5;
/// 上游会话最长有效期（握手响应里也声明了，超过这个值说明响应异常）。
const MAX_SESSION_SECS: i64 = 600;
/// 路由表的刷新间隔（接口增删由站点配置下发）。
const ROUTE_TTL: Duration = Duration::from_secs(1800);
/// 拉取站点配置的超时。
const CONFIG_TIMEOUT: Duration = Duration::from_secs(8);

/* ───────────────────────── scope ───────────────────────── */

/// 四个加密通道。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Public,
    Dynamic,
    Playback,
    User,
}

impl Scope {
    fn name(self) -> &'static str {
        match self {
            Scope::Public => "public",
            Scope::Dynamic => "dynamic",
            Scope::Playback => "playback",
            Scope::User => "user",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Scope::Public => "/api/public/request",
            Scope::Dynamic => "/api/dynamic/request",
            Scope::Playback => "/api/playback/request",
            Scope::User => "/api/user/request",
        }
    }

    fn from_name(name: &str) -> Option<Scope> {
        match name {
            "public" => Some(Scope::Public),
            "dynamic" => Some(Scope::Dynamic),
            "playback" => Some(Scope::Playback),
            "user" => Some(Scope::User),
            _ => None,
        }
    }
}

/* ───────────────────────── 路由表 ───────────────────────── */

/// 站点 `window.__cloudfrontCompat.encryptedAPIRoutes` 的内置快照。
/// 启动后会尽力从站点配置刷新（接口增删不用跟着发版），失败就用这份。
const DEFAULT_ROUTES: &[(&str, Scope)] = &[
    // public（游客可读）
    ("GET /api/feed/post/today", Scope::Public),
    ("GET /api/feed/recommend", Scope::Public),
    ("GET /api/feed/today", Scope::Public),
    ("GET /api/home/latest", Scope::Public),
    ("GET /api/home/recommends", Scope::Public),
    ("GET /api/posts", Scope::Public),
    ("GET /api/posts/:id/adjacent", Scope::Public),
    ("GET /api/posts/:id/related", Scope::Public),
    ("GET /api/posts/category/:route", Scope::Public),
    ("GET /api/posts/tag/:tag", Scope::Public),
    ("GET /api/posts/user/:id", Scope::Public),
    ("GET /api/ranks/:type", Scope::Public),
    ("GET /api/search/hot", Scope::Public),
    ("GET /api/search/suggest", Scope::Public),
    ("GET /api/search/tags/hot", Scope::Public),
    ("GET /api/site/categories/post", Scope::Public),
    ("GET /api/site/categories/video", Scope::Public),
    ("GET /api/site/config", Scope::Public),
    ("GET /api/site/links", Scope::Public),
    ("GET /api/site/menus", Scope::Public),
    ("GET /api/site/meta", Scope::Public),
    ("GET /api/site/pages", Scope::Public),
    ("GET /api/site/pages/:slug", Scope::Public),
    ("GET /api/site/sorts/video", Scope::Public),
    ("GET /api/site/transit", Scope::Public),
    ("GET /api/site/watermark", Scope::Public),
    ("GET /api/tags", Scope::Public),
    ("GET /api/topics", Scope::Public),
    ("GET /api/topics/:slug", Scope::Public),
    ("GET /api/users/:id/stats", Scope::Public),
    ("GET /api/videos", Scope::Public),
    ("GET /api/videos/:id/related", Scope::Public),
    ("GET /api/videos/category/:route", Scope::Public),
    ("GET /api/videos/long", Scope::Public),
    ("GET /api/videos/report-reasons", Scope::Public),
    ("GET /api/videos/sort/:route", Scope::Public),
    ("GET /api/videos/tag/:tag", Scope::Public),
    ("GET /api/videos/user/:id", Scope::Public),
    // dynamic（按请求现算）
    ("POST /api/edge/image", Scope::Dynamic),
    ("GET /api/home", Scope::Dynamic),
    ("POST /api/media/covers", Scope::Dynamic),
    ("GET /api/posts/:id", Scope::Dynamic),
    ("GET /api/posts/:id/comments", Scope::Dynamic),
    ("POST /api/posts/:id/share", Scope::Dynamic),
    ("GET /api/search", Scope::Dynamic),
    ("GET /api/site/address-poster", Scope::Dynamic),
    ("POST /api/site/click", Scope::Dynamic),
    ("GET /api/site/entries", Scope::Dynamic),
    ("GET /api/site/go-home", Scope::Dynamic),
    ("POST /api/site/home-slots", Scope::Dynamic),
    ("POST /api/stats/click", Scope::Dynamic),
    ("POST /api/stats/origin", Scope::Dynamic),
    ("GET /api/users/:id", Scope::Dynamic),
    ("GET /api/videos/:id", Scope::Dynamic),
    ("GET /api/videos/:id/comments", Scope::Dynamic),
    ("GET /api/videos/:id/comments/:cid/replies", Scope::Dynamic),
    ("GET /api/videos/:id/next", Scope::Dynamic),
    ("POST /api/videos/:id/play", Scope::Dynamic),
    ("POST /api/videos/:id/episode-stats", Scope::Dynamic),
    ("POST /api/videos/:id/visit", Scope::Dynamic),
    ("POST /api/videos/recommend", Scope::Dynamic),
    ("POST /api/videos/recommend/ref/:ref", Scope::Dynamic),
    ("GET /api/whoami", Scope::Dynamic),
    // playback（播放地址）
    ("POST /api/media/playback/previews", Scope::Playback),
    ("POST /api/media/prerolls/:id/playback", Scope::Playback),
    ("POST /api/posts/:id/playback", Scope::Playback),
    ("POST /api/videos/:id/episodes/:ep/playback", Scope::Playback),
    ("GET /api/videos/:id/play", Scope::Playback),
    ("POST /api/videos/:id/playback", Scope::Playback),
    // user（账号 / 互动）
    ("POST /api/account/loginByPassword", Scope::User),
    ("POST /api/account/logout", Scope::User),
    ("GET /api/account/me", Scope::User),
    ("POST /api/account/password", Scope::User),
    ("PATCH /api/account/profile", Scope::User),
    ("POST /api/account/registerByPassword", Scope::User),
    ("POST /api/ai-wish", Scope::User),
    ("DELETE /api/posts/:id/collect", Scope::User),
    ("POST /api/posts/:id/collect", Scope::User),
    ("POST /api/posts/:id/comments", Scope::User),
    ("POST /api/posts/:id/comments/:cid/guest-like", Scope::User),
    ("DELETE /api/posts/:id/comments/:cid/like", Scope::User),
    ("POST /api/posts/:id/comments/:cid/like", Scope::User),
    ("GET /api/posts/:id/comments/liked", Scope::User),
    ("POST /api/posts/:id/guest-comments", Scope::User),
    ("POST /api/posts/:id/guest-like", Scope::User),
    ("GET /api/posts/:id/guest-liked", Scope::User),
    ("DELETE /api/posts/:id/like", Scope::User),
    ("POST /api/posts/:id/like", Scope::User),
    ("POST /api/posts/:id/visit", Scope::User),
    ("DELETE /api/users/:id/follow", Scope::User),
    ("POST /api/users/:id/follow", Scope::User),
    ("GET /api/users/me/collects", Scope::User),
    ("POST /api/users/me/collects/delete", Scope::User),
    ("GET /api/users/me/comments", Scope::User),
    ("GET /api/users/me/follows", Scope::User),
    ("GET /api/users/me/history", Scope::User),
    ("POST /api/users/me/history", Scope::User),
    ("POST /api/users/me/history/delete", Scope::User),
    ("POST /api/users/me/history/sync", Scope::User),
    ("GET /api/users/me/likes", Scope::User),
    ("POST /api/users/me/likes/delete", Scope::User),
    ("POST /api/users/me/likes/sync", Scope::User),
    ("GET /api/users/me/messages", Scope::User),
    ("DELETE /api/users/me/messages/:id", Scope::User),
    ("POST /api/users/me/messages/:id/read", Scope::User),
    ("POST /api/users/me/messages/batch-delete", Scope::User),
    ("POST /api/users/me/messages/read-all", Scope::User),
    ("GET /api/users/me/messages/unread-count", Scope::User),
    ("DELETE /api/videos/:id/collect", Scope::User),
    ("POST /api/videos/:id/collect", Scope::User),
    ("POST /api/videos/:id/comments", Scope::User),
    ("POST /api/videos/:id/comments/:cid/guest-like", Scope::User),
    ("DELETE /api/videos/:id/comments/:cid/like", Scope::User),
    ("POST /api/videos/:id/comments/:cid/like", Scope::User),
    ("GET /api/videos/:id/comments/liked", Scope::User),
    ("GET /api/videos/:id/comments/state", Scope::User),
    ("POST /api/videos/:id/feedback", Scope::User),
    ("POST /api/videos/:id/guest-comments", Scope::User),
    ("POST /api/videos/:id/guest-like", Scope::User),
    ("GET /api/videos/:id/guest-liked", Scope::User),
    ("GET /api/videos/:id/interaction-state", Scope::User),
    ("DELETE /api/videos/:id/like", Scope::User),
    ("POST /api/videos/:id/like", Scope::User),
    ("GET /api/videos/:id/rating", Scope::User),
    ("POST /api/videos/:id/rating", Scope::User),
    ("POST /api/videos/:id/report", Scope::User),
    ("GET /api/videos/following", Scope::User),
];

#[derive(Clone, Debug)]
struct Route {
    method: String,
    segments: Vec<String>,
    scope: Scope,
    params: usize,
    literal: usize,
}

impl Route {
    fn parse(spec: &str, scope: Scope) -> Option<Route> {
        let (method, path) = spec.trim().split_once(' ')?;
        if method.is_empty() || !path.starts_with('/') {
            return None;
        }
        let segments: Vec<String> = path.split('/').skip(1).map(str::to_string).collect();
        if segments.is_empty() || segments.iter().any(|s| s.is_empty()) {
            return None;
        }
        let params = segments.iter().filter(|s| s.starts_with(':')).count();
        let literal = segments
            .iter()
            .filter(|s| !s.starts_with(':'))
            .map(|s| s.len())
            .sum();
        Some(Route {
            method: method.to_ascii_uppercase(),
            segments,
            scope,
            params,
            literal,
        })
    }

    fn matches(&self, parts: &[&str]) -> bool {
        if parts.len() != self.segments.len() {
            return false;
        }
        self.segments.iter().zip(parts).all(|(pattern, part)| {
            if pattern.starts_with(':') {
                !part.is_empty()
            } else {
                pattern.as_str() == *part
            }
        })
    }
}

struct Table {
    routes: Vec<Route>,
}

impl Table {
    fn from_routes(routes: Vec<Route>) -> Table {
        Table { routes }
    }

    /// 选**最具体**的匹配：字面段多的优先，参数段少的优先。
    /// 站点里 `/api/videos/long`（public）与 `/api/videos/:id`（dynamic）同深，
    /// 不这样排序就会把长剧列表发到 dynamic 上被回 400。
    fn scope_for(&self, method: &str, path: &str) -> Scope {
        let (clean, query) = match path.split_once('?') {
            Some((path, query)) => (path, query),
            None => (path, ""),
        };
        let parts: Vec<&str> = clean.split('/').skip(1).collect();
        let mut best: Option<&Route> = None;
        for route in &self.routes {
            if !route.method.eq_ignore_ascii_case(method) || !route.matches(&parts) {
                continue;
            }
            let better = match best {
                None => true,
                Some(current) => {
                    route.params < current.params
                        || (route.params == current.params && route.literal > current.literal)
                }
            };
            if better {
                best = Some(route);
            }
        }
        let scope = best.map(|route| route.scope).unwrap_or(Scope::Dynamic);
        // 站点特例：public 路由带 sort=random/rand 时按 dynamic 处理（随机列表不能走缓存）。
        if scope == Scope::Public && has_random_sort(query) {
            Scope::Dynamic
        } else {
            scope
        }
    }
}

fn has_random_sort(query: &str) -> bool {
    if query.is_empty() {
        return false;
    }
    query.split('&').any(|pair| {
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        key == "sort"
            && matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "random" | "rand"
            )
    })
}

static DEFAULT_TABLE: Lazy<Arc<Table>> = Lazy::new(|| {
    let mut routes = Vec::with_capacity(DEFAULT_ROUTES.len());
    for (spec, scope) in DEFAULT_ROUTES {
        if let Some(route) = Route::parse(spec, *scope) {
            routes.push(route);
        }
    }
    Arc::new(Table::from_routes(routes))
});

static TABLES: Lazy<Mutex<HashMap<String, Arc<Table>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static ROUTE_REFRESH: Lazy<Mutex<HashMap<String, Instant>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn table_for(origin: &str) -> Arc<Table> {
    TABLES
        .lock()
        .ok()
        .and_then(|map| map.get(origin).cloned())
        .unwrap_or_else(|| DEFAULT_TABLE.clone())
}

/// 首次用到某个线路时，后台拉一次站点配置刷新路由表；失败就继续用内置表。
fn ensure_routes(origin: &str) {
    {
        let mut seen = match ROUTE_REFRESH.lock() {
            Ok(seen) => seen,
            Err(error) => error.into_inner(),
        };
        if let Some(last) = seen.get(origin) {
            if last.elapsed() < ROUTE_TTL {
                return;
            }
        }
        seen.insert(origin.to_string(), Instant::now());
    }
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let origin = origin.to_string();
    tokio::spawn(async move {
        if let Some(table) = fetch_table(&origin).await {
            if let Ok(mut tables) = TABLES.lock() {
                tables.insert(origin, table);
            }
        }
    });
}

async fn fetch_table(origin: &str) -> Option<Arc<Table>> {
    let response = net::get(
        &format!("{origin}/"),
        CONFIG_TIMEOUT,
        Some("text/html,application/xhtml+xml"),
        None,
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let html = response.text().await.ok()?;
    let config = extract_config(&html)?;
    table_from_config(&config)
}

/// 从首页 HTML 里抠出 `window.__cloudfrontCompat={...}`（配平花括号，跳过字符串）。
fn extract_config(html: &str) -> Option<Value> {
    let marker = html.find("__cloudfrontCompat")?;
    let start = html[marker..].find('{').map(|offset| marker + offset)?;
    let bytes = html.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for index in start..bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&html[start..=index]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn table_from_config(config: &Value) -> Option<Arc<Table>> {
    let routes = config.get("encryptedAPIRoutes")?.as_object()?;
    let mut parsed = Vec::new();
    for (name, list) in routes {
        let scope = Scope::from_name(name)?;
        for spec in list.as_array()? {
            if let Some(route) = spec.as_str().and_then(|spec| Route::parse(spec, scope)) {
                parsed.push(route);
            }
        }
    }
    if parsed.is_empty() {
        return None;
    }
    Some(Arc::new(Table::from_routes(parsed)))
}

fn scope_for(origin: &str, method: &str, path: &str) -> Scope {
    table_for(origin).scope_for(method, path)
}

/* ───────────────────────── 会话 ───────────────────────── */

struct Session {
    /// `dx150-edge-v1\n<scope>\n<site>\n<kid>\n<sid>`，AAD 的前缀。
    info: String,
    kid: String,
    sid: String,
    /// 服务器时间 - 本地时间（秒）。
    clock_offset: i64,
    /// 本地到期时间（秒）。
    expires_at: i64,
    seq: AtomicU32,
    req_key: [u8; 32],
    res_key: [u8; 32],
}

struct Slot {
    /// 同一 scope 的首次请求只握手一次，其余等待。
    gate: tokio::sync::Mutex<()>,
    session: Mutex<Option<Arc<Session>>>,
}

static SLOTS: Lazy<Mutex<HashMap<String, Arc<Slot>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn slot(key: &str) -> Arc<Slot> {
    let mut slots = match SLOTS.lock() {
        Ok(slots) => slots,
        Err(error) => error.into_inner(),
    };
    slots
        .entry(key.to_string())
        .or_insert_with(|| {
            Arc::new(Slot {
                gate: tokio::sync::Mutex::new(()),
                session: Mutex::new(None),
            })
        })
        .clone()
}

fn usable(slot: &Slot) -> Option<Arc<Session>> {
    let guard = slot.session.lock().ok()?;
    let session = guard.as_ref()?;
    if session.expires_at <= unix_now() + SESSION_SKEW_SECS {
        return None;
    }
    if session.seq.load(Ordering::Relaxed) >= MAX_SEQUENCE {
        return None;
    }
    Some(session.clone())
}

fn drop_session(origin: &str, scope: Scope) {
    let key = format!("{origin}|{}", scope.name());
    let slot = match SLOTS.lock() {
        Ok(slots) => slots.get(&key).cloned(),
        Err(error) => error.into_inner().get(&key).cloned(),
    };
    if let Some(slot) = slot {
        if let Ok(mut guard) = slot.session.lock() {
            *guard = None;
        }
    }
}

async fn session_for(origin: &str, scope: Scope) -> Result<Arc<Session>, String> {
    let key = format!("{origin}|{}", scope.name());
    let slot = slot(&key);
    if let Some(session) = usable(&slot) {
        return Ok(session);
    }
    let _gate = slot.gate.lock().await;
    if let Some(session) = usable(&slot) {
        return Ok(session);
    }
    let session = Arc::new(handshake(origin, scope).await?);
    if let Ok(mut guard) = slot.session.lock() {
        *guard = Some(session.clone());
    }
    Ok(session)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/* ───────────────────────── 握手 ───────────────────────── */

struct KeyLen(usize);

impl hkdf::KeyType for KeyLen {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive(info: &str, salt: &[u8], shared: &[u8], direction: &str) -> Result<[u8; 32], String> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, salt);
    let prk = salt.extract(shared);
    let info = format!("{info}\n{direction}");
    // ring 的 expand 接收 `&[&[u8]]`，这个切片必须比 okm 活得久，不能写成临时数组。
    let hkdf_info = [info.as_bytes()];
    let okm = prk
        .expand(&hkdf_info, KeyLen(32))
        .map_err(|_| "加密密钥派生失败".to_string())?;
    let mut key = [0u8; 32];
    okm.fill(&mut key)
        .map_err(|_| "加密密钥派生失败".to_string())?;
    Ok(key)
}

fn decode_url_base64(value: &str) -> Option<Vec<u8>> {
    B64URL.decode(value.as_bytes()).ok()
}

async fn handshake(origin: &str, scope: Scope) -> Result<Session, String> {
    let rng = SystemRandom::new();
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| "无法生成加密密钥".to_string())?;
    let public = private
        .compute_public_key()
        .map_err(|_| "无法导出加密公钥".to_string())?;
    let client_pub = B64URL.encode(public.as_ref());

    let (status, text, _) = net::post_json(
        &format!("{origin}{}", scope.endpoint()),
        &format!("{origin}/"),
        &json!({"v": 1, "type": "hello", "client_pub": client_pub}),
    )
    .await?;
    if status != 200 {
        let detail = outer_error(&text);
        return Err(if detail.is_empty() {
            format!("加密握手失败（HTTP {status}）")
        } else {
            format!("加密握手失败（HTTP {status}：{detail}）")
        });
    }

    let hello: Value =
        serde_json::from_str(&text).map_err(|_| "加密握手响应不是 JSON".to_string())?;
    let kid = hello
        .get("kid")
        .and_then(Value::as_str)
        .filter(|kid| valid_token(kid, 64))
        .ok_or("加密握手响应无效")?
        .to_string();
    let sid = hello
        .get("sid")
        .and_then(Value::as_str)
        .filter(|sid| sid.len() >= 16 && sid.len() <= 128 && valid_token(sid, 128))
        .ok_or("加密握手响应无效")?
        .to_string();
    let site = hello
        .get("site")
        .and_then(Value::as_str)
        .filter(|site| !site.is_empty() && site.len() <= 256)
        .ok_or("加密握手响应无效")?
        .to_string();
    let server_pub = hello
        .get("server_pub")
        .and_then(Value::as_str)
        .and_then(decode_url_base64)
        .filter(|bytes| bytes.len() == 65)
        .ok_or("加密握手响应无效")?;
    let salt = hello
        .get("salt")
        .and_then(Value::as_str)
        .and_then(decode_url_base64)
        .filter(|bytes| bytes.len() == 32)
        .ok_or("加密握手响应无效")?;
    let server_time = hello
        .get("server_time")
        .and_then(Value::as_i64)
        .ok_or("加密握手响应无效")?;
    let expires_at = hello
        .get("expires_at")
        .and_then(Value::as_i64)
        .ok_or("加密握手响应无效")?;
    if hello.get("v").and_then(Value::as_i64) != Some(1)
        || hello.get("type").and_then(Value::as_str) != Some("hello")
        || expires_at <= server_time
        || expires_at - server_time > MAX_SESSION_SECS
    {
        return Err("加密握手响应无效".to_string());
    }

    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, &server_pub);
    // 新版 ring 的 agree_ephemeral 返回 `Result<R, Unspecified>`，R 就是闭包的返回值，
    // 所以这里要连解两层。
    let shared = agreement::agree_ephemeral(private, &peer, |shared| {
        Ok::<Vec<u8>, ring::error::Unspecified>(shared.to_vec())
    })
    .map_err(|_| "加密握手失败（ECDH）".to_string())?
    .map_err(|_| "加密握手失败（ECDH）".to_string())?;

    let info = format!("{PROTOCOL}\n{}\n{site}\n{kid}\n{sid}", scope.name());
    let req_key = derive(&info, &salt, &shared, "req")?;
    let res_key = derive(&info, &salt, &shared, "res")?;
    let now = unix_now();
    Ok(Session {
        info,
        kid,
        sid,
        clock_offset: server_time - now,
        expires_at: now + (expires_at - server_time),
        seq: AtomicU32::new(0),
        req_key,
        res_key,
    })
}

fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn outer_error(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(|error| error.chars().take(60).collect())
        })
        .unwrap_or_default()
}

/* ───────────────────────── 加解密 ───────────────────────── */

fn nonce_for(sequence: u32) -> [u8; 12] {
    let mut iv = [0u8; 12];
    iv[8..].copy_from_slice(&sequence.to_be_bytes());
    iv
}

fn seal(key: &[u8; 32], iv: [u8; 12], aad: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "加密密钥无效".to_string())?;
    let key = LessSafeKey::new(unbound);
    let mut buffer = plaintext.to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(iv),
        Aad::from(aad.as_bytes()),
        &mut buffer,
    )
    .map_err(|_| "请求加密失败".to_string())?;
    Ok(buffer)
}

fn open(key: &[u8; 32], iv: [u8; 12], aad: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    let unbound = UnboundKey::new(&AES_256_GCM, key).map_err(|_| "加密密钥无效".to_string())?;
    let key = LessSafeKey::new(unbound);
    let mut buffer = ciphertext.to_vec();
    let plain = key
        .open_in_place(
            Nonce::assume_unique_for_key(iv),
            Aad::from(aad.as_bytes()),
            &mut buffer,
        )
        .map_err(|_| "响应解密失败".to_string())?;
    Ok(plain.to_vec())
}

/* ───────────────────────── 调用 ───────────────────────── */

enum CallError {
    /// 会话失效 / 序号重放 / 用尽：重建会话后可以重试一次。
    Refresh(String),
    /// 业务或参数错误：直接返回。
    Fatal(String),
}

/// 走加密通道调用一个业务接口，返回「业务 JSON（含 status/msg/data）」与内层 HTTP 状态。
pub async fn call(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<(Value, u16), String> {
    ensure_routes(origin);
    let scope = scope_for(origin, method, path);
    let mut last = String::from("加密接口请求失败");
    for attempt in 0..2 {
        let session = session_for(origin, scope).await?;
        match call_once(&session, origin, scope, method, path, body, token).await {
            Ok(result) => return Ok(result),
            Err(CallError::Refresh(message)) => {
                last = message;
                drop_session(origin, scope);
                if attempt == 1 {
                    break;
                }
            }
            Err(CallError::Fatal(message)) => return Err(message),
        }
    }
    Err(last)
}

async fn call_once(
    session: &Session,
    origin: &str,
    scope: Scope,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<(Value, u16), CallError> {
    let sequence = session.seq.fetch_add(1, Ordering::Relaxed) + 1;
    if sequence > MAX_SEQUENCE {
        return Err(CallError::Refresh("加密会话序号用尽".to_string()));
    }
    let timestamp = unix_now() + session.clock_offset;
    let iv = nonce_for(sequence);
    let request_aad = format!("{}\nreq\n{sequence}\n{timestamp}", session.info);
    let response_aad = format!("{}\nres\n{sequence}\n{timestamp}", session.info);

    let mut request = Map::new();
    request.insert("method".to_string(), json!(method));
    request.insert("path".to_string(), json!(path));
    if let Some(body) = body {
        let encoded = serde_json::to_vec(body)
            .map(|bytes| B64.encode(bytes))
            .map_err(|error| CallError::Fatal(error.to_string()))?;
        request.insert("body".to_string(), json!(encoded));
        request.insert("content_type".to_string(), json!("application/json"));
    }
    let mut packet = Map::new();
    packet.insert("request".to_string(), Value::Object(request));
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        packet.insert("authorization".to_string(), json!(format!("Bearer {token}")));
    }
    let plaintext = serde_json::to_vec(&Value::Object(packet))
        .map_err(|error| CallError::Fatal(error.to_string()))?;
    let ciphertext = seal(&session.req_key, iv, &request_aad, &plaintext).map_err(CallError::Fatal)?;

    let envelope = json!({
        "v": 1,
        "type": "call",
        "kid": session.kid,
        "sid": session.sid,
        "seq": sequence,
        "ts": timestamp,
        "ciphertext": B64URL.encode(ciphertext),
    });
    let (status, text, _) = net::post_json(
        &format!("{origin}{}", scope.endpoint()),
        &format!("{origin}/"),
        &envelope,
    )
    .await
    .map_err(CallError::Fatal)?;
    if status != 200 {
        let detail = outer_error(&text);
        if detail == "session_expired" || detail == "replay" || detail == "unknown_session" {
            return Err(CallError::Refresh(format!(
                "加密会话已失效（{detail}），正在重建"
            )));
        }
        return Err(CallError::Fatal(if detail.is_empty() {
            format!("加密接口请求失败（HTTP {status}）")
        } else {
            format!("加密接口请求失败（HTTP {status}：{detail}）")
        }));
    }

    let result: Value = serde_json::from_str(&text)
        .map_err(|_| CallError::Fatal("加密接口响应不是 JSON".to_string()))?;
    if result.get("v").and_then(Value::as_i64) != Some(1)
        || result.get("type").and_then(Value::as_str) != Some("result")
        || result.get("sid").and_then(Value::as_str) != Some(session.sid.as_str())
        || result.get("seq").and_then(Value::as_i64) != Some(sequence as i64)
        || result.get("ts").and_then(Value::as_i64) != Some(timestamp)
    {
        return Err(CallError::Fatal("加密接口响应不匹配".to_string()));
    }
    let ciphertext = result
        .get("ciphertext")
        .and_then(Value::as_str)
        .and_then(decode_url_base64)
        .ok_or_else(|| CallError::Fatal("加密接口响应格式无效".to_string()))?;
    let plaintext = open(&session.res_key, iv, &response_aad, &ciphertext).map_err(CallError::Fatal)?;
    let inner: Value = serde_json::from_slice(&plaintext)
        .map_err(|_| CallError::Fatal("加密接口响应格式无效".to_string()))?;
    let inner_status = inner
        .get("status")
        .and_then(Value::as_u64)
        .filter(|status| (100..=599).contains(status))
        .ok_or_else(|| CallError::Fatal("加密接口响应格式无效".to_string()))? as u16;
    let body = inner
        .get("body")
        .and_then(Value::as_str)
        .map(|body| B64.decode(body.as_bytes()).unwrap_or_default())
        .unwrap_or_default();
    let text = String::from_utf8_lossy(&body);

    if inner_status == 401 || inner_status == 403 {
        return Err(CallError::Fatal("401".to_string()));
    }
    if !(200..300).contains(&inner_status) {
        return Err(CallError::Fatal(format!(
            "HTTP {inner_status}: {}",
            text.chars().take(160).collect::<String>()
        )));
    }
    if text.trim().is_empty() {
        return Ok((Value::Null, inner_status));
    }
    let value = serde_json::from_str::<Value>(&text)
        .map_err(|error| {
            CallError::Fatal(format!(
                "{error}: {}",
                text.chars().take(160).collect::<String>()
            ))
        })?;
    Ok((value, inner_status))
}

/// 网络自检 / 线路探测用：只做一次握手，确认加密通道真的可用。
pub async fn probe(origin: &str) -> Value {
    let started = Instant::now();
    match handshake(origin, Scope::Public).await {
        Ok(session) => json!({
            "ok": true,
            "kid": session.kid,
            "protocol": PROTOCOL,
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(error) => json!({
            "ok": false,
            "error": error,
            "ms": started.elapsed().as_millis() as u64,
        }),
    }
}

/* ───────────────────────── 测试 ───────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_pick_the_most_specific_scope() {
        let table = DEFAULT_TABLE.as_ref();
        for (method, path, expected) in [
            ("GET", "/api/videos?page=1&size=10", Scope::Public),
            ("GET", "/api/videos/117", Scope::Dynamic),
            ("GET", "/api/videos/long?page=1", Scope::Public),
            ("GET", "/api/videos/following", Scope::User),
            ("GET", "/api/videos/report-reasons", Scope::Public),
            ("GET", "/api/videos/category/ai-duanju", Scope::Public),
            ("GET", "/api/videos/117/related", Scope::Public),
            ("GET", "/api/videos/117/comments?ep=1", Scope::Dynamic),
            ("POST", "/api/videos/117/episodes/3/playback", Scope::Playback),
            ("GET", "/api/videos/117/play?ep=1&page_texts=0", Scope::Playback),
            ("GET", "/api/search?q=abc", Scope::Dynamic),
            ("GET", "/api/search/hot", Scope::Public),
            ("GET", "/api/ranks/hot", Scope::Public),
            ("GET", "/api/posts?page=1", Scope::Public),
            ("GET", "/api/posts/117", Scope::Dynamic),
            ("GET", "/api/posts/117/comments", Scope::Dynamic),
            ("GET", "/api/account/me", Scope::User),
            ("GET", "/api/users/156291", Scope::Dynamic),
            ("GET", "/api/users/156291/stats", Scope::Public),
            ("GET", "/api/users/me/history", Scope::User),
            ("POST", "/api/account/loginByPassword", Scope::User),
            ("DELETE", "/api/videos/117/like?ep=1", Scope::User),
            ("GET", "/api/site/categories/video", Scope::Public),
            ("GET", "/api/home", Scope::Dynamic),
            ("GET", "/api/unknown/thing", Scope::Dynamic),
        ] {
            assert_eq!(table.scope_for(method, path), expected, "{method} {path}");
        }
    }

    #[test]
    fn random_sort_moves_a_public_read_to_dynamic() {
        let table = DEFAULT_TABLE.as_ref();
        assert_eq!(
            table.scope_for("GET", "/api/videos?page=1&sort=random"),
            Scope::Dynamic
        );
        assert_eq!(
            table.scope_for("GET", "/api/videos?sort=RAND&page=1"),
            Scope::Dynamic
        );
        assert_eq!(
            table.scope_for("GET", "/api/videos?page=1&sort=new"),
            Scope::Public
        );
        assert_eq!(
            table.scope_for("GET", "/api/videos?page=1&sort=hot"),
            Scope::Public
        );
    }

    #[test]
    fn sequence_is_big_endian_at_the_tail_of_the_nonce() {
        assert_eq!(nonce_for(1), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(nonce_for(258), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
        assert_eq!(
            nonce_for(MAX_SEQUENCE),
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0x00]
        );
    }

    #[test]
    fn url_base64_roundtrip_matches_the_site_format() {
        let raw: Vec<u8> = (0u8..64).collect();
        let encoded = B64URL.encode(&raw);
        assert!(!encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='));
        assert_eq!(decode_url_base64(&encoded).unwrap(), raw);
        assert!(decode_url_base64("!!!").is_none());
    }

    #[test]
    fn site_config_routes_are_read_from_the_homepage_marker() {
        let html = r#"<html><script>window.__cloudfrontCompat={"encryptedAPIEnabled":true,
            "encryptedAPIRoutes":{"public":["GET /api/videos"],"user":["POST /api/account/loginByPassword"]}};
        </script></html>"#;
        let config = extract_config(html).expect("config");
        let table = table_from_config(&config).expect("routes");
        assert_eq!(table.scope_for("GET", "/api/videos"), Scope::Public);
        assert_eq!(
            table.scope_for("POST", "/api/account/loginByPassword"),
            Scope::User
        );
        assert_eq!(table.scope_for("GET", "/api/elsewhere"), Scope::Dynamic);
    }

    #[test]
    fn config_extraction_ignores_braces_inside_strings() {
        let html = r#"window.__cloudfrontCompat={"a":"}{","routes":{"public":["GET /api/videos"]}}"#;
        let config = extract_config(html).expect("config");
        assert_eq!(config["a"], "}{");
    }

    /// 手动跑：`cargo test --lib -- --ignored edge::tests::live_feed -- --nocapture`
    #[tokio::test]
    #[ignore = "联网测试：走加密通道取一次首页，手动用 --ignored 运行"]
    async fn live_feed() {
        let (value, status) = call(
            crate::net::DEFAULT_BASE,
            "GET",
            "/api/videos?page=1&size=2",
            None,
            None,
        )
        .await
        .expect("encrypted call");
        assert_eq!(status, 200);
        assert_eq!(value["status"], 1);
        assert!(value["data"]["items"].as_array().is_some_and(|items| !items.is_empty()));
        println!("{}", serde_json::to_string_pretty(&value["data"]["pagination"]).unwrap());
    }
}
