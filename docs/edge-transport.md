# 加密接口传输层（dx150-edge-v1）

2026-11-21 前后上游把客户端业务接口从明文信封换成了加密通道：旧的
`POST /api/edge/request` 固定返回 `503 {"status":0,"msg":"接口已停用"}`，
App 因此首页、详情、播放、登录全部报「服务器请求失败（HTTP 503）」。
客户端实现见 [`src-tauri/src/edge.rs`](../src-tauri/src/edge.rs)。

## 协议

四个通道，按接口用途分组：

| scope | 端点 | 用途 |
| --- | --- | --- |
| public | `POST /api/public/request` | 游客可读：列表、分类、排行、帖子、站点配置 |
| dynamic | `POST /api/dynamic/request` | 按请求现算：详情、搜索、评论列表、`/api/home` |
| playback | `POST /api/playback/request` | 播放地址：`/api/videos/{id}/episodes/{ep}/playback` |
| user | `POST /api/user/request` | 账号与互动：登录、me、点赞、收藏、关注、发评论 |

### 1. 握手（每个 origin、每个 scope 一次）

```
POST /api/<scope>/request
{"v":1,"type":"hello","client_pub":"<base64url(ECDH P-256 公钥)>"}

-> {"v":1,"type":"hello","kid","sid","site","server_pub","salt","server_time","expires_at"}
```

`client_pub` 与 `server_pub` 都是未压缩点（65 字节，`04||X||Y`），`salt` 为 32 字节，
全部用 **URL-safe base64、无 padding**。会话有效期 600 秒。

### 2. 派生密钥

```
shared = ECDH(P-256, client_priv, server_pub)
info   = "dx150-edge-v1\n<scope>\n<site>\n<kid>\n<sid>"
reqKey = HKDF-SHA256(salt, shared, info + "\nreq")   // 32 字节，AES-256-GCM
resKey = HKDF-SHA256(salt, shared, info + "\nres")
```

### 3. 调用

```
seq = 1,2,3…（每会话严格递增，上限 16384）
ts  = 本地时间 + (server_time - 本地时间)
iv  = 12 字节，末 4 字节为大端 seq
aad = info + "\nreq|res\n" + seq + "\n" + ts

密文 = AES-256-GCM(key=reqKey, iv, aad, JSON{
  "request": {"method", "path", "body": base64(请求体), "content_type"},
  "authorization": "Bearer <token>"        // 有登录态时
})

POST /api/<scope>/request
{"v":1,"type":"call","kid","sid","seq","ts","ciphertext":"<base64url>"}

-> {"v":1,"type":"result","kid","sid","seq","ts","ciphertext":"<base64url>"}
   解密后：{"status": 200, "headers": {...}, "body": base64(原始响应体)}
```

响应体解开后仍是老的业务结构 `{"data":…,"status":1,"msg":""}`，所以业务层不需要改。

## 服务端约束（都实测过）

- **scope 必须与路径匹配**：错 scope 回 `400 {"error":"请求无法处理"}`。路由表由首页
  `window.__cloudfrontCompat.encryptedAPIRoutes` 下发，客户端内置了一份快照并每 30 分钟
  后台刷新一次（`src/edge.rs` 的 `DEFAULT_ROUTES`）。
- **seq 必须严格递增**：重放同一 seq 回 `409 {"error":"replay"}`；越界回 `400 invalid_request`。
- **不要带 `Origin` 头**：带上会被判为跨站，回 `403 {"error":"origin_denied"}`。
  这也是为什么加密层必须放在 Rust 侧，不能挪进 WebView。
- 会话过期回 `{"error":"session_expired"}`，客户端重建会话后重试一次。

## 与媒体链路的关系

封面、m3u8、密钥、分片**不经过**加密通道：封面仍是 AES-128-CBC（密钥在
`media.rs` 的 `IMG_KEY/IMG_IV`），m3u8 与分片仍是带 `auth_key` 的普通 HTTPS 请求。
所以这次迁移只动业务接口层。

## 排查入口

- `net_diag` 现在多一个 `edge` 字段：握手成功才算这条线路真的可用（只探首页会得到假绿灯）。
- 「线路」页的探测也改成握手探测，不再只看首页状态码。
- `debug.log` 的 `api.begin/api.end` 事件带 `transport: "dx150-edge-v1"` 与内层 `status`。

## 统一传输层（2026-11-24）

上游停用旧信封时，被关掉的只有 `POST /api/edge/request` 这一个入口；业务路由本身仍以明文
REST 提供。实测（同一个测试账号、同一台机器）：

| 请求 | 明文 REST | 加密通道 |
| --- | --- | --- |
| `GET /api/videos`、`/api/videos/{id}`、`/api/home`、`/api/search` | 200 | 200 |
| `POST /api/videos/{id}/episodes/{ep}/playback` | 200（含 m3u8 + auth_key） | 200 |
| `POST /api/account/loginByPassword`、`registerByPassword` | 200 | 200 |
| `GET /api/account/me`、`/api/users/me/*` | 401 `unauthorized` | 200 |
| `POST /api/videos/{id}/like`、`/collect`、`/visit` | 200 | 200 |

所以 `net::edge` 变成统一传输层，按能力选路，`src/edge.rs` 原样保留：

1. **REST 优先**：`GET`/`HEAD`、播放地址 POST、登录/注册走明文 REST（`rest_preferred`）。
2. **加密通道**：身份读取（`/api/account/*`、`/api/users/me/*`）与写操作（点赞、评论、收藏、
   历史同步）继续走 `dx150-edge-v1`，避免同一个写在两套通道上出现不同的幂等语义。
3. **协议级兜底**：REST 返回 404 / 400 `invalid_request` / 非业务信封时，才自动改走加密通道
   （`transport.fallback` 事件）。业务错误与权限错误换通道没有意义，直接返回。
4. **错误分类**：内部按 `business` / `permission` / `protocol` / `network` 归类，写进
   `api.end` 的 `api_error_kind`；对外返回的错误字符串保持原样（前端仍能解析 `HTTP nnn`）。
5. **写操作只提交一次**：只有无请求体的 `GET` 和取播放地址的 `POST` 允许重试，其余写操作
   一次即止，`net::tests::non_idempotent_operations_are_attempted_once` 守着这条规则。

明文 REST 与加密通道共用同一个 `reqwest` 客户端（rustls + webpki 根证书、按主机固定 DNS、
禁用自动重定向），不额外发送 `Origin`，TLS 与目标检查标准没有变化。

复现方式：

```bash
# 编译与单测
cargo test --lib
# 登录 + 明文/加密逐条对比（需要测试账号）
set HGHUB_TEST_USER=... HGHUB_TEST_PASS=...
cargo test --lib -- --ignored net::tests::live_rest_coverage -- --nocapture
# 走统一传输层跑主要业务链路
cargo test --lib -- --ignored net::tests::live_app_flow -- --nocapture
```
