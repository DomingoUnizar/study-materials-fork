//! 网络层：与上游站点对话。
//!
//! 业务接口全部走加密通道 `dx150-edge-v1`（四个 `/api/{public,dynamic,playback,user}/request`，
//! 实现见 [`crate::edge`]）。本文件只负责 HTTP 传输：DNS 固定、代理、超时、重定向与错误文案。
//! 旧的明文信封 `POST /api/edge/request` 已被上游停用（固定回 `503 接口已停用`）。
//!
//! # 代理（用户反馈「浏览器能开、HGhub 打不开」的根因就在这里）
//!
//! 客户端的流量**全部**走本文件的 reqwest，跟 WebView2 无关，所以它既不共享
//! 浏览器的代理设置，也不共享浏览器的证书库：
//!
//! * reqwest 只有开了 `system-proxy` feature 才会读 Windows 系统代理
//!   （`HKCU\...\Internet Settings` 的 `ProxyEnable`/`ProxyServer`/`ProxyOverride`）。
//!   本 crate 用 `default-features = false`，早先漏了这个 feature ⇒ 永远直连，
//!   只有 TUN/虚拟网卡这种网络层接管才「看起来能用」。
//! * 即使开了 `system-proxy`，PAC（`AutoConfigURL`）也不被支持，只认固定代理。
//! * Android 没有注册表可读，系统「Wi-Fi 代理」同样不被 reqwest 采用；
//!   安卓上只有 VPN/TUN 模式（VpnService 抓全流量）才有效。
//!
//! 排查手段：环境变量 `HGHUB_PROXY=http://127.0.0.1:7897` 可强制指定代理，
//! `net_diag` 命令会输出 DNS/HTTP/环境变量快照。

use crate::network_policy;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

/// 默认上游（固定线路 1）。
pub const DEFAULT_BASE: &str = "https://huangguoai.com";

/// 当前上游基址（不带结尾斜杠）。可在设置里切到固定线路 2 或镜像线路，运行时立即生效。
static BASE: Lazy<RwLock<String>> = Lazy::new(|| RwLock::new(DEFAULT_BASE.to_string()));
/// 线路配置落盘位置（应用数据目录/line.json），由 [`bind_base`] 在启动时绑定。
static BASE_FILE: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));

/// 当前上游基址。
pub fn base() -> String {
    BASE.read()
        .map(|b| b.clone())
        .unwrap_or_else(|_| DEFAULT_BASE.to_string())
}

/// 线路必须是纯 HTTPS origin，不允许路径、认证、查询串或片段。
pub fn normalize_base(raw: &str) -> Option<String> {
    let parsed = network_policy::parse_target(raw.trim()).ok()?;
    if parsed.scheme() != "https"
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

/// 远端发布页只提供游客镜像，不能扩展账号密码的信任范围。
pub fn trusted_auth_origin(origin: &str) -> bool {
    matches!(origin, "https://huangguoai.com" | "https://huangguoai.ai")
}

/// 启动时读回上次选择的线路（文件不存在 / 内容坏了就保持默认）。
pub fn bind_base(dir: &std::path::Path) {
    network_policy::bind_security(dir);
    let path = dir.join("line.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(next) = v
                .get("base")
                .and_then(|x| x.as_str())
                .and_then(normalize_base)
            {
                if let Ok(mut cur) = BASE.write() {
                    *cur = next;
                }
            }
        }
    }
    if let Ok(mut f) = BASE_FILE.write() {
        *f = Some(path);
    }
}

/// 切换线路并落盘，返回规整后的地址。
pub fn set_base(url: &str) -> Result<String, String> {
    let next = normalize_base(url)
        .ok_or_else(|| "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）".to_string())?;
    let previous = base();
    if let Ok(mut cur) = BASE.write() {
        *cur = next.clone();
    }
    if let Some(path) = BASE_FILE.read().ok().and_then(|p| p.clone()) {
        let _ = std::fs::write(path, json!({ "base": next }).to_string());
    }
    if previous != next {
        crate::playback_log::record(
            "line.changed",
            json!({
                "previous_host": url::Url::parse(&previous).ok().and_then(|u| u.host_str().map(str::to_owned)),
                "line_host": url::Url::parse(&next).ok().and_then(|u| u.host_str().map(str::to_owned)),
            }),
        );
    }
    Ok(next)
}

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 手动指定代理（排查 / 公司内网用）：`HGHUB_PROXY=http://127.0.0.1:7897`。
/// 不设时交给 reqwest 的 `system-proxy` 探测（注册表 + 环境变量）。
fn proxy_override() -> Option<String> {
    std::env::var("HGHUB_PROXY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 按**当前**系统代理设置新建一个客户端。
///
/// 注意：reqwest 的 `system-proxy` 只在构建时读一次注册表 / 环境变量。代理软件被关掉后，
/// 旧客户端仍会往 `127.0.0.1:7897` 建隧道，症状是满屏 `tunnel error: failed to create
/// underlying connection`（浏览器却是通的，因为它每次都重读系统代理）。所以这里允许重建。
fn build_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .gzip(true)
        .brotli(true)
        .pool_idle_timeout(Duration::from_secs(60));
    if !addrs.is_empty() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    if let Some(p) = proxy_override() {
        // 错误信息不能含原始代理 URL（其中可能有用户名/密码）。
        let proxy = reqwest::Proxy::all(&p).map_err(|_| "HGHUB_PROXY 配置无效（已隐藏原始值）")?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| "无法创建 HTTP 客户端".to_string())
}

const CLIENT_TTL: Duration = Duration::from_secs(30);
type ClientCache = HashMap<String, (Instant, Arc<reqwest::Client>)>;
static CLIENTS: Lazy<Mutex<ClientCache>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn cached_client(cache: &ClientCache, key: &str, now: Instant) -> Option<Arc<reqwest::Client>> {
    cache
        .get(key)
        .filter(|(expires, _)| now < *expires)
        .map(|(_, http)| http.clone())
}

/// 缓存按模式、主机和端口隔离；有效期内仅复用已经检查并固定地址的客户端。
/// 到期后重新检查全部 DNS 答案，不使用旧连接绕过新的目标检查。
async fn client_for(raw: &str) -> Result<(url::Url, Arc<reqwest::Client>), String> {
    let strict = network_policy::strict_security();
    let target = network_policy::parse_target_with_mode(raw, strict)?;
    let host = target.host_str().ok_or("目标缺少主机名")?;
    let port = target.port_or_known_default().ok_or("目标端口无效")?;
    let key = format!("{strict}:{host}:{port}");
    {
        let cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
        if let Some(http) = cached_client(&cache, &key, Instant::now()) {
            return Ok((target, http));
        }
    }
    let addrs = if strict {
        network_policy::resolve_target(&target, strict).await?
    } else {
        Vec::new()
    };
    let http = Arc::new(build_client(host, &addrs)?);
    let now = Instant::now();
    let mut cache = CLIENTS.lock().map_err(|_| "HTTP 客户端锁失败")?;
    // 同时到达的请求可能已完成解析；不延长已有结果的有效期。
    let http = cached_client(&cache, &key, now).unwrap_or(http);
    if !cache.get(&key).is_some_and(|(expires, _)| now < *expires) {
        cache.retain(|_, (expires, _)| now < *expires);
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, (now + CLIENT_TTL, http.clone()));
    }
    Ok((target, http))
}

pub fn refresh_client() {
    if let Ok(mut cache) = CLIENTS.lock() {
        cache.clear();
    }
}

/// 不可信 GET 的统一入口；自动重定向被关闭，每一跳重新检查 URL、DNS 并固定解析地址。
pub async fn get(
    raw: &str,
    timeout: Duration,
    accept: Option<&str>,
    referer: Option<&str>,
) -> Result<reqwest::Response, String> {
    tokio::time::timeout(timeout, async {
        let policy_error = |phase: &str, error: String| {
            crate::playback_log::record("network.target_failed", json!({"resource": crate::playback_log::resource_id(raw), "phase": phase, "error_kind": crate::playback_log::error_kind(&error)}));
            error
        };
        let mut next = network_policy::parse_target(raw).map_err(|e| policy_error("parse", e))?;
        for hop in 0..=5 {
            let resolving = Instant::now();
            let (target, http) = client_for(next.as_str()).await.map_err(|e| policy_error("dns_or_client", e))?;
            crate::playback_log::record("network.target_ready", json!({"resource": crate::playback_log::resource_id(raw), "target_resource": crate::playback_log::resource_id(target.as_str()), "dns_or_client_ms": resolving.elapsed().as_millis() as u64, "hop": hop}));
            let mut request = http.get(target.clone()).timeout(timeout);
            if let Some(value) = accept {
                request = request.header("Accept", value);
            }
            if let Some(value) = referer {
                request = request.header("Referer", value);
            }
            let response = request.send().await.map_err(|e| err_text(&e))?;
            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            if hop == 5 {
                return Err("重定向次数超过限制".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("重定向缺少有效 Location")?;
            next = network_policy::redirect_target(&target, location).map_err(|e| policy_error("redirect", e))?;
            crate::playback_log::record("network.redirect", json!({"resource": crate::playback_log::resource_id(raw), "from": crate::playback_log::resource_id(target.as_str()), "to": crate::playback_log::resource_id(next.as_str()), "status": response.status().as_u16(), "hop": hop + 1}));
        }
        Err("重定向次数超过限制".into())
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 加密通道的 JSON POST：沿用 DNS 固定、代理与超时策略，且**不跟随重定向**
/// （上游四个 `/api/*/request` 都是终态，重定向只会是劫持或配置错误）。
///
/// 绝不主动加 `Origin` 头：站点会把带跨站 Origin 的请求直接判为
/// `403 {"error":"origin_denied"}`。
pub(crate) async fn post_json(
    raw: &str,
    referer: &str,
    body: &Value,
) -> Result<(u16, String, &'static str), String> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let target = network_policy::parse_target(raw)?;
        let (target, client) = client_for(target.as_str()).await?;
        let response = client
            .post(target)
            .header("Accept", "application/json")
            .header("Referer", referer)
            .json(body)
            .send()
            .await
            .map_err(|error| err_text(&error))?;
        let status = response.status().as_u16();
        if response.status().is_redirection() {
            return Err("加密接口不允许重定向".to_string());
        }
        let gateway = if response.headers().contains_key("cf-ray") {
            "cloudflare"
        } else if response.headers().contains_key("x-amz-cf-id") {
            "cloudfront"
        } else {
            "other"
        };
        let text = response.text().await.map_err(|error| err_text(&error))?;
        Ok((status, text, gateway))
    })
    .await
    .map_err(|_| "请求超时".to_string())?
}

/// 只返回代理的协议/主机/端口；解析失败时隐藏整个值，绝不回传认证或查询参数。
pub fn redact_proxy(raw: &str) -> String {
    let parsed = url::Url::parse(raw.trim())
        .ok()
        .filter(|u| u.host_str().is_some());
    match parsed {
        Some(url) => {
            let mut safe = format!("{}://{}", url.scheme(), url.host_str().unwrap());
            if let Some(port) = url.port() {
                safe.push_str(&format!(":{port}"));
            }
            safe
        }
        None => "[已配置，原始值已隐藏]".into(),
    }
}

/// 看起来像代理 / 隧道问题（而不是目标站点本身不可达）。
pub fn is_proxy_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    e.contains("tunnel") || e.contains("proxy")
}

static LAST_HEAL: Lazy<std::sync::Mutex<Option<Instant>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// 请求失败后按需重建客户端：代理隧道错误、连接被拒 / 超时都算「网络环境可能变了」。
/// 3 秒内只重建一次，批量探测不会反复重建。
pub fn heal_client(reason: &str) {
    let connectish = reason.contains("Connect")
        || reason.contains("timed out")
        || reason.contains("refused")
        || reason.contains("dns");
    if !is_proxy_error(reason) && !connectish {
        return;
    }
    let mut last = match LAST_HEAL.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(t) = *last {
        if t.elapsed() < Duration::from_secs(3) {
            return;
        }
    }
    *last = Some(Instant::now());
    drop(last);
    refresh_client();
}

/// reqwest 的 `Display` 只有「error sending request for url (...)」，
/// 真正的原因（dns error / connection refused / invalid peer certificate）
/// 藏在 `source()` 链里。展开成一行，界面和 debug.log 才有排查价值。
pub fn err_text(e: &reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        let t = s.to_string();
        if !t.is_empty() && !out.contains(&t) {
            out.push_str(" ← ");
            out.push_str(&t);
        }
        src = s.source();
    }
    out
}

fn dns_summary(addrs: impl IntoIterator<Item = SocketAddr>) -> Value {
    let mut ips: Vec<_> = addrs.into_iter().map(|addr| addr.ip()).collect();
    ips.sort_unstable();
    ips.dedup();
    let has_fake_ip = ips.iter().any(|ip| {
        let v4 = match ip {
            std::net::IpAddr::V4(v4) => Some(*v4),
            std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
        };
        v4.is_some_and(|ip| {
            let [a, b, _, _] = ip.octets();
            a == 198 && (b == 18 || b == 19)
        })
    });
    json!({ "count": ips.len(), "has_fake_ip": has_fake_ip })
}

/// 网络自检：DNS / HTTP / 代理相关环境变量，用于远程定位「打不开」。
pub async fn diagnose() -> Value {
    let cur = base();
    let host = url::Url::parse(&cur)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_default();

    // fake-ip（198.18.0.0/15）说明 DNS 被 TUN 接管：关掉 TUN 后这个地址根本不可路由。
    let dns = {
        let host = host.clone();
        tokio::task::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            match (host.as_str(), 443u16).to_socket_addrs() {
                Ok(iter) => dns_summary(iter),
                Err(_) => json!({ "error": "DNS 解析失败" }),
            }
        })
        .await
        .unwrap_or(Value::Null)
    };

    let started = Instant::now();
    let http = match get(&format!("{cur}/"), Duration::from_secs(20), None, None).await {
        Ok(r) => json!({
            "status": r.status().as_u16(),
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({
            "error": e,
            "ms": started.elapsed().as_millis() as u64,
        }),
    };

    // 首页 200 不代表业务接口可用：加密通道握手成功才说明这条线路真的能用
    // （2026-11 上游停用旧信封时，所有线路首页都是 200、接口全是 503）。
    let edge = crate::edge::probe(&cur).await;

    json!({
        "base": cur,
        "host": host,
        "dns": dns,
        "http": http,
        "edge": edge,
        "env": {
            "HTTP_PROXY": std::env::var("HTTP_PROXY").ok().map(|p| redact_proxy(&p)),
            "HTTPS_PROXY": std::env::var("HTTPS_PROXY").ok().map(|p| redact_proxy(&p)),
            "ALL_PROXY": std::env::var("ALL_PROXY").ok().map(|p| redact_proxy(&p)),
            "NO_PROXY": std::env::var("NO_PROXY").ok().map(|_| "[已配置，列表已隐藏]"),
            "HGHUB_PROXY": proxy_override().map(|p| redact_proxy(&p)),
        },
    })
}

fn retryable_error(error: &str) -> bool {
    if error == "401" {
        return false;
    }
    // 上游明确的终态（旧信封停用、跨站拒绝）：重试只会放大日志噪音。
    if error.contains("接口已停用") || error.contains("origin_denied") {
        return false;
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse::<u16>()
                .ok()
        })
    {
        return matches!(status, 408 | 425 | 429 | 500..=599);
    }
    !matches!(
        crate::playback_log::error_kind(error),
        "https_downgrade_denied"
            | "private_address_denied"
            | "target_policy_denied"
            | "redirect_error"
    )
}

/// 只重试可能恢复的错误；404/权限错误/安全拒绝直接结束，避免无效等待。
/// 站点偶发 TLS 抖动；碰上代理隧道错误就先重建客户端再试
/// （代理软件开关后旧客户端会一直卡在 tunnel error 上）。
async fn with_retry<F, Fut, T>(retry: bool, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut last = String::from("network error");
    let attempts = if retry { 3 } else { 1 };
    for attempt in 0..attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if !retryable_error(&last) {
                    return Err(last);
                }
                heal_client(&last);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(350 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

// 只记录固定的操作类型，不写搜索词、账号、内容 ID 或查询参数。
fn edge_operation(path: &str) -> &'static str {
    let path = path.split('?').next().unwrap_or("");
    if path.starts_with("/api/videos/category/") {
        "category"
    } else if path.starts_with("/api/videos/") && (path.ends_with("/play") || path.ends_with("/playback")) {
        "play"
    } else if path == "/api/videos" {
        "feed"
    } else if path.starts_with("/api/videos/") {
        "video"
    } else if path == "/api/posts" {
        "posts"
    } else if path.starts_with("/api/posts/") {
        "post"
    } else if path.starts_with("/api/ranks/") {
        "rank"
    } else if path == "/api/search" {
        "search"
    } else if path.starts_with("/api/account/") {
        "account"
    } else {
        "other"
    }
}

/* ───────────────────────── 统一传输层 ───────────────────────── */

/// 传输失败的分类：界面与日志据此区分「业务失败」「没有权限」和「协议变了」。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApiErrorKind {
    Business,
    Permission,
    Protocol,
    Network,
}

impl ApiErrorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ApiErrorKind::Business => "business",
            ApiErrorKind::Permission => "permission",
            ApiErrorKind::Protocol => "protocol",
            ApiErrorKind::Network => "network",
        }
    }
}

#[derive(Debug)]
struct ApiError {
    kind: ApiErrorKind,
    message: String,
}

impl ApiError {
    fn new(kind: ApiErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn business(message: impl Into<String>) -> Self {
        Self::new(ApiErrorKind::Business, message)
    }

    fn permission(message: impl Into<String>) -> Self {
        Self::new(ApiErrorKind::Permission, message)
    }

    fn protocol(message: impl Into<String>) -> Self {
        Self::new(ApiErrorKind::Protocol, message)
    }

    fn network(message: impl Into<String>) -> Self {
        Self::new(ApiErrorKind::Network, message)
    }

    /// 只有协议级失败才换通道：业务失败换通道结果一样，网络失败换通道只会放大请求。
    fn should_fallback(&self) -> bool {
        matches!(self.kind, ApiErrorKind::Protocol)
    }
}

/// 明文 REST 是否优先。依据 2026-11-24 实测：
/// 公开读、详情、搜索、播放地址、登录/注册都可用；
/// 身份读取（`/api/account/me`、`/api/users/me/*`）用 Bearer 直连返回 401，
/// 写操作仍交给加密通道，避免同一个写请求在两套通道上出现不同的幂等语义。
fn rest_preferred(method: &str, path: &str) -> bool {
    let method = method.to_ascii_uppercase();
    let path = path.split('?').next().unwrap_or(path);
    if matches!(
        path,
        "/api/account/loginByPassword" | "/api/account/registerByPassword"
    ) {
        return true;
    }
    if path.starts_with("/api/account/") || path.starts_with("/api/users/me/") {
        return false;
    }
    match method.as_str() {
        "GET" | "HEAD" => true,
        // 取播放地址的 POST 没有副作用
        "POST" => path.ends_with("/playback"),
        _ => false,
    }
}

/// 把明文 REST 的响应分成：成功数据 / 业务失败 / 权限失败 / 协议失败。
/// 只有「协议失败」才值得再走一次加密通道（业务和权限错误换通道也没用）。
fn classify_rest(status: u16, text: &str) -> Result<Value, ApiError> {
    let parsed = serde_json::from_str::<Value>(text).ok();
    if let Some(parsed) = parsed.as_ref() {
        if let Some(business_status) = parsed.get("status").and_then(Value::as_i64) {
            if business_status == 1 {
                return Ok(parsed.get("data").cloned().unwrap_or(Value::Null));
            }
            if status == 401 || status == 403 {
                return Err(ApiError::permission("401"));
            }
            let message = parsed
                .get("msg")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("接口返回失败");
            return Err(ApiError::business(message));
        }
        if let Some(error) = parsed.get("error").and_then(Value::as_str) {
            return Err(ApiError::protocol(format!("HTTP {status}: {error}")));
        }
    }
    if status == 401 || status == 403 {
        return Err(ApiError::permission("401"));
    }
    if status >= 500 {
        return Err(ApiError::network(format!("HTTP {status}")));
    }
    Err(ApiError::protocol(format!("HTTP {status}")))
}

/// 明文 REST 请求：复用同一套 DNS 固定 / 代理 / TLS 策略，绝不主动加 `Origin`。
async fn rest_call(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<Value, ApiError> {
    let url = format!("{origin}{path}");
    let (target, client) = client_for(&url)
        .await
        .map_err(|error| ApiError::network(error))?;
    let mut request = match method.to_ascii_uppercase().as_str() {
        "GET" => client.get(target),
        "HEAD" => client.head(target),
        "POST" => client.post(target),
        "PUT" => client.put(target),
        "PATCH" => client.patch(target),
        "DELETE" => client.delete(target),
        other => return Err(ApiError::protocol(format!("不支持的请求方法：{other}"))),
    };
    request = request
        .header("Accept", "application/json")
        .header("Referer", format!("{origin}/"));
    if let Some(body) = body {
        request = request.json(body);
    }
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ApiError::network(err_text(&error)))?;
    if response.status().is_redirection() {
        // 业务接口都是终态，重定向只会是劫持或配置错误。
        return Err(ApiError::protocol("明文接口不允许重定向"));
    }
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|error| ApiError::network(err_text(&error)))?;
    classify_rest(status, &text)
}

/// 加密通道的错误是字符串（`401` / `HTTP 5xx` / 握手与信封错误），按语义重新归类。
fn classify_encrypted_error(error: &str) -> ApiError {
    if error == "401" {
        return ApiError::permission("401");
    }
    if let Some(status) = error
        .strip_prefix("HTTP ")
        .and_then(|rest| rest.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u16>().ok())
    {
        return if matches!(status, 408 | 425 | 429) || status >= 500 {
            ApiError::network(error.to_string())
        } else {
            ApiError::protocol(error.to_string())
        };
    }
    if error.contains("加密") {
        ApiError::protocol(error.to_string())
    } else {
        ApiError::network(error.to_string())
    }
}

fn unwrap_business(value: Value) -> Result<Value, ApiError> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    if value.get("status").and_then(Value::as_i64) == Some(1) {
        return Ok(value.get("data").cloned().unwrap_or(Value::Null));
    }
    Err(ApiError::business(
        value
            .get("msg")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("接口返回失败"),
    ))
}

async fn encrypted_call(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<Value, ApiError> {
    let (value, _status) = crate::edge::call(origin, method, path, body, token)
        .await
        .map_err(|error| classify_encrypted_error(&error))?;
    unwrap_business(value)
}

/// 业务请求：统一传输层。明文 REST 可用时优先，协议级失败再自动落到加密通道
/// （`dx150-edge-v1`，见 [`crate::edge`]）。写操作只提交一次，不因重试重复落库。
pub async fn edge(
    origin: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, String> {
    let cur = normalize_base(origin).ok_or("业务请求必须使用安全 HTTPS 线路")?;
    if network_policy::strict_security()
        && (token.is_some()
            || matches!(
                path,
                "/api/account/loginByPassword" | "/api/account/registerByPassword"
            ))
        && !trusted_auth_origin(&cur)
    {
        return Err("镜像线路仅供游客浏览；登录/注册请切换到固定线路".into());
    }
    let operation = edge_operation(path);
    let line_host = url::Url::parse(&cur)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    // 取播放地址的 POST 没有副作用，和 GET 一样允许重试；
    // 其余带请求体的写操作（点赞 / 评论 / 收藏）只尝试一次，避免重复提交。
    let can_retry = (method.eq_ignore_ascii_case("GET") && body.is_none())
        || (method.eq_ignore_ascii_case("POST") && operation == "play");
    let preferred = if rest_preferred(method, path) {
        "rest"
    } else {
        crate::edge::PROTOCOL
    };

    static NEXT_EDGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_EDGE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut attempt = 0u32;
    let (value, _transport) = with_retry(can_retry, || {
        attempt += 1;
        let attempt = attempt;
        let cur = cur.clone();
        let line_host = line_host.clone();
        let body = body.clone();
        let token = token.map(str::to_owned);
        async move {
            let started = Instant::now();
            crate::playback_log::record(
                "api.begin",
                json!({
                    "request": request, "attempt": attempt, "operation": operation,
                    "method": method, "line_host": line_host, "transport": preferred,
                }),
            );
            let result: Result<(Value, &'static str), ApiError> = if preferred == "rest" {
                match rest_call(&cur, method, path, body.as_ref(), token.as_deref()).await {
                    Ok(value) => Ok((value, "rest")),
                    // 协议级失败（路径不在明文接口里、响应不是业务信封）才换加密通道；
                    // 业务/权限错误换通道也一样，直接返回。
                    Err(error) if error.should_fallback() => {
                        crate::playback_log::record(
                            "transport.fallback",
                            json!({
                                "request": request, "attempt": attempt,
                                "from": "rest", "to": crate::edge::PROTOCOL,
                                "kind": error.kind.as_str(),
                            }),
                        );
                        encrypted_call(&cur, method, path, body.as_ref(), token.as_deref())
                            .await
                            .map(|value| (value, crate::edge::PROTOCOL))
                    }
                    Err(error) => Err(error),
                }
            } else {
                encrypted_call(&cur, method, path, body.as_ref(), token.as_deref())
                    .await
                    .map(|value| (value, crate::edge::PROTOCOL))
            };
            let mut event = json!({
                "request": request, "attempt": attempt, "operation": operation,
                "method": method, "line_host": line_host,
                "elapsed_ms": started.elapsed().as_millis() as u64,
            });
            match &result {
                Ok((_, used)) => {
                    event["transport"] = json!(used);
                    event["ok"] = json!(true);
                    event["retryable"] = json!(false);
                }
                Err(error) => {
                    event["transport"] = json!(preferred);
                    event["api_error_kind"] = json!(error.kind.as_str());
                    event["error_kind"] = json!(crate::playback_log::error_kind(&error.message));
                    event["retryable"] =
                        json!(can_retry && retryable_error(&error.message));
                }
            }
            crate::playback_log::record("api.end", event);
            result.map_err(|error| error.message)
        }
    })
    .await?;

    Ok(value)
}

/// 拉原始字节（图片 / m3u8 / 分片）。
pub async fn fetch_bytes(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    fetch_bytes_within(url, Duration::from_secs(20)).await
}

/// 同 [`fetch_bytes`]，但每次请求（含读完响应体）的时限由调用方定：
/// 离线下载不赶时间，一个分片常有好几 MB，慢网络下 20 秒读不完。
pub async fn fetch_bytes_within(url: &str, timeout: Duration) -> Result<(Option<String>, Vec<u8>), String> {
    static NEXT_REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let request = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let resource = crate::playback_log::resource_id(url);
    let mut attempt = 0;
    let url = url.to_string();
    let referer = format!("{}/", base());
    with_retry(true, || {
        attempt += 1;
        let attempt = attempt;
        let resource = resource.clone();
        let url = url.clone();
        let referer = referer.clone();
        async move {
            let started = Instant::now();
            crate::playback_log::record("network.begin", json!({"request": request, "resource": resource, "attempt": attempt}));
            let mut status = None;
            let mut headers_ms = None;
            let result = async {
                let resp = get(&url, timeout, None, Some(&referer)).await?;
                status = Some(resp.status().as_u16());
                headers_ms = Some(started.elapsed().as_millis() as u64);
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let ctype = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let bytes = resp.bytes().await.map_err(|e| err_text(&e))?.to_vec();
                Ok((ctype, bytes))
            }.await;
            crate::playback_log::record("network.end", json!({"request": request, "resource": resource, "attempt": attempt, "status": status, "headers_ms": headers_ms, "elapsed_ms": started.elapsed().as_millis() as u64, "bytes": result.as_ref().ok().map(|(_, bytes)| bytes.len()), "error_kind": result.as_ref().err().map(|e: &String| crate::playback_log::error_kind(e))}));
            result
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminal_errors_do_not_retry_but_transient_failures_can_recover() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for error in [
            "HTTP 404 Not Found: <html>nginx</html>",
            "HTTP 403 Forbidden",
            "401",
            "禁止访问内网",
            "重定向次数超过限制",
        ] {
            let calls = AtomicUsize::new(0);
            assert!(with_retry(true, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>(error.to_string())
            })
            .await
            .is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1, "{error}");
        }
        for error in ["HTTP 503 Service Unavailable", "请求超时"] {
            let calls = AtomicUsize::new(0);
            let value = with_retry(true, || {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt == 0 {
                        Err(error.to_string())
                    } else {
                        Ok(42)
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(value, 42);
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
    }

    #[test]
    fn api_operation_labels_exclude_user_input() {
        for (path, expected) in [
            ("/api/videos?page=1&size=10", "feed"),
            ("/api/videos/category/private?x=secret", "category"),
            ("/api/videos/42/play?ep=1", "play"),
            ("/api/videos/42/episodes/1/playback", "play"),
            ("/api/search?q=private-search", "search"),
            ("/api/account/loginByPassword", "account"),
            ("/unknown/private", "other"),
        ] {
            assert_eq!(edge_operation(path), expected);
        }
    }

    #[tokio::test]
    async fn non_idempotent_operations_are_attempted_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for (retry, expected) in [(false, 1), (true, 3)] {
            let calls = AtomicUsize::new(0);
            let result = with_retry(retry, || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err::<(), _>("rejected".to_string())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn dns_diagnostics_only_expose_counts_and_fake_ip_presence() {
        let addrs: Vec<SocketAddr> = ["10.0.0.1:443", "198.18.0.2:443", "[::ffff:198.18.0.3]:443"]
            .into_iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        let summary = dns_summary(addrs);
        assert_eq!(summary, json!({"count": 3, "has_fake_ip": true}));
        assert!(!summary.to_string().contains("10.0.0.1"));
        assert!(!summary.to_string().contains("198.18"));
        assert_eq!(
            dns_summary(Vec::<SocketAddr>::new()),
            json!({"count":0,"has_fake_ip":false})
        );
    }

    #[test]
    fn pinned_clients_expire_without_extending_the_dns_ttl() {
        let now = Instant::now();
        let client = Arc::new(reqwest::Client::new());
        let mut cache = ClientCache::new();
        cache.insert(
            "true:example.com:443".into(),
            (now + CLIENT_TTL, client.clone()),
        );
        assert!(Arc::ptr_eq(
            &cached_client(
                &cache,
                "true:example.com:443",
                now + Duration::from_secs(29)
            )
            .unwrap(),
            &client
        ));
        assert!(cached_client(&cache, "true:example.com:443", now + CLIENT_TTL).is_none());
        assert!(cached_client(&cache, "false:example.com:443", now).is_none());
        assert!(cached_client(&cache, "true:example.com:8443", now).is_none());
    }

    #[test]
    fn proxy_credentials_and_query_are_redacted() {
        assert_eq!(
            redact_proxy("http://alice:p%40ss@127.0.0.1:7897/path?token=secret#hidden"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            redact_proxy("socks5://alice:secret@[::1]:1080"),
            "socks5://[::1]:1080"
        );
        for raw in ["alice:secret@127.0.0.1:7897", "not a url secret", ""] {
            assert_eq!(redact_proxy(raw), "[已配置，原始值已隐藏]");
        }
    }

    #[test]
    fn base_requires_https_origin_and_auth_trust_is_static() {
        assert_eq!(
            normalize_base("https://HUANGGUOAI.COM:443/"),
            Some(DEFAULT_BASE.into())
        );
        for raw in [
            "http://huangguoai.com",
            "https://user:pass@huangguoai.com",
            "https://huangguoai.com/path",
            "https://huangguoai.com/?secret=1",
            "https://huangguoai.com/#fragment",
            "https://192.168.1.1",
        ] {
            assert_eq!(normalize_base(raw), None, "{raw}");
        }
        assert!(trusted_auth_origin(DEFAULT_BASE));
        assert!(trusted_auth_origin("https://huangguoai.ai"));
        assert!(!trusted_auth_origin("https://mirror.example"));
        assert!(!trusted_auth_origin("https://huangguoai.com.evil.example"));
    }

    #[tokio::test]
    async fn untrusted_origins_reject_credentials_before_network() {
        for (path, body, token) in [
            (
                "/api/account/loginByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            (
                "/api/account/registerByPassword",
                Some(json!({"password":"secret"})),
                None,
            ),
            ("/api/videos", None, Some("secret-token")),
        ] {
            let err = edge("https://mirror.invalid", "POST", path, body, token)
                .await
                .unwrap_err();
            assert!(err.contains("镜像线路仅供游客浏览"));
        }
    }

    #[tokio::test]
    async fn private_get_is_rejected_before_network() {
        let err = get(
            "http://127.0.0.1:1/private",
            Duration::from_secs(1),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("禁止访问"));
    }

    #[test]
    fn rest_first_covers_reads_playback_and_login_only() {
        for (method, path) in [
            ("GET", "/api/videos?page=1&size=20"),
            ("GET", "/api/videos/10586"),
            ("GET", "/api/home"),
            ("GET", "/api/search?q=abc"),
            ("POST", "/api/videos/10586/episodes/1/playback"),
            ("POST", "/api/posts/117/playback"),
            ("POST", "/api/account/loginByPassword"),
            ("POST", "/api/account/registerByPassword"),
        ] {
            assert!(rest_preferred(method, path), "{method} {path}");
        }
        // 身份读取与写操作留在加密通道
        for (method, path) in [
            ("GET", "/api/account/me"),
            ("GET", "/api/users/me/history?page=1"),
            ("POST", "/api/videos/10586/like"),
            ("POST", "/api/videos/10586/comments"),
            ("DELETE", "/api/videos/10586/collect"),
        ] {
            assert!(!rest_preferred(method, path), "{method} {path}");
        }
    }

    #[test]
    fn rest_responses_are_split_into_business_permission_and_protocol() {
        assert_eq!(
            classify_rest(200, r#"{"status":1,"data":{"items":[]}}"#).unwrap(),
            json!({"items": []})
        );
        let business = classify_rest(200, r#"{"status":0,"msg":"账号或密码错误"}"#).unwrap_err();
        assert_eq!(business.kind, ApiErrorKind::Business);
        assert_eq!(business.message, "账号或密码错误");
        let denied = classify_rest(401, r#"{"status":0,"msg":"unauthorized"}"#).unwrap_err();
        assert_eq!(denied.kind, ApiErrorKind::Permission);
        // 只有协议级失败才值得再走一次加密通道
        let protocol = classify_rest(400, r#"{"error":"invalid_request"}"#).unwrap_err();
        assert_eq!(protocol.kind, ApiErrorKind::Protocol);
        assert_eq!(
            classify_rest(404, "<html>not found</html>").unwrap_err().kind,
            ApiErrorKind::Protocol
        );
        assert_eq!(
            classify_rest(503, "").unwrap_err().kind,
            ApiErrorKind::Network
        );
    }

    #[test]
    fn only_protocol_failures_switch_channel() {
        assert!(ApiError::protocol("HTTP 404").should_fallback());
        assert!(!ApiError::permission("401").should_fallback());
        assert!(!ApiError::business("账号或密码错误").should_fallback());
        assert!(!ApiError::network("请求超时").should_fallback());
    }

    #[test]
    fn encrypted_errors_keep_permission_protocol_and_network_apart() {
        assert_eq!(
            classify_encrypted_error("401").kind,
            ApiErrorKind::Permission
        );
        assert_eq!(
            classify_encrypted_error("HTTP 400: invalid_request").kind,
            ApiErrorKind::Protocol
        );
        assert_eq!(
            classify_encrypted_error("加密接口响应不匹配").kind,
            ApiErrorKind::Protocol
        );
        assert_eq!(
            classify_encrypted_error("HTTP 503: 接口已停用").kind,
            ApiErrorKind::Network
        );
        assert_eq!(
            classify_encrypted_error("请求超时").kind,
            ApiErrorKind::Network
        );
    }

    /// 手动跑：`set HGHUB_TEST_USER=... HGHUB_TEST_PASS=... && cargo test --lib -- --ignored net::tests::live_rest_coverage -- --nocapture`
    /// 走 App 自己的登录接口拿会话，再逐条对比明文 REST 与加密通道的实际结果。
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUB_TEST_USER / HGHUB_TEST_PASS，手动用 --ignored 运行"]
    async fn live_rest_coverage() {
        let (Ok(user), Ok(pass)) = (
            std::env::var("HGHUB_TEST_USER"),
            std::env::var("HGHUB_TEST_PASS"),
        ) else {
            println!("跳过：缺少 HGHUB_TEST_USER / HGHUB_TEST_PASS");
            return;
        };
        let origin = DEFAULT_BASE;
        let login = edge(
            origin,
            "POST",
            "/api/account/loginByPassword",
            Some(json!({"username": user, "password": pass})),
            None,
        )
        .await
        .expect("登录失败");
        let token = login
            .get("token")
            .and_then(Value::as_str)
            .expect("登录返回缺少 token")
            .to_string();
        println!("登录成功：token 长度 {}", token.len());
        for (method, path) in [
            ("GET", "/api/videos?page=1&size=2"),
            ("GET", "/api/videos/10586"),
            ("GET", "/api/home"),
            ("GET", "/api/search?q=test"),
            ("POST", "/api/videos/10586/episodes/1/playback"),
            ("GET", "/api/account/me"),
            ("GET", "/api/users/me/history?page=1"),
        ] {
            let payload = json!({});
            let body = if method == "POST" { Some(&payload) } else { None };
            let rest = rest_call(origin, method, path, body, Some(&token)).await;
            let enc = encrypted_call(origin, method, path, body, Some(&token)).await;
            println!(
                "{method:6} {path:44} rest={:28} edge={:?}",
                match &rest {
                    Ok(_) => "ok".to_string(),
                    Err(error) => format!("{}:{}", error.kind.as_str(), error.message),
                },
                match &enc {
                    Ok(_) => "ok".to_string(),
                    Err(error) => format!("{}:{}", error.kind.as_str(), error.message),
                }
            );
        }
    }

    /// 手动跑：`set HGHUB_TEST_USER=... HGHUB_TEST_PASS=... && cargo test --lib -- --ignored net::tests::live_app_flow -- --nocapture`
    /// 走统一传输层把 App 的主要业务链路跑一遍（登录 → 列表 → 详情 → 播放地址 → 我的 → 点赞/取消）。
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUB_TEST_USER / HGHUB_TEST_PASS，手动用 --ignored 运行"]
    async fn live_app_flow() {
        let (Ok(user), Ok(pass)) = (
            std::env::var("HGHUB_TEST_USER"),
            std::env::var("HGHUB_TEST_PASS"),
        ) else {
            println!("跳过：缺少 HGHUB_TEST_USER / HGHUB_TEST_PASS");
            return;
        };
        let origin = DEFAULT_BASE;
        let login = edge(
            origin,
            "POST",
            "/api/account/loginByPassword",
            Some(json!({"username": user, "password": pass})),
            None,
        )
        .await
        .expect("登录失败");
        let token = login["token"].as_str().expect("缺少 token").to_string();
        let feed = edge(origin, "GET", "/api/videos?page=1&size=3", None, Some(&token))
            .await
            .expect("列表失败");
        let first = feed["items"][0]["id"].as_i64().expect("列表为空");
        let detail = edge(origin, "GET", &format!("/api/videos/{first}"), None, Some(&token))
            .await
            .expect("详情失败");
        let play = edge(
            origin,
            "POST",
            &format!("/api/videos/{first}/episodes/1/playback"),
            Some(json!({})),
            Some(&token),
        )
        .await
        .expect("播放地址失败");
        let me = edge(origin, "GET", "/api/account/me", None, Some(&token))
            .await
            .expect("我的失败");
        let liked = edge(
            origin,
            "POST",
            &format!("/api/videos/{first}/like"),
            Some(json!({})),
            Some(&token),
        )
        .await
        .expect("点赞失败");
        let unliked = edge(
            origin,
            "DELETE",
            &format!("/api/videos/{first}/like"),
            None,
            Some(&token),
        )
        .await
        .expect("取消点赞失败");
        println!(
            "视频 {first} 标题={:?} 播放流={} 我的 id={:?} 点赞={:?} 取消={:?}",
            detail["title"].as_str().unwrap_or(""),
            play.get("streams").is_some(),
            me.get("id"),
            liked.get("liked"),
            unliked.get("liked"),
        );
    }

    /// 手动跑：`set HGHUB_TEST_USER=... HGHUB_TEST_PASS=... && cargo test --lib -- --ignored net::tests::live_encrypted_only -- --nocapture`
    /// 只走加密通道把 App 用到的全部接口跑一遍，确认「全加密」是否可行（写操作按可逆方式做）。
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUB_TEST_USER / HGHUB_TEST_PASS，手动用 --ignored 运行"]
    async fn live_encrypted_only() {
        let (Ok(user), Ok(pass)) = (
            std::env::var("HGHUB_TEST_USER"),
            std::env::var("HGHUB_TEST_PASS"),
        ) else {
            println!("跳过：缺少 HGHUB_TEST_USER / HGHUB_TEST_PASS");
            return;
        };
        let origin = DEFAULT_BASE;
        let login = encrypted_call(
            origin,
            "POST",
            "/api/account/loginByPassword",
            Some(&json!({"username": user, "password": pass})),
            None,
        )
        .await;
        let token = login
            .as_ref()
            .ok()
            .and_then(|value| value.get("token"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        println!(
            "登录（加密通道）：{}",
            match (&login, &token) {
                (Ok(_), Some(token)) => format!("ok，token 长度 {}", token.len()),
                _ => format!("失败 {:?}", login.as_ref().err().map(|e| e.message.clone())),
            }
        );
        let token = token.expect("登录失败");
        let mut failures = 0;
        for (method, path) in [
            ("GET", "/api/videos?page=1&size=3".to_string()),
            ("GET", "/api/videos/category/ai-duanju?page=1&size=3".to_string()),
            ("GET", "/api/ranks/hot".to_string()),
            ("GET", "/api/search?q=test&page=1&size=3".to_string()),
            ("GET", "/api/search/hot".to_string()),
            ("GET", "/api/posts?page=1&size=3".to_string()),
            ("GET", "/api/posts/117".to_string()),
            ("GET", "/api/posts/117/comments?page=1".to_string()),
            ("GET", "/api/videos/12".to_string()),
            ("GET", "/api/videos/12/comments?ep=1".to_string()),
            ("GET", "/api/videos/12/play?ep=1&page_texts=0".to_string()),
            ("POST", "/api/videos/12/episodes/1/playback".to_string()),
            ("GET", "/api/users/156291".to_string()),
            ("GET", "/api/users/156291/stats".to_string()),
            ("GET", "/api/site/config".to_string()),
            ("GET", "/api/site/menus".to_string()),
            ("GET", "/api/account/me".to_string()),
            ("GET", "/api/users/me/history?page=1".to_string()),
            ("GET", "/api/users/me/collects?page=1".to_string()),
            ("GET", "/api/users/me/likes?page=1".to_string()),
        ] {
            let started = Instant::now();
            let result = encrypted_call(origin, method, &path, None, Some(&token)).await;
            let ms = started.elapsed().as_millis();
            match &result {
                Ok(_) => println!("{ms:5}ms ok    {method:6} {path}"),
                Err(error) => {
                    failures += 1;
                    println!(
                        "{ms:5}ms {} {method:6} {path}  ({})",
                        error.kind.as_str(),
                        error.message
                    );
                }
            }
        }
        // 可逆写操作：点赞 / 收藏 / 关注，做完立刻还原
        let payload = json!({});
        for (label, on, off) in [
            (
                "点赞",
                ("POST", "/api/videos/12/like?ep=1".to_string()),
                ("DELETE", "/api/videos/12/like?ep=1".to_string()),
            ),
            (
                "收藏",
                ("POST", "/api/videos/12/collect".to_string()),
                ("DELETE", "/api/videos/12/collect".to_string()),
            ),
            (
                "关注",
                ("POST", "/api/users/156291/follow".to_string()),
                ("DELETE", "/api/users/156291/follow".to_string()),
            ),
        ] {
            let started = Instant::now();
            let a = encrypted_call(origin, on.0, &on.1, Some(&payload), Some(&token)).await;
            let b = encrypted_call(origin, off.0, &off.1, None, Some(&token)).await;
            println!(
                "{:5}ms 写 {label}：{} / 还原：{}",
                started.elapsed().as_millis(),
                if a.is_ok() { "ok" } else { "失败" },
                if b.is_ok() { "ok" } else { "失败" }
            );
            if a.is_err() || b.is_err() {
                failures += 1;
            }
        }
        println!("失败 {failures} 项");
    }

    /// 手动跑：`cargo test --lib -- --ignored net::tests::diag -- --nocapture`
    /// 关掉 TUN、只留系统代理时跑一遍，能直接看出客户端有没有走代理。
    #[tokio::test]
    #[ignore = "联网测试：请求上游做网络自检，手动用 --ignored 运行"]
    async fn diag() {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnose().await).expect("json")
        );
    }
}
