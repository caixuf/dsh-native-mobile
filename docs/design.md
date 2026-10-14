# DSH 移动端 · 设计文档

> 版本：2026-10-14 · 面向 Electron 重构
>
> **这份文档的定位**：Android 端（Kotlin/Compose）是**参考实现**，Electron 端是重构。
> 换语言不会改变协议 —— **网关契约和客户端必须自己扛的责任，是这份文档要固化的东西**。
>
> 凡是标注「实测」的结论，都是在真实主机上跑出来的；标注「未验证」的，**不要当成事实**。

---

## 一、整体形态

```
┌──────────────┐        公网 / 局域网        ┌─────────────────────────┐
│  手机客户端   │  ──────────────────────▶  │  电脑上的 DSH 宿主        │
│ (Android /   │   HTTP + WebSocket        │                         │
│  Electron)   │                           │  ┌────────────────────┐ │
└──────────────┘                           │  │ dsh-mobile-gateway │ │
                                           │  │  （cordis 宿主插件） │ │
                                           │  └─────────┬──────────┘ │
                                           │            │ 进程内调用   │
                                           │            ▼            │
                                           │   DSH 的 /api 与流式通道  │
                                           └─────────────────────────┘
```

**网关是进程内插件，不是反代。** 这一条是刻意的，理由见第五章。

### 职责边界（重构时别搞混）

| 层 | 负责 | 不负责 |
|---|---|---|
| **DSH 宿主** | 会话、事件、审批状态机 | 认证、设备管理 |
| **网关插件** | 认证、设备令牌、特权方法闸门、`/api` 透明桥 | 任何业务语义翻译 |
| **客户端** | 信封拼装、重连退避、事件去重、UI | 依赖网关提供业务便捷接口 |

🔴 **网关刻意不做语义翻译**。客户端面对的就是 DSH 原生协议。新增「便捷 API」会让
网关随上游版本腐坏 —— 这是明确否掉过的方案（详见 `docs/architecture.md` §1）。

---

## 二、对外契约（HTTP 五个面）

这是**唯一稳定的接口**，Electron 端照此实现即可，不需要读 DSH 源码。

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/mobile-gateway/health` | 无 | 探活 + 实例名 |
| POST | `/mobile-gateway/login` | 账号密码 | 换长期设备令牌 |
| POST | `/mobile-gateway/pair` | 一次性配对码 | 换长期设备令牌 |
| POST | `/mobile-gateway/api/<method>` | Bearer | DSH `/api` 的透传桥 |
| WS | `/mobile-gateway/remote.mux` | Bearer | **唯一**的 mux，承载事件流 |
| GET/POST | `/mobile-gateway/manage*` | 回环 TCP 对端 | 管理面板（铸码/吊销） |

### 2.1 探活

```http
GET /mobile-gateway/health
→ 200 { "ok": true, "service": "dsh-mobile-gateway", "version": "0.1.0",
        "instance": { "name": "desktop", "home": "C:\\Users\\…\\.dsh" } }
```

`instance.name` 是**电脑身份**，客户端用它做多机去重（见 §4.3）。

### 2.2 登录 / 配对

两条入口**签发的令牌同构**，客户端可任选，也可都支持。

```http
POST /mobile-gateway/login
{ "username": "dsh", "password": "…", "deviceName": "Pixel 9", "platform": "android" }

POST /mobile-gateway/pair
{ "code": "dshm1.A2B3-C4D5-E6F7-G8H9", "deviceName": "Pixel 9", "platform": "android" }
```

成功（两者形状相同）：

```json
{ "device": { "id": "dev_…", "name": "Pixel 9", "expiresAt": 1760000000000 },
  "token": "<43 字符 base64url>",
  "instance": { "name": "desktop", … },
  "apiPrefix": "/mobile-gateway/api/",
  "stream": { "mux": "/mobile-gateway/remote.mux", "eventEndpoint": "$events" } }
```

🔴 **`stream` 字段必须按它给的用，不要硬编码**。历史上网关曾返回
`events.mux` + `events.host` 两条 —— 那些主机 endpoint **根本不存在**，
客户端照着连会被 `invalid Remote endpoint` 立刻断开。

🔴 **令牌有效期 30 天**（`config.tokenTtlMs = 30 * 24 * 60 * 60_000`），
过期时间在 `device.expiresAt`（毫秒时间戳）。

> **这对客户端是一个必须处理的产品问题**：30 天后 token 静默失效，
> 用户会在某次打开时**突然被要求重新登录**，且此前毫无预警。
>
> 客户端应当：
> 1. **本地计算剩余天数**，在临近过期（如剩 3 天）时提示「需要重新登录」
> 2. 失效时给出**明确文案**（「登录已过期，请重新登录」），不要显示成网络错误
> 3. 若能拿到 `login`/`pair` 的账号或地址（客户端已存），尽量**自动续期**而非让用户重来
>
> 参考实现**尚未处理**这一点 —— 这是已知缺口，不是设计如此。

**失败语义（实测）**：

| 场景 | HTTP | `error.code` |
|---|---|---|
| 登录：无凭据 | 401 | `no-credentials` |
| 登录：用户名/密码错 | 401 | `mismatch` |
| 配对：无有效码 | 404 | `no_active_code` |
| 配对：码不对 | 403 | `mismatch` |
| 配对：码格式非法 | 403 | `malformed` |

**配对码（两条路，安全强度不同）**：

| 形式 | 空间 | 说明 |
|---|---|---|
| **字符码** `dshm1.XXXX-XXXX-XXXX-XXXX` | `31^16` ≈ 10²³ | 去掉易混字符 `0/O/1/I/L`，5 分钟过期，一次性消费 |
| **6 位数字 PIN** | **10⁶ = 100 万** | ⚠️ 同样的 5 分钟窗口，**见下方风险** |

两条路都走 `redeem()`，`timingSafeEqual` 比较，**谁先命中都签发同等令牌**。

> 🔴 **已知风险：PIN 通道可被在线枚举（2026-10-14 实测，尚未修复）**
>
> `POST /mobile-gateway/pair` **没有任何速率限制**。实测连续 15 次错误 PIN：
> 15 次 / 100ms（约 **7ms 一次**），全部返回 404，**无 429、无锁定、无退避**。
>
> 风险量化（按 5 分钟窗口、PIN 空间 10⁶）：
>
> | 情形 | 窗口内尝试数 | 命中率 |
> |---|---|---|
> | 7ms/次 串行 | 42,857 | **4.3%** |
> | 30ms/次 串行（公网保守估） | 10,000 | 1.0% |
> | 30ms/次 + 10 并发 | 100,000 | **10%** |
> | 30ms/次 + 50 并发 | 500,000 | **50%** |
>
> 单次成功率不高，但**攻击者可长期监听** —— 用户每次铸码都是一个新窗口。
> 一旦命中，攻击者拿到的是**完全控制凭据**（能驱动这台电脑上的 DSH）。
>
> **建议（Electron 端做，或回头补在网关）**：
> 1. 对 `/pair` 与 `/login` 加**受信 IP 维度的失败计数 + 指数退避 + 锁定**
> 2. PIN 改为**只在本机/近距离**可用（它本是为「手输方便」设计的），或缩短到 2 分钟
> 3. 登录失败同理：`/login` 也无速率限制，且**密码策略仅要求 ≥6 字符、无复杂度**
>
> 另注：**密码**以裸 SHA-256（无盐、无 KDF）存于 `devices.json`
> （`store.mjs` L205 / L235 / L306 的 `passwordHash`）。密码是**低熵的人类选择**，
> 无盐哈希在文件泄露后可被彩虹表/GPU 直接还原。建议换 `scrypt`（Node 内置）。
>
> ⚠️ **但不要顺手把 token / 配对码的哈希也改掉** —— 那三处（`tokenHash`、`codeHash`、
> `pinHash`）用 SHA-256 **是正确的**：它们的输入是**高熵随机值**
> （43 字符 base64url / 31¹⁶ 的字符码），彩虹表与爆破都无意义，
> 慢哈希反而会给每次请求加无谓开销。**只有密码这一条需要 KDF。**

**二维码内容**：`<base>/mobile-gateway/pair#<配对码>` —— 扫码一次地址和码都拿到，
所以客户端**只支持扫码就能做到「不填网址」**（见 §4.2）。

### 2.3 `/api` 桥

```http
POST /mobile-gateway/api/session/list
Authorization: Bearer <token>
Content-Type: application/json

{ "type": "client-request", "rpcId": "r1", "method": "session/list",
  "payload": { "args": { "_request": {} } } }
```

```json
{ "type": "server-response", "rpcId": "r1",
  "result": { "ok": true, "value": { "items": [ … ] } } }
```

**四条硬约束**（违反会被判 bad-request，不是返回错误结果）：

1. **`method` 必须等于路径段**（路径里是斜杠 `session/list`，不是点号）
2. **`rpcId` 由客户端铸造并原样回显**；不匹配是抛错
3. **非 2xx 是抛错**，不是 `{ok:false}` —— 传输故障与业务故障是两条路径
4. **`args` 的键名是服务端声明的形参名**，因方法而异：

| 方法 | args 外层键 |
|---|---|
| `session/list` | `_request` ← **唯一特例** |
| `session/page` / `session/create` / `session/prompt` | `request` |
| `workspace/create` / `workspace/rename` | `request` |
| `$events/result` | 直接是 `{clientId, eventId, outcome}` |

> **怎么自己探出正确形参名**：故意传错，主机自己会报
> `args fields do not match the descriptor: missing "request"; unexpected "cwd"`。
> 这比读文档权威 —— 反映的是**当前运行实例**的真实 descriptor。

### 2.4 事件流

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
主机在该流上回的 `item.value` 是四种之一：

- **`ready`** → 给出 **clientId**，后续应答**必须**带上
- **`emit`** → 纯通知，**不需要应答**
- **`waterfall`** → 才在等结果（审批/提问），带 **eventId**
- **`cancel`** → 忽略

**应答不是 WS，也不是 `/api/respond`**（后者真实主机上不存在），而是普通 RPC：

```http
POST /mobile-gateway/api/$events/result
{ "type":"client-request", "rpcId":"…", "method":"$events/result",
  "payload": { "args": {
    "clientId":"…", "eventId":"…",
    "outcome": { "kind":"result", "value": … } } } }
```

> 🔴 **`outcome.kind` 三选一**：`next` / `result` / `rejected`。
>
> 🔴 **`value` 的内容由事件自己的签名决定，形状错会被主机静默归一化**：
> - 审批：必须是**裸字符串** `allowed-once` / `rejected` / `cancelled` / `unavailable`
> - 提问：`{ answers: [{ id, selected: [label…] }] }`
>
> **词表外的值不报错、不崩、日志干净 —— 而是被归一化成 `unavailable`（= 拒绝）。**
> 表现是「用户点了允许，工具却被拒绝」，极难排查。
> 参考实现里有 11 条契约测试专门钉死这一点（`ApprovalContractTest.kt`）。

**协议违规语义**：重复 `streamId` 的 `open` → 关 socket 1008；非法帧 → 1008；
二进制帧 → 1003；**未知 streamId 的 `item`/`end`/`cancel` 静默丢弃**。

---

## 三、客户端必须自己实现的部分

这些**网关不提供**，Electron 端要自己写。每条都标了为什么。

### 3.1 就绪判定

**mux 已开 + 一次 `session/list` 成功**才算连上。

> 只判 WS 已连接会得到「看起来连上了但收不到任何事件」的假在线。
> 早期用 `host.describe` 做探测 —— **真实主机没有这个方法**（实测 `host/describe` → 404）。

### 3.2 重连

指数退避 `500ms × 2ⁿ`，上限 10s，带 50–100% 抖动。

### 3.3 事件去重（**必做**）

主机下发的审批/提问带**稳定的 eventId**，**重连后会被重放**。
不去重会导致同一条审批反复弹窗。

按 **eventId** 去重（不是 rpcId）—— 参考实现用一个 `LinkedHashSet` 记已应答的 id。

### 3.4 子代理会话的开门判据

`session/list` 里的会话有的**不能用裸 sessionId 打开**。

> 🔴 判据只能认 **`origin === "subagent"`**，**不能用「带 parentSessionId」**。
> 实测两者不等价：`session/fork` 出来的**普通会话**也带 parentSessionId，
> 但它用裸 sessionId 打开是**正常**的。按后者判断会误伤可打开的会话。
>
> **2026-10-14 实测数据（120 条会话）**：
> `origin === "subagent"` → **54** 条；带 `parentSessionId` → **55** 条。
> 那 1 条差额就是 fork 出来的普通会话 —— 按 parent 判会把它误伤成不可打开。
> （主列表里 subagent 占比很高：54/120 ≈ 45%，误判的代价是近半数条目点进去是错误页。）

### 3.5 `workspace/list` 不存在

**DSH 宿主根本没有这个方法**（实测 `workspace/list` → HTTP 404）。

> 工作区分组必须从 **`session/list` 的 `cwd` 字段聚合**。
> 实测 120 条会话 → **8 个不同 cwd**（含 WSL 路径）。

聚合时注意两件事（都是实测踩到的）：

1. **同一目录会被写成多种形式**，必须归一化后再分组，否则屏幕上出现好几个同名组：
   - `C:\a\proj` vs `c:\A\PROJ`（大小写）
   - `C:\a\proj` vs `C:\a\proj\`（结尾分隔符）
   - `\\wsl.localhost\Ubuntu\…` vs `\\wsl$\Ubuntu\…`（WSL 两种前缀）
2. **系统目录要后置**：实测 120 条里约 **46%** 落在 DSH 内部目录
   （`.dsh\profiles\desktop`、`runtime-data\users\telegram-…`），
   与真实工作区平铺会把用户关心的内容挤下去。

### 3.6 `workspace/follow` 是流方法

实测：`workspace/follow` 走普通 RPC 会报
`stream Remote methods must be opened through the stream carrier`。

> **建议不要依赖它**。工作区状态从 `session/list` 聚合完全够用。

---

## 四、产品设计要点

### 4.1 核心场景：后台审批

**这是整个产品最关键的能力**，也是最容易被做残的。

用户诉求原话：「需要回答的时候立马在手机端通知用户，在手机端选择」。

**要真正做到，需要三件事同时成立**：

1. **连接必须是进程级的**，不能绑在窗口/页面上
   > 参考实现最初把连接绑在 Adapter/窗口生命周期上，窗口一关连接就断 ——
   > 电脑端卡在「等待授权」，手机完全不知道。这是**架构问题，不是加个通知能解决的**。
2. **必须有前台常驻/托盘进程**防系统回收（Android 是前台服务，Electron 是托盘 + 主进程常驻）
3. **通知要能直接应答**，不必先打开应用
   > 锁屏上点「允许一次」→ 后台把应答发出去 → 通知自动消失，用户继续做别的事。
   > 强迫用户先解锁进应用，就把「立刻响应」变成了「先解锁、再找应用、再点允许」。

**不做的话后果很具体**：连接掉线时若停掉常驻进程，等于**一旦掉线永远回不来**。
（参考实现踩过这个坑 —— 逻辑反转，见 §6.1。）

### 4.2 「不要填网址」

用户诉求原话：「能不能不要填网址，只账户密码」。

两条路径：

- **扫码配对**：二维码内容 `<base>/mobile-gateway/pair#<码>` 已内嵌地址，**本来就不用填**
- **账号密码登录**：记住上次成功的地址，下次预填

> 实现要点：取「已保存主机里最近使用的地址」优先，其次独立缓存。
> 前者更可信 —— 那是确实连接成功过的。
>
> 参考实现实测日志：
> `lastBaseUrl: hosts=1 fromHost=http://127.0.0.1:19387`
> → 地址框自动填好，只差 6 位配对码。

### 4.3 多机去重

同一台电脑换地址（局域网 IP 变了、换隧道）会新增记录。

判据优先级：
1. **`instance.name`**（电脑身份，来自 health/login/pair 响应）—— 最可靠
2. 规范化后的 `baseUrl`（退路，当 instance.name 缺失时）

> ⚠️ 这是 **UI 层的展示去重，不是安全边界** —— 鉴权始终靠 token。

---

## 五、被否掉的方案（别重复推演）

| 方案 | 为什么否掉 |
|---|---|
| **自造移动 API**（`mobile.session.list` 等） | DSH 的会话投影与事件负载本就是插件可扩展的（`SessionEvent.data` 官方 schema 里就是 `unknown()`）。自造一层意味着网关要翻译 DSH 内部模型，这份代码会随每个上游版本腐坏，且官方新增能力时永远滞后 |
| **反代到 `127.0.0.1:19387/api/...`** | 会撞上 DSH Desktop 那层**浏览器认证 cookie**（与 authority 绑定，无回环豁免）。进程内调用完全绕开 |
| **只依赖官方特权方法栅栏** | 我们的桥构造的请求**永远是回环身份**，在栅栏眼里就是回环 → 那张名单自动失效，等于给每台配对设备发一份凭据面 |
| **网关做 TLS / 隧道** | `dsh-mobile` 已把 Tailscale Funnel / cpolar / cloudflared / FRP / 自建反代五种通道做完。假定你已有一条能到电脑的路径 |
| **声明 `dsh.client`** | 会产生浏览器半边、peer 依赖与 `@deepseek-ai/cordis` 版本约束。本项目不送界面。历史事故：某插件因 peer 跨代不兼容**导致整个 DSH 启动中止** |

---

## 六、已知陷阱清单

### 6.1 常驻进程不要在断线时自杀

参考实现原文：

```kotlin
LinkState.Disconnected -> stopServiceIfNeeded()   // ❌ 逻辑反转
```

前台进程的**全部意义**就是断线时保住自己好让重连发生。一断线就退出，
等于**一旦掉线永远回不来**。

> 只有用户**主动断开**（切主机 / 删主机）才该停。

### 6.2 签名不一致会清空用户数据

**这是真实事故**：交付包用了 debug 签名（`CN=Android Debug`），
而历史版本是正式签名（`CN=DSH Native Mobile`）。

后果链条：

```
签名不一致 → 平台拒绝覆盖安装 → 只能卸载重装 → 应用数据全清空
          → 用户视角：「登录态保不住，每次都要重新配对」
```

**根因是构建脚本「读不到密钥就静默回退 debug 签名」** —— 它让一条 debug 包
**看起来像**正式发布包，从文件名无法分辨。

> **对策**：发版构建加一个开关（如 `-PrequireReleaseSigning=true`），
> 缺正式签名就**直接构建失败**，绝不静默降级。
> Electron 端同理 —— 打包时务必确认签名/公证配置生效。

### 6.3 认证面没有速率限制（安全缺口，未修复）

**实测（2026-10-14）**：`POST /mobile-gateway/pair` 与 `/login` **都没有任何限流**。

连续 15 次错误 PIN：15 次 / 100ms（约 7ms 一次），全部 404，
**无 429、无失败计数、无锁定、无退避**。

配合 6 位数字 PIN（空间 10⁶）与 5 分钟窗口：

| 情形 | 窗口内尝试数 | 命中率 |
|---|---|---|
| 7ms/次 串行 | 42,857 | **4.3%** |
| 30ms/次 + 10 并发 | 100,000 | **10%** |
| 30ms/次 + 50 并发 | 500,000 | **50%** |

> 单次成功率不高，但**攻击者可长期等待** —— 用户每次铸码都是新窗口。
> 一旦命中，拿到的是**完全控制凭据**（能驱动这台电脑上的 DSH）。
> 本项目明确支持公网访问（见 §5），所以这不是理论风险。
>
> **建议**：失败计数 + 指数退避 + 按来源 IP 锁定；PIN 通道限近距离或缩短窗口。
>
> 另：**密码以裸 SHA-256 无盐存储**（低熵人类密码，可被彩虹表还原），
> 建议换 `scrypt`。但**不要顺手改 token/codeHash/pinHash** ——
> 它们的输入是高熵随机值，SHA-256 用在那里是正确的。
>
> **关于 PIN 明文落盘**（`devices.json` 的 `pairing.pin`）：这是**有意的取舍**，
> 不是漏洞 —— 管理面板要在界面上显示 PIN 给用户看，不存明文就没法显示。
> 文件权限 0600 且位于本机。同一对象里**同时**存了 `pinHash` 用于校验，
> 因此校验路径并不依赖明文。风险仅在「文件已泄露」时才成立 ——
> 而那种情况下攻击者已经能直接读 `devices.json` 的所有设备令牌摘要了。
> 换句话说：**PIN 可在线枚举（上面那条）才是需要修的真问题，明文落盘不是。**

### 6.4 其他构建/环境陷阱

- **插件安装后必须重启宿主**：Node ESM 不热重载
- **安装副本有两处要同步**：`<dsh-home>\node_modules\` 与 `profiles\desktop\node_modules\`
- **注册必须写机器级 patch**：`profiles/` 在启动失败时会被隔离重建，profile 级补丁会丢
- **改 `cordis.patch.yml` 后必须重启**：写入走 revision 乐观锁，运行时外部改文件会让磁盘 revision 偏离内存值

---

## 七、参考实现现状

### 已完成并实测

| 能力 | 状态 |
|---|---|
| 协议接入（登录/配对/`/api` 桥/事件流） | ✅ 实测跑通 |
| 后台审批通知（前台服务 + 锁屏应答） | ⚠️ 管道通（事件流 `eventSockets=1`），**未触发过真实审批** |
| 主线程性能（JSON 解析移出、正则预编译、轮询上 Default） | ✅ 实测 |
| 工作区树（cwd 聚合 + WSL 友好名 + 系统目录后置） | ✅ 实测 |
| 深色/浅色主题 | ✅ 实测 |
| Markdown 渲染（表格/代码块/Callout） | ✅ 150 条单测 |
| 网址免手填 | ✅ 实测 |

### 明确未验证

- **锁屏审批端到端**：没触发过真实审批。这是**最该优先验证**的一项
- 真机长期后台存活（厂商省电策略下）
- 公网隧道下的长连接稳定性

---

## 八、给 Electron 重构的几条建议

1. **先把 §2 的契约写成类型定义**（TypeScript interface），别散落在各处的字符串
2. **§3 的客户端责任单独成模块**（就绪判定/重连/去重），这些是纯逻辑，**最容易写单元测试**
3. **§6.1 和 §6.2 必须在第一版就做对** —— 它们不是优化项，是架构正确性问题
4. **审批通知要在托盘进程里实现**，不要等窗口打开才处理
5. 参考实现的 **150 条单测**里，最有迁移价值的是：
   - `ApprovalContractTest`（11 条）—— 钉死静默归一化陷阱
   - `WorkspaceKeyTest`（20 条）—— 路径归一化
   - `MessageQueueTest`（10 条）—— 运行中可输入 + 排队

---

## 附：验证脚本

网关侧（`packages/dsh-mobile-gateway/`）：

| 脚本 | 用途 |
|---|---|
| `scripts/list-endpoints.mjs` | 枚举主机真实端点 |
| `scripts/probe-arg-names.mjs` | 探形参名（故意传错让它报） |
| `scripts/inspect-event-shapes.mjs` | 导出真实事件形状 |
| `test/e2e.mjs` | 网关端到端（83 项） |
| `test/store-roundtrip.mjs` | 设备存储持久化（11 项） |
