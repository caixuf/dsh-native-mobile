# dsh-mobile-gateway 测试套件对抗性审计报告

**审计者**：verifier（对抗性验证者）
**审计对象**：`packages/dsh-mobile-gateway/test/e2e.mjs`
**审计基线版本**：`test/e2e.mjs` sha256 `7798B7E9F2274C0C9833CEA1DC40F291FC3E8275622A8BD5D9377F51CA892C52`（586 行，46 项断言）
**审计日期**：2026-10-13
**结论摘要**：**测试套件不足以支撑「可以交付」的判断。** 19 个注入缺陷中有 **10 个未被捕获**（假绿率 53%），另发现 **1 个未被任何断言覆盖的真实越权漏洞**（特权闸门可被 `.`/`..` 路径段绕过，已在真实宿主语义下证明）。

---

## 0. 审计方法与环境

### 0.1 被测源码完整性

审计开始前对 6 个源文件做 SHA-256 备份，审计结束后逐一比对，**全部逐字节一致**：

| 文件 | sha256（审计前后一致） |
|---|---|
| `index.mjs` | `12D0A7719A0EA395AB673FB67EA9F8315D734688FFC2DBFDC594C0B3D7342E8F` |
| `lib/bridge.mjs` | `D4240B810ED25066B778E7865BE9127FB6C3F87AC52EEC447CF71B58B910E997` |
| `lib/store.mjs` | `112D5E983818696A646093F9DC91A9921D88E3B623A6F909C1DC00F0B381CBA2` |
| `lib/manage.mjs` | `EDC597DE555D43CC8EA7129ED16308E17D6CAFA7F1BFDF1BEF4C003BDC68F7DF` |
| `lib/http.mjs` | `7B53240C71C00E4530FB14B79871FAEC4CA6F443CA402486BEBB4FE11B9D45A5` |
| `lib/util.mjs` | `46C68940E55D03DA850EDCD0172BB012B8E8F51B317CEFD079AD25CFAB2284FD` |

复核命令与输出：

```powershell
$S = "C:\Users\me\Downloads\aiwork\dsh-native-mobile\packages\dsh-mobile-gateway"
foreach ($f in @('index.mjs','lib\bridge.mjs','lib\store.mjs','lib\manage.mjs','lib\http.mjs','lib\util.mjs')) {
  $live = (Get-FileHash "$S\$f").Hash
  $bak  = (Get-FileHash "C:\Users\me\Downloads\aiwork\_verify_backup\$f").Hash
  "{0,-18} {1}" -f $f, $(if($live -eq $bak){'IDENTICAL'}else{"CHANGED! live=$live bak=$bak"})
}
```
```
index.mjs          IDENTICAL to pre-experiment backup
lib\bridge.mjs     IDENTICAL to pre-experiment backup
lib\store.mjs      IDENTICAL to pre-experiment backup
lib\manage.mjs     IDENTICAL to pre-experiment backup
lib\http.mjs       IDENTICAL to pre-experiment backup
lib\util.mjs       IDENTICAL to pre-experiment backup
ALL SOURCE FILES RESTORED: True
```

### 0.2 为什么用「冻结副本」做突变实验

审计期间 Lead 在并行改写 `test/e2e.mjs`（22 → 29 → 46 → 651 行，哈希持续变化）。为避免
(a) 测量结果随编辑漂移、(b) 我的还原动作清掉 Lead 的改动，我把**包源码 + 测试文件**复制到一个隔离目录
`_verify_backup/pinned/`，用 junction 复用 `node_modules`，所有突变只作用于副本：

```powershell
node _verify_backup/pin.mjs
cmd /c mklink /J "...\_verify_backup\pinned\node_modules" "...\packages\dsh-mobile-gateway\node_modules"
```

```
PINNED SOURCES COPIED TO: ...\_verify_backup\pinned
  index.mjs       12d0a7719a0ea395
  lib/bridge.mjs  d4240b810ed25066
  lib/store.mjs   112d5e983818696a
  lib/manage.mjs  edc597de555d43cc
  lib/http.mjs    7b53240c71c00e45
  lib/util.mjs    46c68940e55d03da
  test/e2e.mjs    7798b7e9f2274c0c
  test lines      651
```

副本基线：`结果：46 通过 / 0 失败`，exit 0。

> **判定契约**：`test/e2e.mjs` 末尾是 `if (failed) process.exit(1); process.exit(0);`。
> 因此**退出码是权威的红/绿信号**，打印的计数是次要的。
> （我第一版 harness 误用 `spawnSync().exitCode`，该字段恒为 `undefined`，导致 19 个突变全被误判为 RED；
> 改用 `.status` 后得到真实矩阵。记录于此以免后人重踩。）

---

## 1. 三次指定篡改实验（实际命令与输出）

统一执行：

```powershell
$node = "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node "C:\Users\me\Downloads\aiwork\_verify_backup\tamper_pinned.mjs" all
```

### 实验 1：把 `path: '/mobile-gateway'` 改回 `'/mobile-gateway/'`

```
EXPERIMENT 1-prefix-trailing-slash
  index.mjs: path -> "/mobile-gateway/" (the original real-world bug)
  exit=1  tally=null/null  =>  RED
  restored: CLEAN
```
测试在 `mint 失败：HTTP 404` 处抛异常中止（先输出 `FAIL prefix 路由的 path 不带尾部斜杠`）。
**变红 ✅** —— 这一条修好了。

### 实验 2：清空特权名单 `PRIVILEGED_METHODS`

```
EXPERIMENT 2a-clear-PRIVILEGED_METHODS
  exit=1  tally=46 passed / 3 failed  =>  RED
  restored: CLEAN
    FAIL host.pickDirectory 被精确名单拒绝(403) status=200
    FAIL host.openPath 被精确名单拒绝(403) status=200
    FAIL llm.discoverModels 被精确名单拒绝(403) status=200
```
**变红 ✅**（在**修复后**的测试版本上）。

> ⚠️ **这条曾经是假绿**。修复前的 22 项版本，清空 `PRIVILEGED_METHODS` 后**仍然全绿**，
> 因为 `settings.*` / `credentials.*` 被 `PRIVILEGED_PREFIXES` 兜住了 —— 两道闸互为掩护，
> 那张精确名单从未被真正覆盖。Lead 补的 3 条「只可能被精确名单拦住」的断言（`host.pickDirectory`、
> `host.openPath`、`llm.discoverModels`，均不在任何前缀之下）堵上了这个洞。已确认修复有效。

补充对照：

```
EXPERIMENT 2b-clear-PRIVILEGED_PREFIXES   exit=1  45/1  RED   (settings.openDocument 被前缀闸门拒绝)
EXPERIMENT 2c-clear-whole-gate            exit=1  39/10 RED
```

### 实验 3：把 `store.verify()` 改成永远返回一个设备

```
EXPERIMENT 3-verify-always-device
  exit=1  tally=43 passed / 3 failed  =>  RED
  restored: CLEAN
    FAIL 伪造令牌 → 401
    FAIL 错误令牌无法升级 WS opened
    FAIL 吊销后立即失效
```
**变红 ✅**

### 1.4 三次实验结论

三次指定篡改**全部变红**，无一是假绿。但这远不足以证明套件可信 —— 见第 2 节。

---

## 2. 【最高严重度】未被任何断言覆盖的真实漏洞：特权闸门可被 `.`/`..` 路径段绕过

### 2.1 漏洞机理（三个事实叠加）

**事实 A**：`index.mjs:159` 用原始 `req.url` 切出 pathname，而 DSH 宿主在 `dsh-host-webserver/lib/index.js`
里是**先做 WHATWG 归一化再匹配路由**（见 §3.1 的 `new URL(req.url ?? "/", "http://x").pathname`），
所以 `..` 会先被折叠掉。

**事实 B**：`index.mjs:200-201` 把 pathname 切片后交给桥：

```js
if (pathname.startsWith(API_PREFIX)) {
  await bridge.handleApi(req, res, pathname.slice(API_PREFIX.length - 1));
}
```

**事实 C**：`lib/bridge.mjs:109` 的 `method` 直接取这条**未归一化**的字符串，然后 `isDenied(method)`
只做「精确集合命中 + 前缀 startsWith」；而 `lib/bridge.mjs:130` 用它构造上游 URL 时，
`new Request()` **会再次归一化**：

```js
const method = apiPath.replace(/^\/+/, '');
if (isDenied(method)) { /* 403 */ }
const upstream = new Request(`http://127.0.0.1/api/${method}`, { ... });
```

于是**闸门看到的字符串 ≠ 宿主最终执行的端点**。

### 2.2 归一化证明

```powershell
$node _verify_backup\normalize_proof.mjs
```
```
request target                                gatewayMethod                 DENIED?  upstreamURL(after new Request)
------------------------------------------------------------------------------------------------------------
/mobile-gateway/api/settings.describe         settings.describe             true     /api/settings.describe
/mobile-gateway/api/./settings.describe       ./settings.describe           false    /api/settings.describe
/mobile-gateway/api/x/../settings.describe    x/../settings.describe        false    /api/settings.describe
/mobile-gateway/api/./credentials.set         ./credentials.set             false    /api/credentials.set
/mobile-gateway/api/./pluginManager.install   ./pluginManager.install       false    /api/pluginManager.install
```

`new Request()` 的归一化行为（`_verify_backup/req_norm.mjs`）：

```
method="settings.describe"     -> request.url = http://127.0.0.1/api/settings.describe
method="./settings.describe"   -> request.url = http://127.0.0.1/api/settings.describe   <-- 归一化！
method="x/../settings.describe"-> request.url = http://127.0.0.1/api/settings.describe   <-- 归一化！
method="/settings.describe"    -> request.url = http://127.0.0.1/api//settings.describe
```

### 2.3 端到端越权证明（上游桩**忠实复刻**真实宿主）

上游桩逐行复刻 `@deepseek-ai/dsh-client-connection/lib/index.js` 的 `rpcFetchHandler` +
`endpointFromPath`（含分段校验、`message.method !== endpoint` 拒绝、以及真实的方法分发），
并记录**究竟哪个方法真的抵达了宿主处理器**：

```powershell
$node _verify_backup\bypass_proof.mjs
```
```
Request target                                      gateway   hostExecuted                      PRIVILEGED LEAK?
------------------------------------------------------------------------------------------------------------------------
control: normal privileged path                     403       (never reached host)              no
control: normal allowed path                        200       session.list                      no
BYPASS: leading ./                                  200       settings.describe                 *** YES — PRIVILEGED METHOD EXECUTED
BYPASS: x/../                                       200       settings.describe                 *** YES — PRIVILEGED METHOD EXECUTED
BYPASS: credentials.set via ./                      200       credentials.set                   *** YES — PRIVILEGED METHOD EXECUTED
BYPASS: pluginManager.install via ./                200       pluginManager.install             no
BYPASS: host.pickDirectory via x/../                200       host.pickDirectory                *** YES — PRIVILEGED METHOD EXECUTED
BYPASS: llm.discoverModels via ./                   200       llm.discoverModels                *** YES — PRIVILEGED METHOD EXECUTED

privileged methods that reached the host via a bypass: 5
CONFIRMED: the gateway deny-list is bypassable with "." / ".." path segments.
```

**一个已配对（本应受限）的手机，可以用 `POST /mobile-gateway/api/./credentials.set` 之类请求，
把被设计为「仅本机回环」的特权面完整打开** —— 包括 `credentials.set`（改写凭据）、
`host.pickDirectory` / `host.openPath`（本机文件系统探测）、`llm.discoverModels`。

### 2.4 真实宿主可复现性

同一归一化也作用于宿主路由匹配，已在运行中的 DSH 上实测：

```powershell
$node _verify_backup\probe_dot.mjs
```
```
/bot-gateway/./x                         | HTTP/1.1 404 Not Found   | bodyLen=19 <= HANDLER RAN
/x/../bot-gateway                        | HTTP/1.1 200 OK          | bodyLen=65456 <= HANDLER RAN
/bot-gateway/a/../b                      | HTTP/1.1 404 Not Found   | bodyLen=19 <= HANDLER RAN
/bot-gateway/./                          | HTTP/1.1 200 OK          | bodyLen=65456 <= HANDLER RAN
/bot-gateway/x/../../bot-gateway         | HTTP/1.1 200 OK          | bodyLen=65456 <= HANDLER RAN
```

（判别法：未命中路由 → 宿主兜底 404 且 **body 长度 0**；命中路由 → 处理器运行，body 非空。）

### 2.5 测试为何抓不到

审计基线 `test/e2e.mjs` 中 **完全没有任何** `.`/`..`/`%2E`/`%2F` 变体请求：

```powershell
Select-String -Path ...\pinned\test\e2e.mjs -Pattern '\./|%2E|%2F|\.\./'
```
```
  line 15: import { DeviceStore } from '../lib/store.mjs';      <- 只是 import 路径
  line 16: import { createBridge } from '../lib/bridge.mjs';
  ...
  （没有任何一处是发给网关的请求目标）
```

**复现步骤**：`node _verify_backup\bypass_proof.mjs`（自包含，不需网络、不需 DSH 在跑）。

### 2.6 其他绕过变体的实测结果

同一 harness（`_verify_backup/bypass_test.mjs`）已穷举 Lead 关心的变体：

```
variant                                             status  reachedHost  verdict
baseline DENIED  settings.describe                  403     no           blocked
baseline ALLOWED session.list                       200     YES(session.list)
CASE UPPER (SETTINGS.DESCRIBE)                      200     YES(SETTINGS.DESCRIBE)   <<< REACHED HOST
CASE Mixed (Settings.Describe)                      200     YES(Settings.Describe)   <<< REACHED HOST
LEADING SLASH  (/api//settings.describe)            403     no           blocked
TRAILING SLASH (settings.describe/)                 403     no           blocked
DOT SEGMENT (./settings.describe)                   200     YES(settings.describe)   <<< REACHED HOST  ← 已证实越权
DOTDOT SEGMENT (x/../settings.describe)             200     YES(settings.describe)   <<< REACHED HOST  ← 已证实越权
URL-ENC %2E (settings%2Edescribe)                   200     YES(settings%2Edescribe) blocked upstream
URL-ENC %73 (%73ettings.describe)                   200     YES(%73ettings.describe) blocked upstream
SPACE (settings.describe%20)                        403     no           blocked
PREFIX bypass settingsXdescribe                     200     YES(settingsXdescribe)   blocked upstream
```

- **大小写变体（`SETTINGS.DESCRIBE`）**：网关放行，但上游方法注册表按精确名查找，
  `SETTINGS.DESCRIBE` 不会命中 `settings.describe`，故**未构成越权**。
  **但这是一个脆弱的隐式依赖**：网关的拒绝判定是大小写敏感的，而它把安全性押在「上游恰好大小写敏感」上。
  若将来上游做规范化或存在别名，此路即通。**建议网关自行做大小写归一化后再判定。**
- **URL 编码变体**：网关放行，但编码串不匹配 `ENDPOINT_SEGMENT_PATTERN` 之外的端点注册，
  上游 404/拒绝，**未构成越权**。
- **前导/尾随斜杠、空白**：被网关自身 `replace(/^\/+/)` 或路径校验挡下，**未构成越权**。

---

## 3. Lead 指定优先项的逐条回答

### 3.1 匹配语义是否忠实复刻 DSH？——**是（且已拿到权威源码）**

权威来源（从 `app.asar` 提取，`@deepseek-ai/dsh-host-webserver/lib/index.js`，**原文带行号**）：

```
 322 | 	/** Longest-prefix-wins over the prefix table after an exact-table miss. */
 323 | 	match(pathname) {
 324 | 		const exact = this.exact.get(pathname);
 325 | 		if (exact !== void 0) return exact;
 326 | 		let best;
 327 | 		for (const [prefix, route] of this.prefixes) {
 328 | 			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
 329 | 			if (best === void 0 || prefix.length > best.path.length) best = route;
 330 | 		}
 331 | 		return best;
 332 | 	}
```

以及调用点的归一化（同文件，`Service.init`）：

```js
const rawPath = new URL(req.url ?? "/", "http://x").pathname;
const route = this.match(rawPath);
```

测试里的 `matchesRoute`：

```js
function matchesRoute(route, pathname) {
  if (route.kind === 'exact') return route.path === pathname;
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}
```

**逐项比对**：

| 行为 | 真实 `match()` | 测试 `matchesRoute` | 一致？ |
|---|---|---|---|
| exact 命中 | `exact.get(pathname)` | `route.path === pathname` | ✅ |
| prefix 自身 | `pathname !== prefix` → 命中 | `pathname === route.path` | ✅ |
| prefix 子路径 | `pathname.startsWith(`${prefix}/`)` | 同 | ✅ |
| 带尾斜杠的 prefix | `'/x/'` 只匹配 `'/x/'` | 同 | ✅ |
| longest-prefix-wins | `prefix.length > best.path.length` | `routes.find(...)`（**注册顺序**） | ⚠️ 见下 |
| URL 归一化 | `new URL(req.url).pathname` | `(req.url ?? '/').split('?')[0]`（**不归一化**） | ❌ **不一致** |

**关于 longest-prefix-wins**：插件当前只注册 **一条** prefix 路由（`index.mjs:147-215`），
所以 longest-prefix-wins 在**今天**无影响 —— 这一点我明确确认。
**但它不是真风险为零**：测试用 `routes.find()` 取**第一个**匹配者，真实宿主取**最长**者。
两者只在「存在互相嵌套的 prefix」时分歧。当前不触发，属**潜在**差异，非当前假绿。

**❌ 真正的不一致是 URL 归一化**：测试桩用 `split('?')[0]` 得到**未归一化**的 pathname，
真实宿主用 `new URL().pathname` 得到**已归一化**的 pathname。
方向上是「桩比现实更宽松」，正是 §2 那个越权漏洞的温床 —— 测试桩永远看不到 `..` 折叠。
**这是本报告第 2 号假绿（与第 1 号同源，但独立成立）**。

### 3.2 桩是否比现实宽松？

| 桩 | 现实 | 差异 | 严重度 |
|---|---|---|---|
| `fakeWebServer.register` 只把路由塞进数组 | 真实 `register` 对重复 `(kind,path)` **抛错**；`registerUpgrade` 对重复 path 抛错 | 桩接受真实会拒绝的注册 | 中（掩盖路由冲突） |
| 测试桩 `split('?')[0]` 取 pathname | `new URL(req.url).pathname`（**归一化 `..`**） | **桩更宽松 → 掩盖越权** | **高** |
| 测试桩用 `routes.find()` | `match()` 取 longest-prefix-wins | 顺序依赖 vs 最长优先 | 低（当前单路由） |
| `fakeApiFetch` 只按 URL 路径名取 method，**从不校验 envelope 的 `method` 字段** | 真实 `rpcFetchHandler` 强制 `message.method === endpoint`，否则 `gateway/bad-request` | 桩更宽松（可掩盖信封/路径不一致） | 中 |
| `fakeApiFetch` 对任何方法都返回 200 或固定 payload | 真实宿主有方法注册表，未注册方法 404 | 桩更宽松 | 中 |
| `fakeWireStream.open()` 对 `endpoint` 参数**不做任何校验**，永远推 3 帧 | 真实 `wireStream.open(endpoint,…)` 只对已知端点工作 | **桩更宽松 → 掩盖端点写错** | **高**（见 §4 实验 5） |
| `fakeCtx.connection.operator` | 真实 operator peer 携带身份/信任上下文 | 桩是常量 | 低 |
| `fakePluginCtx.inject` 直接 `callback(this)` | cordis 的 `inject` 有服务就绪时序与参数解析语义 | 桩绕过了时序（曾因此掩盖过 `Cannot read properties of undefined`） | 中 |

### 3.3 断言是否在测行为而非实现？

**发现 1 处「复述被测常量」的循环依赖（Lead 已修复）**：
旧桩用 `PRIVILEGED_METHODS.includes(method)` 判断是否记录泄漏 —— 常量被改坏时**桩跟着变**，
泄漏检测同时失效。现已改为硬编码 `PRIVILEGED_BASELINE`，故意不从被测代码导入。**确认修复有效**。

**其余断言基本都在测行为**（真实 HTTP/WS 往返、真实 `apply()` 注册的路由、真实状态变更）。
但存在**大量恒真/形同虚设**的断言，见 §4。

### 3.4 关键路径漏测清单

| 路径 | 测试是否覆盖 | 证据 |
|---|---|---|
| 特权闸门绕过变体（`.`,`..`,`%2E`,`大小写`） | ❌ **无** | §2.5 |
| 管理面非回环闸门 | ⚠️ **有，但会静默跳过** | §5.1 |
| WS 鉴权失败是否**未完成握手** | ✅ 有（真实 101 vs 403/401） | §5.2 |
| `/api/respond` 桥接 | ⚠️ 有，但桩的 `respond` 契约与真实不同 | §5.3 |
| `rotate`（重置令牌） | ❌ **零覆盖** | `Select-String 'rotate'` → 0 次 |
| `/manage` HTML 页面 | ❌ **零覆盖** | `sendHtml` 0 次 |
| 请求体上限 32 MiB → 413 | ❌ **零覆盖** | `MAX_BODY`/`413` 均 0 次 |
| `Sec-WebSocket-Protocol` 拒绝 | ❌ **零覆盖** | `sec-websocket-protocol` 0 次 |
| 下行通道收到上行数据 → 1008 关闭 | ❌ **零覆盖** | `1008` 0 次 |
| 令牌过期（`expiresAt`） | ❌ **零覆盖** | `expiresAt` 0 次 |
| `pair` 响应契约（`apiPrefix`/`events`/`instance`） | ❌ **零覆盖** | `apiPrefix` 0 次 |

### 3.5 `/api/respond`（Lead 标记为高风险）—— **语义未错位，但测试的桩与真实契约不同**

实测（`_verify_backup/ws_respond.mjs`，上游桩复刻真实宿主分发）：

```
=== (b) /mobile-gateway/api/respond bridging ===
POST /mobile-gateway/api/respond -> HTTP 200
  response body : {"type":"server-response","rpcId":"rp-1","result":{"ok":true,"value":{"kind":"allow"}}}
  host reached  : {"endpoint":"respond","payload":{"requestId":"abc","decision":"allow"}}
  envelope forwarded verbatim: YES

=== (b2) the official /api/respond on the LIVE DSH ===
  POST http://127.0.0.1:19387/api/respond -> 401 (401 = route exists behind auth)
```

**判断**：`respond` 走的是普通 `/api/<method>` 桥，`endpointFromPath('/api', '/api/respond')`
返回 `'respond'`，与路径段一致；网关的 `method = 'respond'` 也不在拒绝名单内，**透传语义正确、未错位**。
真实宿主上 `/api/respond` 返回 401（路由存在，仅在鉴权之后），说明该端点确实存在于 `/api` 前缀下。

**但测试有一处保真度问题**：测试桩 `fakeApiFetch` 里对 `respond` 返回
`{ accepted: true } | { accepted: false, reason: 'bad-response' }`，而项目自己的契约文档
`docs/api-contract.md:129-134` 与测试断言的**响应**是
`{ type:'server-response', rpcId, result:{ok:true,value:{kind:'allow'}} }`。
两者形状不同 —— 桩把 `accepted` 塞进了 `result.value`（`calls.at(-1).body.result.value?.kind === 'allow'`），
这与 `api-contract.md` 里「回执是 `{accepted:true}` 顶层对象」的描述**不一致**。
由于 `/api/respond` 的真实实现在**未下载**的 `@deepseek-ai/dsh-host-apiproxy` 中
（`docs/api-contract.md:443` 自己标注为「未验证」；本机 asar 内确认 `apiproxy` 不存在），
**该端点的真实响应形状无法在本机验证** —— 见 §6。

---

## 4. 完整突变矩阵：19 个注入缺陷，10 个未被捕获

命令：

```powershell
$node = "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node "C:\Users\me\Downloads\aiwork\_verify_backup\tamper_pinned.mjs" all
```

完整输出存于 `_verify_backup/matrix.txt`。矩阵：

| # | 注入的缺陷 | exit | 计数 | 判定 | |
|---|---|---|---|---|---|
| 1 | `path` 改回带尾斜杠（原始真实事故） | 1 | crash | RED | caught |
| 2a | 清空 `PRIVILEGED_METHODS` | 1 | 46/3 | RED | caught |
| 2b | 清空 `PRIVILEGED_PREFIXES` | 1 | 45/1 | RED | caught |
| 2c | 清空两道闸 | 1 | 39/10 | RED | caught |
| 3 | `store.verify()` 无条件放行 | 1 | 43/3 | RED | caught |
| 4 | 管理面回环闸门失效 | 1 | 44/2 | RED | caught |
| **5** | **`events.mux` ↔ `events.host` 端点互换** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **7** | **`Sec-WebSocket-Protocol` 拒绝失效** | **0** | **46/0** | **GREEN** | *** 假绿** |
| 8 | `revoke()` 不再删除设备 | 1 | 44/2 | RED | caught |
| **9** | **`/health` 返回完全错误的契约** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **10** | **`pair` 响应丢掉 `apiPrefix`/`events`/`instance`** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **11** | **`/manage` 页面返回垃圾 HTML** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **12** | **`rotate()` 返回成功但令牌哈希从不改变** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **13** | **令牌过期永不生效** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **14** | **32 MiB 请求体上限被移除（DoS）** | **0** | **46/0** | **GREEN** | *** 假绿** |
| **15** | **`/pair` 不再强制 POST（GET 可铸令牌）** | **0** | **46/0** | **GREEN** | *** 假绿** |
| 16 | WS 升级跳过令牌校验 | 1 | 45/1 | RED | caught |
| 17 | `no_active_code` 由 404 变 403 | 1 | 45/1 | RED | caught |
| **18** | **下行通道收上行数据不再 1008 关闭** | **0** | **46/0** | **GREEN** | *** 假绿** |

**10 / 19（53%）的注入缺陷未被捕获。**

### 4.1 逐条复现步骤（每个都是「改一处 → 跑测试 → 仍然全绿」）

全部通过 `tamper_pinned.mjs` 的命名实验复现，例如：

```powershell
& $node _verify_backup\tamper_pinned.mjs 15-pair-method-check-removed
```
```
EXPERIMENT 15-pair-method-check-removed
  index.mjs: /pair no longer enforces POST
  exit=0  tally=46 passed / 0 failed  =>  GREEN
  restored: CLEAN
```

**最值得注意的三条**：

- **#15 `/pair` 去掉 POST 检查**：GET 请求即可铸设备令牌。测试从不以非 POST 方式请求 `/pair`，
  这条**真实可利用的鉴权面退化**完全无声通过。
- **#13 令牌过期永不生效**：`#prune` 不再剔除过期设备。测试的 `tokenTtlMs` 是 1 小时，
  不可能在测试期间过期，因此这条**安全性断言在结构上无法被触发**。
- **#14 32 MiB 体上限移除**：`readBody` 的整个上限逻辑删掉后测试无感 —— 测试从不发大请求体。

---

## 5. 其他发现

### 5.1 管理面回环断言：**已从「形同虚设」修复，但仍是条件性断言**

**修复前（Lead 原话「我怀疑是假绿」）—— 确认属实**：旧测试只把服务器绑在 `127.0.0.1`，
`remoteAddress` 永远是回环，那条 `x-forwarded-for: 8.8.8.8` 断言**恒真**。
我用独立 harness 证实了它的空洞性：

```powershell
$node _verify_backup\loopback_test.mjs 192.0.2.20
```
```
--- baseline (real sockets, real remoteAddress) ---
loopback source                                host=127.0.0.1        -> HTTP 200  bodyLen=218
NON-loopback source (LAN IP)                   host=192.0.2.20    -> HTTP 403  bodyLen=57

--- the e2e suite's actual [8] probe: XFF header from loopback ---
XFF:8.8.8.8 from loopback socket            -> HTTP 200  (e2e asserts this === 200)

--- does XFF change anything from a non-loopback source? ---
XFF:127.0.0.1 from NON-loopback socket     -> HTTP 403  (spoofed XFF cannot grant access)

VERDICT: loopback=200 non-loopback=403
GUARD WORKS on real sockets.
e2e [8] would still pass if the guard were deleted: YES (vacuous)
```
结论：**守卫本身是正确的**（`req.socket.remoteAddress` 判据可靠，XFF 无法伪造），
但旧断言测不出它。

**修复后**：Lead 已把服务器改为绑 `0.0.0.0`，并用 `os.networkInterfaces()` 找一个非回环 IPv4
真实发起请求。我确认这条修复有效：

```
  测试服务器: 0.0.0.0:60868  回环=http://127.0.0.1:60868  非回环=http://192.0.2.20:60868
[8] 管理面回环闸门
  ok   伪造 XFF 头不影响回环判定
  ok   非回环来源访问管理面被拒(403)
  ok   非回环来源无法铸配对码(403)
  ok   非回环仍可访问配对端点(应 403 码不匹配而非被闸门拦)
```

**但残留一个真问题：这些断言会静默跳过。** 它们包在 `if (lanBase)` 里（`test/e2e.mjs:516`），
`lanBase` 在找不到非回环网卡时为 `null`，此时只打印一句
`（无可用非回环网卡，跳过非回环验证）` 就继续，**断言数从 46 掉到 43，退出码仍是 0**。
在锁死的 CI runner / 容器里（只有 `lo`），**整个回环闸门回归就等于不存在**。
我构造了「无 LAN 网卡」的变体并实测：

```powershell
$node _verify_backup\nolan_guard.mjs
```
```
INJECTED: lib/manage.mjs loopback guard disabled (pinned copy only)

### host WITH a non-loopback NIC
    exit=1  tally=44/2  => RED
    | FAIL 非回环来源访问管理面被拒(403) status=200（来源 192.0.2.20）
    | FAIL 非回环来源无法铸配对码(403) status=200

### host WITHOUT a non-loopback NIC (CI / locked-down)
    exit=0  tally=43/0  => GREEN
    | 测试服务器: 0.0.0.0:61529  回环=http://127.0.0.1:61529  非回环=(无可用网卡)
    | （无可用非回环网卡，跳过非回环验证）

RESULT: guard deleted -> suite is RED on a LAN host, GREEN on a no-LAN host.
=> The loopback assertions SILENTLY SKIP when no non-loopback NIC exists.
```

**把回环守卫整个删掉，在一台没有非回环网卡的机器上测试依然全绿（exit 0）。**
**建议**：找不到非回环网卡时应 `check(...)` 失败或至少显著告警，而不是静默降级。

### 5.2 WS 鉴权失败：**确实没有完成握手**（Lead 的问题 3，已证实）

用原始 socket 直接看 HTTP 响应（`_verify_backup/ws_respond.mjs`）：

```
=== (a) WebSocket upgrade handshake, raw HTTP response ===

valid token                    -> HTTP/1.1 101 Switching Protocols HANDSHAKE COMPLETED (101)
wrong token                    -> HTTP/1.1 403 Forbidden     handshake REJECTED
                                  body: {"error":{"code":"invalid_token",...}}
no token                       -> HTTP/1.1 401 Unauthorized  handshake REJECTED
                                  body: {"error":{"code":"unauthorized",...}}
valid token + subprotocol      -> HTTP/1.1 400 Bad Request   handshake REJECTED
                                  body: {"error":{"code":"no_subprotocol",...}}
```

失败路径走的是 `rawReject()`（`lib/bridge.mjs:49-59`），直接写 `HTTP/1.1 403/401/400` 再
`socket.destroy()`，**从不调用 `wss.handleUpgrade`** —— 因此**没有 101，握手确实未完成**，
不存在「先升级再关闭」。**这条断言是真实的、非空洞的**。

### 5.3 `/api/respond`：见 §3.5（语义未错位；桩的响应形状与文档不一致；真实实现未下载）

---

## 6. 明确「无法验证」的项

1. **`@deepseek-ai/dsh-host-apiproxy` 的真实行为**：本机 asar 内不存在该包
   （`asar.mjs list apiproxy` → `[total 0]`），`docs/api-contract.md:443` 亦自述「未下载」。
   因此 `/api/respond` 的**真实响应形状**（`{accepted:true}` 顶层 vs `result.value`）
   无法在本机验证。我实测到的只是「网关把信封原样透传到上游」这一层。
2. **DSH 官方那份「仅回环」特权名单的权威内容**：我在 asar 内检索
   `loopback-only` / `privilegedMethods` / `host.pickDirectory` 的注册处，**未找到**该名单的定义
   （`find_priv.mjs` 对 `host\.describe`、`host\.pickDirectory` 等返回 `[total match sites: 0]`）。
   故**无法验证** `lib/bridge.mjs` 里那份名单是否与官方完全一致（是否漏项）。
   我**不**据此判断名单有误 —— 只能说本机证据不足。
3. **上游方法注册表是否大小写敏感**：§2.6 里 `SETTINGS.DESCRIBE` 未构成越权，
   是基于我的**忠实复刻桩**（按精确名查找）。真实注册表未能直接读到，
   所以「大小写变体安全」这一结论**依赖复刻的正确性**，未获独立佐证。
4. **真机（Android App）侧行为**：本次审计全部在 Node 进程内 + 运行中的 DSH 上完成，
   未在真机 App 上验证。
5. **longest-prefix-wins 的长期风险**：当前只注册一条 prefix 路由，**今天无影响**（已确认）；
   但若未来新增嵌套 prefix，测试的 `routes.find()` 会与真实 `match()` 分歧。此为**前瞻性风险**，
   非当前可复现的假绿。

---

## 7. 【集成级】交付态与测试态不一致：**测试绿 ≠ 真机能用**

这一条超出「测试假绿」的字面范围，但直接决定「能否交付」，必须报告。

**实测：运行中的 DSH（`http://127.0.0.1:19387`，PID 31572，监听 `0.0.0.0:19387`）
对全部 `/mobile-gateway` 路由返回空体 404。**

```powershell
$node _verify_backup\probe.mjs
```
```
/bot-gateway                       | HTTP/1.1 200 OK          | body=65456  <= handler ran
/bot-gateway/                      | HTTP/1.1 200 OK          | body=65456
/bot-gateway/anything              | HTTP/1.1 404 Not Found   | body=19     <= handler ran (插件自己的 404)
/bot-gatewayXYZ                    | HTTP/1.1 404 Not Found   | body=5      <= NO ROUTE MATCHED
/mobile-gateway/health             | HTTP/1.1 404 Not Found   | body=5      <= NO ROUTE MATCHED
/mobile-gateway/manage             | HTTP/1.1 404 Not Found   | body=5      <= NO ROUTE MATCHED
```

判别法（本次事故的签名）：**宿主兜底 404 的 body 长度是 0**（`res.writeHead(404); res.end()`），
插件自己的 404 带 JSON（`/bot-gateway/anything` → body 19）。运行中的 `/mobile-gateway/*`
全部是**空体 404 = 没有任何路由命中**。

**时间线（为何如此）**：

| 事件 | 时间 |
|---|---|
| 占用 19387 的 DSH 进程启动（PID 31572） | 2026-10-13 **09:50:58** |
| 插件 `applying` → `mobile gateway ready` | 09:51:00 → 09:51:02 |
| `index.mjs` 尾斜杠修复写入磁盘 | 2026-10-13 **09:54:44** |

修复**比进程启动晚约 3.5 分钟**，进程已把旧的（带尾斜杠）版本载入内存，
**插件源码修好但没有重启生效** —— 与任务描述一致。当前 `git status` 显示
`index.mjs` 已随提交 `888db37` 落库，因此这**不是**代码问题，而是**运行态未刷新**。

**为何这仍然重要**：`test/e2e.mjs` 通过 `import('../index.mjs')` 直接从**源码树**加载，
它**永远看不到**「DSH 实际加载的是哪一份拷贝」。真实加载路径是
`C:\Users\me\.dsh\profiles\desktop\node_modules\dsh-mobile-gateway\`
（其自身的崩溃栈印证：`.../profiles/desktop/node_modules/dsh-mobile-gateway/index.mjs:109`）。
当前这份拷贝恰好与仓库一致（sha256 `12D0A771…`），所以**重启后应该能工作**；
但测试套件**在结构上无法发现「拷贝过期」或「插件根本未激活」**这类故障 ——
而这恰恰是本次事故里「18 项断言全绿、真机全 404」的同一类失效。

**建议**：交付前必须加一条**独立于测试套件**的验收：对运行中的 DSH 发真实请求并检查
`/mobile-gateway/health` 返回 200 且 body 非空（空体 404 即为未命中）。这条不能靠 `e2e.mjs`。

---

## 8. 严重度排序汇总

| # | 严重度 | 发现 | 状态 |
|---|---|---|---|
| 1 | 🔴 **严重** | 特权闸门可被 `./`、`x/../` 绕过，5 个特权方法（含 `credentials.set`）真实抵达宿主 | **未修复**，无任何断言覆盖 |
| 2 | 🔴 **严重** | 测试桩用 `split('?')[0]` 而非 `new URL().pathname`，**永不归一化 `..`** —— 是 #1 无法被发现的直接原因 | **未修复** |
| 3 | 🔴 **严重** | 回环闸门断言在无非回环网卡时**静默跳过**；删掉守卫仍 exit 0 | **未修复**（断言已改真，但跳过逻辑仍在） |
| 4 | 🟠 高 | 10/19 注入缺陷未被捕获（`/pair` 不校验 POST、令牌过期失效、32 MiB 上限移除、`rotate` 空转、`/manage` 页面损坏、`/health` 契约损坏、`pair` 响应丢字段、端点互换、1008 语义丢失） | **未修复** |
| 5 | 🟠 高 | 运行中的 DSH 对全部 `/mobile-gateway` 路由返回空体 404（插件已修但**未重启生效**） | **待重启验证** |
| 6 | 🟡 中 | 桩不校验 envelope 的 `method` 字段，真实宿主强制 `method === endpoint` | 未修复 |
| 7 | 🟡 中 | 桩的 `fakeWebServer.register` 不实现「重复路由抛错」 | 未修复 |
| 8 | 🟡 中 | 网关拒绝判定大小写敏感，安全性隐式依赖上游大小写敏感 | 未修复（当前未构成越权） |
| 9 | 🟢 已修复 | 清空 `PRIVILEGED_METHODS` 曾全绿（两道闸互为掩护） | ✅ 已补断言，实测变红 |
| 10 | 🟢 已修复 | 旧桩用被测常量 `PRIVILEGED_METHODS` 判断泄漏（循环依赖） | ✅ 已改硬编码基线 |
| 11 | 🟢 已修复 | 管理面回环断言曾恒真（只绑 127.0.0.1） | ✅ 已改绑 0.0.0.0 + 真实 LAN IP |
| 12 | 🟢 已修复 | 尾斜杠 prefix 回归 | ✅ 实测变红 |
| 13 | 🟢 已修复 | `store.verify()` 无条件放行 | ✅ 实测变红 |

---

## 9. 结论：**这个测试套件不足以支撑「可以交付」的判断**

**理由（按权重）**：

1. **存在一个未覆盖的真实越权漏洞。** 特权闸门可被 `.`/`..` 路径段绕过，
   已配对设备能执行 `credentials.set`、`host.pickDirectory`、`llm.discoverModels`
   等被设计为「仅本机回环」的方法（§2.3，端到端证明）。测试套件里**没有任何一条断言**
   触及路径归一化。这是**安全缺陷**，不是测试瑕疵。

2. **假绿率 53%（10/19）。** 注入的 19 个真实缺陷里 10 个让测试保持全绿且 exit 0，
   包括 `/pair` 不校验 HTTP 方法（可铸令牌）、令牌过期永不生效、请求体上限移除这类
   **安全/健壮性回归**。一个能放过「删掉整段上限校验」的套件，不具备回归防护能力。

3. **一条关键断言会静默跳过。** 回环闸门（铸配对码的入口，即完全控制凭据的种子）
   在无 LAN 网卡的机器上**整个不测**，且退出码仍为 0。把守卫删掉，CI 上依然全绿。

4. **测试通过 ≠ 交付可用。** 运行中的 DSH 此刻对 `/mobile-gateway/*` 全部返回空体 404。
   测试从源码树直接 `import`，**结构上无法**发现「加载的拷贝过期」或「插件未激活」——
   而这正是本次事故的失效形态。

**可以交付的最低门槛（建议）**：

- **P0**：修掉 §2 的路径归一化越权（网关侧对 `method` 做与宿主一致的归一化后再判定；
  或直接拒绝任何含 `.`/`..`/空段/百分号编码的路径），并补一组断言。
- **P0**：测试桩改用 `new URL(req.url, 'http://x').pathname` 复刻宿主归一化。
- **P0**：回环断言在无非回环网卡时**必须失败**，不得静默跳过。
- **P1**：补齐 §4 中 10 条未被捕获路径的断言（至少 `/pair` 方法校验、令牌过期、
  请求体上限、`rotate`、`/health` 与 `pair` 的响应契约、`1008` 语义）。
- **P1**：桩补上 envelope `method === endpoint` 校验与重复路由抛错。
- **P1**：加一条**独立于 e2e** 的运行态验收：重启 DSH 后请求 `/mobile-gateway/health`，
  断言 200 且 body 非空（空体 404 = 路由未命中）。

**已确认修复且我实测变红的部分**（可放心）：尾斜杠 prefix、`store.verify()` 放行、
两道特权闸各自的覆盖、管理面回环判据本身、WS 握手确实未完成、`/api/respond` 透传语义未错位。

---

## 附录 A：审计产物清单（均只读，未改动被测源码）

| 路径 | 用途 |
|---|---|
| `_verify_backup/pin.mjs` | 构建冻结副本 |
| `_verify_backup/tamper_pinned.mjs` | 19 项突变矩阵（权威红/绿判定用 `.status`） |
| `_verify_backup/matrix.txt` | 矩阵完整输出 |
| `_verify_backup/bypass_proof.mjs` | 越权端到端证明（复刻真实宿主分发） |
| `_verify_backup/bypass_test.mjs` | 19 种绕过变体穷举 |
| `_verify_backup/normalize_proof.mjs` | URL 归一化机理证明 |
| `_verify_backup/req_norm.mjs` | `new Request()` 归一化实测 |
| `_verify_backup/loopback_test.mjs` | 真实非回环 socket 验证守卫 |
| `_verify_backup/nolan_guard.mjs` | 「无 LAN 网卡时静默跳过」证明 |
| `_verify_backup/ws_respond.mjs` | WS 握手 + `/api/respond` 实测 |
| `_verify_backup/probe.mjs` | 运行中 DSH 路由探测（空体 404 判别） |
| `_verify_backup/probe_dot.mjs` | 真实宿主 `..` 归一化实测 |
| `_verify_backup/probe_api.mjs` | 运行中 `/api` 路由存在性探测 |
| `_verify_backup/asar.mjs` / `g.mjs` / `slice.mjs` / `match_src.mjs` | asar 提取（权威 DSH 源码） |
| `_verify_backup/find_priv.mjs` | 官方特权名单检索（结果：未找到） |

## 附录 B：权威源码提取方法

```powershell
$node = "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node _verify_backup\match_src.mjs          # match() 原文 + 行号
& $node _verify_backup\asar.mjs cat "dsh-host-webserver/lib/index.js"
```

asar 头布局（本机实测）：`u32@0 = 4`，`u32@8 = JSON 长度`，JSON 自偏移 16 起，
且 **JSON 长度字段不精确**，必须用花括号配对（含字符串/转义处理）确定真实结尾。


---

# 附录 C：Lead 的处置与修正（2026-10-13）

> 本节由 Lead 追加，逐条回应本报告的发现，并**修正其中一处结论的边界**。

## C.1 你报告的绕过漏洞：机理成立，但触发条件需要修正

**你的机理分析完全正确**，我独立复现了：

```
new Request("http://127.0.0.1/api/./settings.describe")  →  /api/settings.describe
修复前的 isDenied("./settings.describe")                  →  false（放行）
```

「闸门看到的字符串 ≠ 上游执行的端点」这个判断是准确的。

**但触发条件需要修正**：审计中发现 **Node 的 http server 在请求到达 handler 之前
就已经归一化了 `req.url`**：

```
/a/./b     → req.url = "/a/b"
/a/x/../b  → req.url = "/a/b"
/a/%2e/b   → req.url = "/a/b"
/a//b      → req.url = "/a//b"     ← 双斜杠保留
```

我实测验证：**把闸门退回有漏洞的旧版，e2e 的 56 项断言仍然全绿** ——
因为 `./settings.describe` 到我们手里时已经变成 `settings.describe`。

所以更精确的结论是：**这条路径在真实 DSH 上被宿主先拦了**（返回 404 not found），
不是被闸门拦。我用**原始 socket 手写请求行**对真实实例复测确认：

| 变体 | 结局 |
|---|---|
| `settings.describe` | 闸门拦（403 loopback_only） |
| `//settings.describe` | 闸门拦 |
| `SETTINGS/DESCRIBE` | 闸门拦 |
| `./settings.describe` | **宿主**拦（404 not found） |
| `x/../settings.describe` | 宿主拦 |
| `%2e/settings.describe` | 宿主拦 |

**这个区分很重要**：宿主拦同样安全，但**不能依赖它** —— 换一个归一化行为不同的
宿主版本就可能穿透。所以我仍然按你的结论做了修复（纵深防御），
但把「闸门拦住」与「宿主拦住」在断言里分开表达，避免把宿主的功劳记在自己头上。

## C.2 已实施的修复

`lib/bridge.mjs` 的 `normalizeMethod()` 重写为**真正的路径解析**：

- 用 WHATWG URL 折叠 `.` / `..` / 空段（与下游 `new Request()` 行为一致）
- 闸门里先做**多次百分号解码**（防 `%252e` 双重编码）
- 加 fail-closed 兜底：归一化后仍残留点段则一律拒绝

新增门禁 `scripts/verify-gate-raw.mjs`：用原始 socket 手写请求行探测，
这是唯一能测出「客户端预归一化掩盖的差异」的方法。已加入 package.json。

## C.3 你指出的其他问题处置

| 你的发现 | 处置 |
|---|---|
| 桩用裸 `startsWith`，比权威 `match()` 宽松 | 已按 asar 里的 `match()` 原文逐行等价（含 exact 优先 + longest-prefix-wins），并加 6 条断言检验桩语义本身 |
| 假宿主对任意方法名都返回成功 | 已加方法白名单 + 必填参数校验；突变删掉 `session.page` 会红 2 条 |
| 两道闸互为掩护 | 已为每道闸补「只可能被它拦住」的断言 |
| 管理面回环闸门假绿 | 已改为绑 `0.0.0.0`，用真实局域网网卡（192.0.2.20）验证非回环被拒 |

## C.4 补充：本轮还发现了三个你未覆盖的协议级错误

你审计的是**网关测试的可信度**，我在你报告之后拿真实主机做协议取证，
发现 App 的协议层三处全错（与你的审计独立）：

1. endpoint 要用**斜杠**（`session/list`），不是点号（`session.list`）
2. payload 必须包成 `{ args: { … } }`
3. args 键名是**服务端形参名**（`_request` / `request`）

外加一个提权漏洞：特权闸门用点号名单，而请求走斜杠 endpoint，**比对不上直接放行**
（实测 `settings.describe` 成功返回配置内容）。

这些都不在你的审计范围内（你审计的是测试而非 App 协议），一并记录以便完整。

## C.5 关于你的报告本身

你的三条纪律（假宿主必须能拒绝、注意客户端预归一化、区分闸门拦与下游拦）
已被我写进 `docs/test-audit.md` 开头作为结论，并落到具体门禁里。
其中「注意客户端预归一化」这条**我是通过复现你的实验才意识到的**，
它直接改变了修复的验证方式（必须用原始 socket）。

唯一建议：下次报告里若某条结论的**触发条件**依赖环境行为（如宿主是否预归一化），
建议把「机理成立」与「在当前环境可触发」分开陈述 —— 你的 §2 里两者是混在一起的，
我花了额外时间才厘清实际边界。