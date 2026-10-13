# 网关线协议

网关对手机暴露四个面。App 与官方 Web 客户端讲**同一种协议**——`/api` 的 envelope
原样透传，不做翻译。这是刻意的：契约由官方包（`@deepseek-ai/dsh-client-connection`，BSD-3-Clause）
定义并随版本演进，另造一套只会让网关永远追在后面。

## 面一览

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/mobile-gateway/health` | 无 | 探活 + 实例名 |
| POST | `/mobile-gateway/pair` | 一次性配对码 | 换长期设备令牌 |
| POST | `/mobile-gateway/api/<method…>` | Bearer 令牌 | 官方 `/api` 的透传桥 |
| WS | `/mobile-gateway/remote.mux` | Bearer 令牌 | **唯一**的 mux；逻辑流 `$events` 承载事件流 |
| GET/POST | `/mobile-gateway/manage*` | 回环 TCP 对端 | 铸码 / 二维码 / 设备吊销 |

## 1. 探活

```http
GET /mobile-gateway/health
```

```json
{ "ok": true, "service": "dsh-mobile-gateway", "version": "0.1.0",
  "instance": { "name": "desktop", "home": "C:\\Users\\…\\.dsh" } }
```

## 2. 配对

电脑上管理面板点「刷新配对码」得到 `dshm1.XXXX-XXXX-XXXX-XXXX`（16 位，去掉易混字符 0/O/1/I/L），
5 分钟过期，一次性消费；刷新后旧码立即作废。

```http
POST /mobile-gateway/pair
{ "code": "dshm1.A2B3-C4D5-E6F7-G8H9", "deviceName": "Pixel 9", "platform": "android" }
```

```json
{ "device": { "id": "dev_…", "name": "Pixel 9", "expiresAt": 1760000000000 },
  "token": "<43 字符 base64url>",
  "instance": { "name": "desktop", … } }
```

失败语义：`404 no_active_code`（没有有效码）、`403 mismatch`、`403 malformed`。

**令牌只在这一次返回**。磁盘上（`<dsh-home>/dsh-mobile-gateway/devices.json`，0600）
只留 `SHA-256(token)`。App 侧用 Android Keystore（`EncryptedSharedPreferences`）保存。

二维码内容是 `<base>/mobile-gateway/pair#<配对码>`，扫一次地址和码就都填好了。

## 3. `/api` 桥

```http
POST /mobile-gateway/api/session.list
Authorization: Bearer <token>
Content-Type: application/json

{ "type": "client-request", "rpcId": "r1", "method": "session.list", "payload": {} }
```

```json
{ "type": "server-response", "rpcId": "r1",
  "result": { "ok": true, "value": { "items": [ … ] } } }
```

四条硬约束（都是官方约定，改之前先读 `docs/api-contract.md`）：

- **`method` 必须等于路径段**，否则服务端直接判 bad-request。
- **`rpcId` 由客户端铸造并原样回显**；不匹配是抛错，不是错误结果。
- **非 2xx 是抛错**，不是 `{ok:false}`。传输故障与业务故障是两条不同路径。
- 错误统一形如 `{ "ok": false, "error": { "code", "message", "details" } }`，`details` 总是存在。

特权方法（见下节）由网关拦下，返回 **HTTP 403**，body 仍是同构的 `server-response`。

## 4. 事件流（单一 mux + 逻辑流）

> 🔴 **2026-10-13 整体更正**：真实主机**只有一条** mux WS ——
> `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`（网关侧路径 `/mobile-gateway/remote.mux`）。
> 原文档写的 `events.mux` / `events.host` 在真实源码里**零出现**，实测连上即被
> `invalid Remote endpoint` 断开。详见 `docs/api-contract.md` §1.4 / §1.5。

mux 是「一条 WS 承载多条逻辑流」，帧协议：

```ts
// 客户端 → 主机
{ type:'open',   streamId, endpoint, payload }   // 精确 4 键
{ type:'item',   streamId, value? }
{ type:'end',    streamId }
{ type:'cancel', streamId }

// 主机 → 客户端
{ type:'item',  streamId, value? }
{ type:'end',   streamId }
{ type:'error', streamId, error:{code,message,details} }
```

事件流是其中一条逻辑流：`endpoint = '$events'`、`payload = { args: {} }`。
主机在该流上回的 `item.value` 是 `ready` / `emit` / `waterfall` / `cancel` 四种：

- `ready` 给出 **clientId** —— 后续应答**必须**带上它。
- `emit` 是纯通知，**不需要应答**。
- `waterfall` 才在等结果（审批 / 提问），带 **eventId**，应答时原样送回。

**应答不是 WS，也不是 `/api/respond`**（后者真实主机上不存在），而是一个普通 RPC
endpoint **`$events/result`**：

```http
POST /mobile-gateway/api/$events/result
{ "type":"client-request", "rpcId":"…", "method":"$events/result",
  "payload": { "args": { "clientId":"…", "eventId":"…", "outcome": { … } } } }
```

`outcome` 三选一：`{kind:'next'}` / `{kind:'result', value?}` / `{kind:'rejected', error}`。
⚠️ `value` 的**内容**由事件自己的签名决定（审批是裸字符串 `'allowed-once'`，提问是
`{answers:[{id,selected}]}`）—— 形状错会被主机**静默**归一化成 `'unavailable'`。
详见 `docs/api-contract.md` §1.4。

协议违规语义：重复 `streamId` 的 `open` → 关 socket 1008；非法帧 → 1008；二进制帧 → 1003；
**未知 streamId 的 `item`/`end`/`cancel` 静默丢弃**（已结束的流先离开表，在途帧还在到）。

连接就绪的判定：**mux 已开 + 一次 `session.list` 成功**才算连上
（早期写的是 `host.describe`，但真实主机没有这个方法）。

重连策略在客户端：指数退避 500ms×2ⁿ，上限 10s，带 50–100% 抖动。
重放去重按 **eventId**（不是旧的 rpcId）。

## 安全模型

**已配对设备是完全控制凭据**——它能驱动这台电脑上的 DSH。手机丢失立刻在管理面板吊销，
吊销按请求生效（在途请求会完成，下一个请求 401）。

### 特权方法闸门

官方 node 载体把下面这批方法用**空信任表**过 `/api` 栅栏，从而把它们钉死在回环，
即使在受信部署上也不放开：

```
settings.describe / update / replace / mutate / openDocument
credentials.describe / set / unset
pluginManager.*
agentPreset.read / copy / openDocument / remove
host.pickDirectory / host.openPath
llm.discoverModels
```

问题在于：**我们的内部请求永远是回环身份**（`http://127.0.0.1/api/…`）。若原样转发，
等于凭据面和配置面被额外开放给每一台配对设备——一次提权。

因此网关显式复刻这张名单并在转发前拦截，默认拒绝。实现在
`packages/dsh-mobile-gateway/lib/bridge.mjs`，可配置但别轻易放开：

```yaml
- id: mobile-gateway
  name: dsh-mobile-gateway
  config:
    deniedMethods: []      # 清空 = 不额外限制（不推荐）
    deniedPrefixes: []
```

测试里有专门一项断言：拒绝时**没有触达宿主**——网关不能只是回一个 403 就放行。

### 回环判定

管理面按 `req.socket.remoteAddress` 判断，不看 `Host`。本机 profile 常把 webserver 绑到
`0.0.0.0`（比如 `@linxin666/dsh-remote-web-ui` 的 lanBind 托管块），用 Host 判断会被自身配置误伤。

### 传输安全

网关**不提供 TLS**。DSH 的 webserver 本身也是明文 HTTP。公网可达时请务必套一层
受信任证书的 HTTPS（Tailscale / cloudflared / 自建反代），不要把明文 HTTP 的 DSH 直接暴露出去。