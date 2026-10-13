# 真机 / 真实环境验证报告

> 验证者：app-tester（独立验证，**未修改任何被测源码**）
> 时间：2026-10-13
> 结论摘要：**没有可用设备**，走静态 + 协议比对 + 真实网关实测三条替代路径。
> 发现 **1 个致命运行态故障**（网关在真实进程里全部 404）与 **3 处协议不一致**（其中 2 处会让 App 主流程直接失败）。

---

## 0. 三类结论速查

| 分类 | 内容 |
|---|---|
| **已验证** | APK 元数据与可安装性；App↔网关**路径**全部一致；两条下行 WS 路径一致；Bearer 鉴权方式一致；信封四形态一致；特权方法闸门（进程内测试）；公网入口白名单生效 |
| **验证失败** | 真实 DSH 进程上 `/mobile-gateway/*` **全部 404**（网关未生效）；`act-as-app` 打真实网关 **0 通过 / 4 失败** |
| **未验证** | 真机安装/启动/扫码配对/进会话/发消息全流程（无设备）；`/api/respond` 服务端 pending 表（项目自身契约也标注 UNVERIFIED）；公网配对全链路（受 404 阻断） |
| **协议不一致（最高优先级）** | ① App 调用 `session.history`，真实主机**没有这个 RPC**（真名 `session.page`）② App 的 `session.prompt` **缺必填 `requestId`** ③ `/api/respond` 应答体形状与契约不符 |

---

## 1. 是否有可用设备

### 1.1 adb 设备列表 —— 无设备

```powershell
& "C:\Users\me\Downloads\android-toolchain\android-sdk\platform-tools\adb.exe" devices -l
```

真实输出：

```
List of devices attached

[stderr]
* daemon not running; starting now at tcp:5037
* daemon started successfully
```

`List of devices attached` 之后为空 —— **没有真机，也没有正在运行的模拟器**。

### 1.2 模拟器镜像 —— 不存在

```powershell
Get-ChildItem "$env:USERPROFILE\.android\avd"        # AVD 目录
Get-ChildItem "$env:USERPROFILE\.android"            # .android 内容
Get-ChildItem "C:\...\android-sdk\system-images" -Recurse -Depth 2
Get-ChildItem "C:\...\android-sdk"                   # SDK 顶层
```

真实输出：

- `$env:USERPROFILE\.android\avd` → **空**（无 AVD）
- `$env:USERPROFILE\.android` → 只有 `adbkey` / `debug.keystore` / `analytics.settings` 等，**没有 avd/**
- SDK 顶层 → `cache  build-tools  cmdline-tools  licenses  platform-tools  platforms  .knownPackages` —— **没有 `emulator/`，也没有 `system-images/`**

即：**本机连模拟器程序（emulator）都没装，更没有系统镜像**，无法创建 AVD。

### 1.3 因此采用的替代手段

1. **APK 可安装性静态验证**（`aapt2 dump badging` + `apksigner verify` + ZIP 完整性）
2. **App↔网关协议逐项比对**（读 Kotlin 源码 vs 网关源码 vs **真实 DSH 宿主 bundle**）
3. **扮演 App 打真实网关**（`packages/dsh-mobile-gateway/scripts/act-as-app.mjs`，路径/信封/鉴权头与 Kotlin 端逐字一致）
4. **真实网关路由实测**（回环 / 局域网 / 公网三个 vantage）
5. **网关自带的进程内 E2E 测试**（`node test/e2e.mjs`）

---

## 2. APK 可安装性（已验证）

### 2.1 包元数据

```powershell
$p="C:\Users\me\Downloads\android-toolchain\android-sdk\build-tools\35.0.0"
& "$p\aapt2.exe" dump badging "...\dist\dsh-mobile-0.1.0-debug.apk"
```

真实输出（节选关键行）：

```
package: name='io.github.dshmobile.app' versionCode='1' versionName='0.1.0' platformBuildVersionName='15' platformBuildVersionCode='35' compileSdkVersion='35' compileSdkVersionCodename='15'
minSdkVersion:'26'
targetSdkVersion:'35'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.ACCESS_NETWORK_STATE'
uses-permission: name='android.permission.CAMERA'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
uses-permission: name='android.permission.VIBRATE'
uses-permission: name='io.github.dshmobile.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
application-label:'DSH 移动端'
application-debuggable
launchable-activity: name='io.github.dshmobile.app.MainActivity'  label='' icon=''
supports-screens: 'small' 'normal' 'large' 'xlarge'
native-code: 'arm64-v8a' 'armeabi-v7a' 'x86' 'x86_64'
```

结论：包名 `io.github.dshmobile.app`、版本 0.1.0 (code 1)、minSdk 26 / targetSdk 35、**四种 ABI 全含**（含 x86_64，理论上模拟器也能装）、有可启动 Activity。**debug 包带 `application-debuggable`（符合预期）。**

release 包同一命令的输出**不含 `application-debuggable`**（已验证），其余字段与 debug 一致。

### 2.2 签名

```powershell
$env:JAVA_HOME="C:\Users\me\Downloads\android-toolchain\jdk17"
& "$p\apksigner.bat" verify --print-certs "<apk>"
```

真实输出（debug 与 release **完全相同**）：

```
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
Signer #1 certificate SHA-256 digest: ec048588221f87bed2001fb792ea86d7817ef67884ba89dd2e50212ec78be63e
  apksigner exit=0
```

> ⚠️ **附带发现（非阻断）**：release 包也是用 **Android Debug 证书**签的，与 debug 包同一张证书。这意味着 release 包不能上架、且与 debug 包**互相覆盖安装**（签名相同，同包名）。属发布卫生问题，不影响本机安装验证。

### 2.3 ZIP 完整性

```
debug : entries=524 OK
release : entries=520 OK
```

两个 APK 都能被正常解压，**无损坏**。

### 2.4 未验证的部分

**安装、启动、扫码、配对、进会话、发消息 —— 全部未验证**，因为没有设备。上述只能证明「包结构合法、能被系统解析」，**不能**证明「装上去能跑」。

---

## 3. 真实环境实测

### 3.1 本机网关地址

DSH webserver 监听在 **19387**（`0.0.0.0`，来自 profile 的 remote-web-ui lan-bind 配置）：

```powershell
Get-NetTCPConnection -LocalPort 19387 -State Listen
```

```
LocalAddress LocalPort OwningProcess
------------ --------- -------------
0.0.0.0          19387         31572
```

PID 31572 命令行确认是 **desktop profile**：

```
"...DeepSeek Harness.exe" --expose-internals "...dsh-desktop-host\lib\index.js" "...app.asar\dsh" C:\Users\me\.dsh\profiles\desktop ...
```

### 3.2 🔴 致命故障：`/mobile-gateway/*` 全部 404

所有命令均带 `--noproxy '*'`（本机全局代理 `127.0.0.1:7897` 会让观测失真）。

```powershell
curl.exe -s -o NUL -w "%{http_code}" --noproxy '*' "http://127.0.0.1:19387/mobile-gateway/health"
```

真实输出（回环 vantage）：

| 方法 | 路径 | 状态 | 响应体长度 |
|---|---|---|---|
| GET | `/mobile-gateway` | 404 | 0 |
| GET | `/mobile-gateway/` | 404 | 87 |
| GET | `/mobile-gateway/health` | 404 | 0 |
| GET | `/mobile-gateway/manage` | 404 | 0 |
| POST | `/mobile-gateway/pair` | 405 | 0 |
| POST | `/mobile-gateway/api/session.list` | 405 | 0 |
| GET | `/bot-gateway`（对照，工作正常） | 200 | 大 HTML |

**关键鉴别证据** —— 响应体：

```
GET /mobile-gateway/health      status=404 len=0    ← 空体 = 宿主兜底 404
GET /mobile-gateway/            status=404 len=87   {"error":{"code":"not_found","message":"no mobile-gateway route for /mobile-gateway/"}}
GET /zzz-nonexistent-xyz        status=404 len=0    ← 不存在的路径，与 health 完全同形
```

`no mobile-gateway route for /mobile-gateway/` 这句**逐字来自 `index.mjs` 的兜底分支**，证明插件**确实在被调用**，但它**只精确匹配 `/mobile-gateway/` 这一条**，所有子路径都落到宿主兜底（空体 404）。

### 3.3 根因定位（已证实）

决定性对照：**局域网（非回环）访问同一路径**，管理面守卫会先应答：

```powershell
curl.exe -s --noproxy '*' "http://192.0.2.20:19387/mobile-gateway/"
```

真实输出：

```
GET http://192.0.2.20:19387/mobile-gateway/  status=403 len=77
{"error":{"code":"loopback_only","message":"管理面只应答回环来源"}}
```

局域网 vantage 下 `/mobile-gateway/` 命中了插件，并且**触发了 `manage.mjs` 的回环守卫**（返回 `loopback_only`）；而 `/mobile-gateway/health` 仍是空体 404。这正是 **prefix 路由 path 写成 `/mobile-gateway/`（带尾斜杠）** 的特征：

- `/mobile-gateway/` → 精确相等 → 命中
- `/mobile-gateway/health` → 需要以 `/mobile-gateway//` 开头 → **永不命中**

**运行进程加载的是修复前的旧模块：**

| 事实 | 值 |
|---|---|
| DSH 进程 31572 启动时间 | **09:50:58** |
| gateway.log `applying` | 01:51:00.798Z = **09:51:00** |
| gateway.log `mobile gateway ready` | 01:51:02.814Z = **09:51:02** |
| 磁盘上 index.mjs 的 mtime（已修复版） | **09:54:44** |
| 修复提交 `888db37` 时间 | **09:56:25** |

真实日志（`C:\Users\me\.dsh\dsh-mobile-gateway\gateway.log`）：

```json
{"timestamp":"2026-10-13T01:51:00.798Z","level":"info","message":"applying","fields":{"version":"0.1.0",...}}
{"timestamp":"2026-10-13T01:51:02.814Z","level":"info","message":"mobile gateway ready","fields":{"instance":"desktop","devices":0}}
```

**结论**：进程在 09:51 启动时加载了**带尾斜杠的旧代码**；09:54:44 磁盘上的文件才被修好。Node 的 ESM 在启动时求值并缓存，**进程不会自动重载**，因此至今仍在跑旧代码。日志里两行都是 `info`（`ready`），**看不出任何异常** —— 属于典型的静默故障。

磁盘上的文件**已经是正确的**（已核对）：

```powershell
Select-String -Path "...\dsh-mobile-gateway\index.mjs" -Pattern "path: '/mobile-gateway"
# 157: path: '/mobile-gateway',     ← 已修复，无尾斜杠
```

且安装副本与工作区副本 **SHA-256 完全一致**（index.mjs / bridge.mjs / manage.mjs / store.mjs / http.mjs / util.mjs 六个文件全部 SAME）。

> **修复动作（未执行，留给 Lead）**：重启 DSH（desktop profile）使新模块生效。**本验证未重启进程，以免干扰其他并行工作。**

### 3.4 扮演 App 打真实网关 —— 0 通过 / 4 失败

```powershell
node packages/dsh-mobile-gateway/scripts/act-as-app.mjs http://127.0.0.1:19387
```

真实输出：

```
目标：http://127.0.0.1:19387

[1] 健康检查
  FAIL GET /mobile-gateway/health 返回 200 status=404
  FAIL 返回体是网关身份 null

[2] 鉴权边界
  FAIL 无令牌调用 /api 返回 401 status=405
  FAIL 伪造令牌返回 401 status=405

[3] 配对 —— 跳过（未提供 --pair-code）

结果：0 通过 / 4 失败
EXIT=-1073740791
```

失败原因**全部**是 3.2 的路由 404/405，**不是**脚本或 App 逻辑问题。（退出时 `Assertion failed: ... uv_async.c` 是 Node 在 Windows 沙箱下的已知退出抖动，发生在所有断言跑完之后，不影响结论。）

> 注：因为 `/mobile-gateway/manage/api/mint` 也是 404/405，**铸码这一步在当前运行态下不可达**，配对全链路（步骤 2–4）无法继续 —— 这正是被 404 阻断的部分。

### 3.5 公网入口

```powershell
curl.exe -sk --noproxy '*' "https://203.0.113.10:2444/mobile-gateway/health"
```

真实输出：

| 路径 | 状态 | 响应体 |
|---|---|---|
| `/mobile-gateway/health` | 404 | **空**（len=0） |
| `/mobile-gateway/` | 404 | `Not Found`（len=9，Caddy） |
| `/api/session.list` | 404 | `Not Found`（Caddy 白名单拦下 ✅） |
| `/mobile-gateway/manage` | 404 | `Not Found`（Caddy 显式拦下 ✅） |

**两个结论**：
1. **FRP 隧道 + Caddy 是通的**：`/mobile-gateway/health` 返回的是**空体** 404（DSH 宿主兜底），而不是 Caddy 的 `Not Found` —— 说明请求**穿透到了家里那台 DSH**。`frpc` 进程确认在跑（PID 16084）。
2. **公网的健康检查也因同一个 404 故障不可用**；Caddy 的路径白名单（`/api`、`manage` 被拦）**按设计生效**。

### 3.6 进程内 E2E 测试 —— 30 通过 / 0 失败（但覆盖不到真实主机）

```powershell
node packages/dsh-mobile-gateway/test/e2e.mjs
```

真实输出（尾部）：

```
[9] 路由命中回归（区分宿主兜底与插件应答）
  ok   health：由插件应答（非宿主兜底）
  ok   pair（无码应被插件拒绝，不是兜底）：由插件应答（非宿主兜底）
  ok   未知子路径应被插件应答：由插件应答（非宿主兜底）

结果：30 通过 / 0 失败
EXIT=0
```

该测试驱动**真实插件源码**、用**真实 HTTP + WS**，只打桩 DSH 宿主服务，是一套质量不错的测试。

> ⚠️ **但它证明不了「App 能跑通」**：它的假宿主对**任意方法名**都返回固定成功应答（`echoed: method`），因此**无法发现** §4 里 `session.history` 不存在这类方法名错误。测试全绿 ≠ App 能用。

---

## 4. App ↔ 网关协议一致性逐项核对表

### 4.1 路径与鉴权 —— **全部一致 ✅**

| # | 项目 | App（Kotlin 常量） | 网关（注册处） | 结论 |
|---|---|---|---|---|
| 1 | 健康检查 | `DshConnection.HEALTH_PATH = "/mobile-gateway/health"` | `index.mjs` `pathname === '/mobile-gateway/health'` | ✅ 一致 |
| 2 | 配对 | `PAIR_PATH = "/mobile-gateway/pair"` | `pathname === '/mobile-gateway/pair'` | ✅ 一致 |
| 3 | RPC 前缀 | `API_PREFIX = "/mobile-gateway/api/"` | `API_PREFIX = '/mobile-gateway/api/'` + `startsWith` | ✅ 一致 |
| 4 | 下行流 mux | `WS_MUX = "/mobile-gateway/events.mux"` | `registerUpgrade path '/mobile-gateway/events.mux'` | ✅ 一致 |
| 5 | 下行流 host | `WS_HOST = "/mobile-gateway/events.host"` | `registerUpgrade path '/mobile-gateway/events.host'` | ✅ 一致 |
| 6 | 应答端点 | `API_PREFIX + "respond"` → `/mobile-gateway/api/respond` | 前缀桥接到 `/api/respond` | ✅ 路径一致 |
| 7 | HTTP 鉴权头 | `.header("Authorization", "Bearer $token")` | `readToken()` 解析 `^bearer\s+` | ✅ 一致 |
| 8 | WS 鉴权头 | 同上（`Authorization: Bearer`） | `handleUpgrade` 同样走 `readToken` | ✅ 一致 |
| 9 | WS 子协议 | 不发 `Sec-WebSocket-Protocol` | 带该头即 400 `no_subprotocol` | ✅ 一致（App 未发） |
| 10 | 信封 client-request | `{type,rpcId,method,payload}` | 原样透传 | ✅ 一致 |
| 11 | 信封 client-response | `{type:'client-response',rpcId,result}` | 原样透传 | ✅ 一致 |
| 12 | 应答校验 | 校验 `rpcId` 相同、读 `result.ok`/`result.error` | `RpcResult` 语义 | ✅ 一致 |
| 13 | 特权方法闸门 | 不使用 `settings.*`/`credentials.*` | 精确名单 + 前缀名单 → 403 | ✅ 一致（App 未越界） |

**结论：路径与鉴权层面，App 与网关**没有任何不一致 **。这是最容易被写错的地方，这里是对的。**

### 4.2 RPC 方法名与参数 —— **3 处不一致 ❌**

核对基准：**真实 DSH 宿主 bundle**（`app.asar` 内的 zod schema 注册表），而非项目自己的 `docs/api-contract.json`。

#### ❌ 不一致 1（致命）：`session.history` 在真实主机上**不存在**

App 用 `session.history` 读会话内容（`ChatViewModel.kt:82` 的 `reload()` 与 `:116` 的 1.6 秒轮询）：

```kotlin
c.call("session.history", buildJsonObject {
    put("sessionId", _state.value.sessionId)
    put("maxMessages", 80)
})
```

真实宿主注册表里**枚举出的 session 方法**（扫 `app.asar` 得到的 zod schema 名单）：

```
session: attachment, cancel, create, follow, fork, list, openWorkspacePath,
         page, projections, prompt, rename, search, selectModel,
         updateQueue, workspacePathApplications
```

**没有 `history`，真名是 `session.page`。** 真实 schema：

```
session.page 参数 = { address: {kind:'session', sessionId} | {kind:'subagent',...},
                      throughSeq: number, beforeSeq?: number,
                      maxMessages?: number, turnWindow?: {...} }
session.page 结果 = { records: [ { type:'event', event:{ type, seq, time, data, ... } } ], ... }
```

进一步确认：全 bundle 中 `"session.history"` 字面量出现 **0 次**；`session.history` 的 4 处出现**全部**是 ACP 示例代码里的**内存数组**（`for (const update of session.history)`），**不是 RPC 方法名**。

**影响**：App 的**核心读路径（进会话看历史、轮询新消息）100% 会失败**。网关是透明桥，会照常转发，由主机回 `bad-request`/未知方法错误。

**注意**：项目自己的 `docs/api-contract.json:295` 也把 `session.history` 列为存在（来源标注 `cc/client.js:6005`，即作者下载的**客户端 bundle**）。**项目契约文档本身与真实主机不同步** —— 这是一个需要 Lead 决策的文档级问题。

#### ❌ 不一致 2：`session.prompt` 缺必填 `requestId`

App 发送（`ChatViewModel.kt:190`）：

```kotlin
c.call("session.prompt", buildJsonObject {
    put("sessionId", ...); put("mode", "queue")
    put("content", buildJsonArray { add(buildJsonObject { put("type","text"); put("text", body) }) })
})
```

真实 schema：

```
session.prompt 参数 = { requestId: string, sessionId: string,
                        mode: 'queue'|'steer',
                        content: [ {type:'text',text} | {type:'image',...} | {type:'file',receiptId} ],
                        clientTimeZone?: string }
```

`requestId` 与 `sessionId` 一样是**必填**，App **没有发送**。`mode`/`content` 的形状是对的（✅）。**影响：发消息会被参数校验拒绝。**

#### ❌ 不一致 3：`/api/respond` 应答体形状不符

App 发送（`ChatViewModel.kt:170-182`）：

```kotlin
approve() → { "kind":"allow"|"deny", "approved":bool, "remember":bool }
answerOption() → { "kind":"answer", "answer": text }
```

契约（`docs/api-contract.json:417`）要求：

```
result = RpcResult<{ approvalId: string, outcome: 'allowed-once' | 'rejected' }>
即 { ok:true, value:{ approvalId, outcome } } 形态
```

App 既没有 `ok`/`value` 包装，也没有 `approvalId`/`outcome` 字段。**影响：审批/提问应答会被判 `bad-response`。**

> 诚实标注：`/api/respond` 的**服务端 pending 表**在项目自身契约里就标为 **UNVERIFIED**（`docs/api-contract.json` 的 gaps 段落），且我在 `app.asar` 中也**没能定位到** `approvalId`/`/api/respond` 的 zod schema（该实现应在未下载的 `dsh-host-apiproxy` 包里）。因此「App 的形状一定错」依据的是**项目自己的契约文档**，而非宿主实证。**置信度：中。** 但 App 与契约文档不一致这一点是确定的。

#### ⚠️ 附带：`PairingClient.textPrompt()` 形状可疑（当前是死代码）

```kotlin
fun textPrompt(text: String) = buildJsonObject {
    put("content", buildJsonObject { put("value", buildJsonArray { add({type:"text",text}) }) })
}
```

产出 `{content:{value:[...]}}`，而真实 `content` 应是**数组** `[{type:'text',text}]`。不过全仓库检索显示 **`textPrompt` 只被定义、从未被调用**（`ChatViewModel` 自己内联构造了正确的 `content` 数组），因此**不影响运行**，但属于埋着的雷。

### 4.3 其余形状（一致或有容错，不阻断）

| 项目 | App 期望 | 真实主机 | 结论 |
|---|---|---|---|
| `session.list` 返回 | `{items:[...]}`，读 `sessionId`/`title`/`updatedAt` | `{items:[{sessionId,updatedAt,running,blank,...}]}` | ✅ 一致（`title` 为 optional，App 有兜底「未命名会话」） |
| `session.search` 参数 | `{query}` | `{query}` (1..500) | ✅ 一致 |
| `session.create` 参数 | `{}`（全可选） | 全 optional | ✅ 一致 |
| `session.cancel` 参数 | `{sessionId}` | `{sessionId}` | ✅ 一致 |
| `host.describe` | 无参，作握手 | 无参 | ✅ 一致 |
| 下行帧形状 | 只认 `type=='server-request'`，读 `rpcId`/`method`/`payload` | `method` = payload.type 逐字 | ✅ 一致 |
| 事件渲染 | `JsonRender` 启发式抽取，容错 | `SessionEvent.data` 为 unknown | ✅ 设计合理，不会崩 |

---

## 5. 实际跑通的流程 / 卡在哪一步

### 跑通的

1. ✅ APK 元数据、权限、ABI、签名、ZIP 完整性全部核对通过
2. ✅ 网关**进程内** E2E：配对→令牌→鉴权→`/api` 桥→特权拒绝→事件流→吊销，**30/30 通过**
3. ✅ 公网隧道 + Caddy 白名单**生效**（`/api`、`manage` 被拦；`health` 能穿透到 DSH）
4. ✅ App 与网关的**路径、信封、鉴权方式逐项一致**（13 项全过）
5. ✅ 根因**定位并证实**（旧模块 + 尾斜杠 prefix + 进程未重载）

### 卡在哪一步、为什么

| 步骤 | 状态 | 卡住原因 |
|---|---|---|
| 真机安装 APK | ❌ 未验证 | 无设备、无模拟器镜像 |
| 铸配对码 `manage/api/mint` | ❌ 失败 | 运行态 404/405（旧模块，见 §3.3） |
| `POST /pair` 换令牌 | ❌ 失败 | 同上（405） |
| 令牌访问 `session.list` | ❌ 失败 | 同上（405） |
| 进会话读历史 | ❌ 会失败 | 即使网关恢复，`session.history` **方法不存在**（§4.2-1） |
| 发消息 | ❌ 会失败 | 即使网关恢复，`session.prompt` **缺 `requestId`**（§4.2-2） |
| 审批/提问应答 | ❌ 会失败 | `respond` 体形状不符（§4.2-3，置信度中） |

**两层阻断**：外层是**运行态故障**（重启即可解，一行代码都没错），内层是**协议不一致**（必须改代码/改契约）。

---

## 6. 给 Lead 的建议（按优先级）

1. **重启 desktop profile 的 DSH**，让已修复的 `path: '/mobile-gateway'` 生效；然后重跑 `act-as-app.mjs` 与 `test/e2e.mjs` 复验。（这是当前**唯一**挡住全部实测的问题）
2. **确认 `session.history` → `session.page`**：这会让 App 的会话读取彻底不可用。需同步改 `ChatViewModel` 的调用与解析（`records[].event` 而非 `events[]`），并**修正 `docs/api-contract.json`**（它当前与真实主机不符）。
3. **`session.prompt` 补 `requestId`**。
4. **核对 `/api/respond` 应答体**（`approvalId`/`outcome` vs 现在的 `kind`/`approved`）；建议用官方客户端实测一次抓包，因为服务端契约目前是 UNVERIFIED。
5. **release 包改用正式签名密钥**（现在与 debug 同证书）。
6. **清理 `PairingClient.textPrompt()`** 的错误形状（死代码）。
7. 修好后再补**真机**验证（需接一台设备或装 emulator + system-image）。

---

## 7. 证据可复现命令清单

```powershell
# 设备
& "...\platform-tools\adb.exe" devices -l

# APK
& "...\build-tools\35.0.0\aapt2.exe" dump badging "...\dist\dsh-mobile-0.1.0-debug.apk"
$env:JAVA_HOME="C:\Users\me\Downloads\android-toolchain\jdk17"
& "...\build-tools\35.0.0\apksigner.bat" verify --print-certs "...\dist\dsh-mobile-0.1.0-release.apk"

# 运行态（务必 --noproxy '*'，本机有全局代理 127.0.0.1:7897）
curl.exe -s -i --noproxy '*' "http://127.0.0.1:19387/mobile-gateway/health"
curl.exe -s -i --noproxy '*' "http://127.0.0.1:19387/mobile-gateway/"
curl.exe -s -i --noproxy '*' "http://192.0.2.20:19387/mobile-gateway/"     # 403 loopback_only ← 关键对照
curl.exe -s -i --noproxy '*' "http://127.0.0.1:19387/bot-gateway"             # 200 ← 对照，证明路由机制本身正常
curl.exe -sk -i --noproxy '*' "https://203.0.113.10:2444/mobile-gateway/health"

# 日志
Get-Content "C:\Users\me\.dsh\dsh-mobile-gateway\gateway.log"

# 测试
node packages/dsh-mobile-gateway/test/e2e.mjs
node packages/dsh-mobile-gateway/scripts/act-as-app.mjs http://127.0.0.1:19387
```

---

## 附：本次验证**未**做的事

- **未修改任何被测源码**（App、网关、测试均未改）
- **未重启 DSH 进程**（避免影响其他并行工作；重启是建议动作，留给 Lead）
- **未执行任何会改动设备/系统状态的操作**（无设备可动）

---

## 8. Lead 的处置记录（闭环）

本节由 Lead 追加，记录本报告各条发现的处置结果与独立复核证据。

### 8.1 §4.2-1 `session.history` 不存在 —— 已确认并修复

**独立复核方式**：自写 asar 扫描器，遍历 11470 个文件节点、实扫 423 个
`@deepseek-ai/dsh-*` 包，与报告结论一致：

```
"session.history"  →  0 次
"session.page"     →  dsh-api-session-controller/lib/client.js
"requestId"        →  该包内 37 次
```

**从真实源码抠出的权威签名**（比报告更进一步，直接取自实现）：

```js
// readPage()
const result = await this.remote.session.page({
  address: this.address, throughSeq, ...request
}, signal);
for (const record of result.value.records) assertSessionWireEvent(record.event);

// prompt() —— 官方自己补 requestId，证明其为必填
result = await this.remote.session.prompt({
  requestId: requestId ?? randomUUID(),
  sessionId, mode, content, clientTimeZone
}, signal);
```

**已修**：
- `ChatViewModel.reload()` 与 1.6s 轮询 → `session.page`；新增 `pageRequest()`
  统一构造 `{address:{kind:'session',sessionId}, throughSeq, maxMessages}`，
  新增 `recordsOf()` 适配 `records[].event`（保留 `events[]` 兼容分支）。
- `send()` 补 `requestId = UUID.randomUUID()`。
- `detectRunning()` 同步改吃 `records`。
- `docs/api-contract.md` / `.json` 对应条目已改，并在 md 顶部加了**来源警告**：
  该文档挖自客户端 bundle，与真实主机可能不同步；取证顺序必须是
  「真实主机源码 → 真实请求 → 该文档」。
- App 重新编译通过（debug 20.6 MB / release 13.86 MB）。

### 8.2 §4.2-3 `/api/respond` 信封 —— 已确认并修复（比报告多一处）

报告指出应答体形状可疑。Lead 复核时发现**更基础的一层错误**：
`Envelopes.clientResponse` 把裸业务对象 `{kind:"allow"}` 当作 `result` 传，
而契约要求 `result: { ok, value }`。已改为由 `clientResponse` 统一补信封。

网关侧补了覆盖（此前 `/api/respond` **零覆盖**）：转发路径、`{ok,value}` 信封
原样透传、rpcId 未被改写、无令牌 401。

**仍为「未验证」**：服务端 pending 表（报告与项目契约都标注 UNVERIFIED）。

### 8.3 §3.6 对测试的批判 —— 采纳，并补上了架构缺口

报告指出「进程内 E2E 的假宿主对任意方法名都返回成功，因此证明不了 App 可用」。
**这条批评完全正确**，Lead 据此做了三件事：

1. **假宿主加方法契约校验**：只接受白名单方法，且校验必填参数
   （`session.page` 缺 `throughSeq` 会被拒）。新增 4 条断言验证这层防护本身有效；
   突变测试删掉 `session.page` 会红 2 条。
2. **新增 `scripts/check-app-methods.mjs` 门禁** —— 补上此前完全缺失的一环：
   *App ↔ 主机的方法名一致性没有任何自动化守护*。该门禁从 app.asar 枚举真实主机
   方法名，与 App 的每个 `.call("…")` 逐个比对。
   实测：注入 `session.history` 或 `session.abort` 都会被抓住并给出精确行号，
   还原后归零；找不到 app.asar 时**明确报无法验证并非零退出**，不静默跳过。
3. **突变测试暴露的旁证**：把 App 改回 `session.history`，网关 50 项断言**仍全绿**
   —— 这从反面证实了报告的判断，也说明为什么必须新增第 2 条那种独立门禁。

### 8.4 §6-1 重启 DSH —— 仍未完成（当前唯一阻塞）

Lead 复核确认了报告的时间线判断，证据：

```
磁盘三份 index.mjs  →  path: '/mobile-gateway',   （已修）
DSH 进程启动时间    →  09:50:57
网关日志 ready      →  09:51:02
path 修复写入磁盘   →  09:54（进程启动之后）
```

即：**进程内运行的是旧模块，Node ESM 不热重载**。健康检查仍 404 与此一致。
磁盘已是修复版（三份哈希一致），重启后即可生效。

### 8.5 尚未处置（如实列出）

| 项 | 状态 |
|---|---|
| §6-4 `/api/respond` 服务端 pending 表 | 未验证（需官方客户端实测抓包） |
| §6-5 release 包正式签名 | 未做（当前与 debug 同证书，已知问题） |
| §6-6 `PairingClient.textPrompt()` 死代码形状错误 | 未清理 |
| §6-7 真机验证 | 无设备、无模拟器镜像，仍缺 |

### 8.6 当前验证状态汇总

| 检查项 | 结果 |
|---|---|
| 网关 E2E（`test/e2e.mjs`） | **81 通过 / 0 失败**（含 `[9b]` outcome 分型 + `[9c]` App 静态守护） |
| 公网全接口巡检（`check-all-endpoints.mjs`） | **45 通过 / 0 失败** |
| 子代理判据实测（`verify-subagent-classifier.mjs`） | 72 条逐条实测，判据精确 |
| App→主机方法名门禁（`check-app-methods.mjs`） | **全部存在** |
| 契约审计（`audit-contract.mjs`） | 信封形状全部通过 |
| 突变测试（4 类安全闸门 + outcome 形状） | 注入即红，还原即绿 |
| App 编译 | BUILD SUCCESSFUL |
| 公网真实环境端到端 | **事件流待重启 DSH 验证**（见 §9.9） |

---

## 9. 第二轮：公网真机实测（2026-10-13 下午）

> 环境变了：**Android 模拟器已就绪**（`emulator-5554`，sdk_gphone64_x86_64，Android 15），
> 不再受 §1「没有可用设备」限制。DSH 也已重启过，网关路由生效。
> 目标：**公网入口 `https://203.0.113.10:2444` 全链路实测**。

### 9.1 本轮结论速查

| 分类 | 内容 |
|---|---|
| **公网入口** | health 200 / login 200 / pair 403（码不对，正常）/ api 401（无令牌）—— 全部按设计 |
| **实测跑通** | 登录、会话列表（68 个真实会话）、新建会话、发消息（消息真实抵达主机）、停止当轮、令牌落盘、特权闸门 403 |
| **发现并修复** | ① `NetworkOnMainThreadException`（**致命**，整个网络层在真机上失效）② `PairScreen` 不渲染 error（失败零反馈）③ 事件流协议错误（两条 `events.*` 不存在）④ 应答通道错误（`/api/respond` 不存在）⑤ 会话列表混入 53 个点不开的子代理会话 |
| **主机侧限制（非我方缺陷）** | `session/search` 在该部署被禁用；`session/cancel` 对 subagent 会话报 `agent-busy` |

### 9.2 🔴 发现 1（致命）：`NetworkOnMainThreadException` —— 请求从未离开手机

**现象**：模拟器上点「登录」，界面**纹丝不动**；网关日志**零请求**（不是 401，是根本没到）。
Windows 侧同参数 `curl`/`node fetch` 全部正常，所以第一嫌疑落在 TLS/证书 —— **这个方向是错的**。

**取证过程**（值得记下，因为前两次都被误导）：

1. 截图显示仍在配对页 → 说明 UI 没跳转；
2. 网关 `gateway.log` 没有任何 login 记录 → 请求没发出；
3. 手机 `nc` 打公网 2444 / 宿主 19387 / 8.8.8.8:53 **全部 exit 0** → 网络本身没问题；
4. 证书用 Node 严格校验（非 `-k`）打过去 → `200`，**TLS 也没问题**；
5. 最后给 `PairingClient.login()` 加 `Log.i/Log.e` 打印真实异常类型，才拿到决定性证据：

```
I DSH_PAIRING: POST https://203.0.113.10:2444/mobile-gateway/login (user=dsh, device=sdk_gphone64_x86_64)
E DSH_PAIRING: 登录请求失败: android.os.NetworkOnMainThreadException: null
    at android.os.StrictMode$AndroidBlockGuardPolicy.onNetwork(StrictMode.java:1675)
    at java.net.AbstractPlainSocketImpl.doConnect(...)
    at okhttp3.internal.connection.RealConnection.connectSocket(...)
```

**根因**：`AppViewModel` 用 `viewModelScope.launch { PairingClient.login(...) }`，而 `viewModelScope`
**默认跑在主线程**；`PairingClient.login()` 用的是**阻塞式** OkHttp `execute()`。
Android 的 StrictMode 直接拦下 —— 请求根本没发出去。

**同一缺陷遍布整个网络层**：`DshConnection.call()`、`DshConnection.respond()` 同样是阻塞式
`execute()`，同样从 `viewModelScope` 调用。也就是说**整个 App 在真机上从来没能联网**，
而之前所有测试都是绿的 —— 因为进程内测试和电脑侧脚本都不经过 Android 主线程。

**修复**：
- `PairingClient` 的 `login()` / `pair()` / `probe()` 改为 `suspend` + `withContext(Dispatchers.IO)`；
- `DshConnection.call()` / `respond()` 的网络调用包进 `withContext(Dispatchers.IO)`；
- 顺带修一个**真实的超时缺陷**：`call()` 原来用 `withTimeoutOrNull(timeoutMs)` 包一个
  **阻塞调用** —— 协程超时**中断不了**阻塞中的 socket，服务器不响应就会一直挂着。
  改为把 `timeoutMs` 传给 OkHttp 自己的 `connectTimeout`/`readTimeout`。

**验证**：重装后同一操作：
```
I DSH_PAIRING: POST https://203.0.113.10:2444/mobile-gateway/login (user=dsh, device=sdk_gphone64_x86_64)
I DSH_PAIRING: HTTP 200 len=512
I DSH_HOST_STORE: 存储初始化完成: encrypted=true, file=dsh_hosts
```
网关侧同时出现 `device logged in {"deviceId":"dev_GOeFb3O1RMin","name":"sdk_gphone64_x86_64"}`。

### 9.3 🔴 发现 2：`PairScreen` 从不渲染 `error` —— 失败时用户只能干等

**现象**：§9.2 期间，登录失败在界面上**完全没有反馈**：不跳转、不报错、不转圈结束。

**根因**：`PairScreen` 的签名只有 `busy: Boolean`，**没有 error 参数**；
`MainActivity` 也没把 `state.error` 传进去。`AppViewModel` 明明把错误写进了 state，
但这一页从来不读。**任何**失败（TLS、超时、密码错）都表现为「点了没反应」。

**修复**：`PairScreen` 增加 `error: String?` 参数并渲染成 error 色文本；
`MainActivity` 传入 `state.error`。修复后实测界面正确显示「登录失败」。

> 这个缺陷放大了 §9.2：正是因为它，一个**一行日志就能定位**的问题被拖了很久。

### 9.4 🔴 发现 3：事件流协议根本错误 —— 真实主机只有**一条** mux

**现象**：登录成功后，网关日志反复刷：
```
device attached to event stream {"endpoint":"/api/events.mux"}
event stream ended  {"endpoint":"/api/events.mux","error":"invalid Remote endpoint \"/api/events.mux\""}
```
两条流（`events.mux` / `events.host`）**每条都是连上即断**。

**取证**（`app.asar` 权威源码，非客户端 bundle）：
```ts
// @deepseek-ai/dsh-api-gateway/src/stream-protocol.ts
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
```
- `"/api/events.mux"` / `"/api/events.host"` 在真实源码里**零出现**；
- endpoint 校验是 `endpoint.split('/').length === 2`，而 `/api/events.host` 有 **3 段** → 直接抛错。

真实协议是「**一条 WS 承载多条逻辑流**」：客户端发
`{type:'open', streamId, endpoint, payload}`，主机在该 streamId 上回
`item` / `end` / `error`。事件流用内部 endpoint `$events`，payload 必须是 `{args:{}}`；
主机回 `ready`（带 `clientId`）/ `emit` / `waterfall` / `cancel` 四种。

**修复**：网关改为注册单条 `/mobile-gateway/remote.mux` 并实现完整帧协议；
App 改为单条 WS + 逻辑流。细节见 `docs/api-contract.md` §1.5。

**⚠️ 连带修了 Caddy**：新路径必须同步加进 VPS 白名单，否则**本机通、公网 404**。
判别证据（改之前）：公网 `/mobile-gateway/remote.mux` 返回 Caddy 的 `Not Found`（9 字节纯文本），
而 `/mobile-gateway/events.mux` 返回网关的 JSON —— 前者被 Caddy 拦，后者才穿透。
已执行 `.scratch/fix-caddy-mux.sh`（含备份 + `caddy validate` + 失败回滚），
改后 `remote.mux` 已穿透到网关、`zzz-nonexistent` 仍是 Caddy 拦（对照组正常）。

> 这是**同一类坑第二次**：上次加 `/mobile-gateway/login` 时也忘了同步 Caddy。

### 9.5 🔴 发现 4：`/api/respond` 不存在 —— 审批应答送不出去

**取证**：
- `app.asar` 全量扫描 `@deepseek-ai/dsh-*`：`"/api/respond"` 命中 **0 次**；
- 实测：直连主机 401、经网关 **404**；
- 正确通道 `$events/result` 实测**可达主机**，回
  `typert gateway: Remote event result identifies no active event stream`
  —— 证明端点存在、只是没有活跃流。

**真实形状**（`parseRemoteEventResult` 逐字）：
`args = {clientId, eventId, outcome:{kind:'next'|'result'|'rejected', …}}`，
其中 `clientId` 来自事件流 `ready` 帧、`eventId` 来自 `waterfall` 帧。

**修复**：App 的 `respond()` 改打 `$events/result`；`Envelopes` 的 `clientResponse`
（产 `{ok,value}` 信封）替换为 outcome 构造器；`ChatViewModel` 适配。网关是透明桥，无需改动转发逻辑。

#### 9.5.1 🔴 二次更正：`outcome.value` 的**语义**也曾写错（2026-10-13 下午）

第一次修只解决了「**通道**」问题（`$events/result` 而非 `/api/respond`），但
`outcome.value` 的**内容形状**仍然是自造的，而主机**不校验、只静默归一化** —— 这是最危险的一类错误。

**取证链**（`app.asar` 逐字，四层）：

```js
// 1) dsh-user-approval/lib/index.js:30-35 —— 权威词表
const OUTCOMES = ["allowed-once", "rejected", "cancelled", "unavailable"];

// 2) 同文件:176 —— 归一化：**词表外的值不报错，静默变成 'unavailable'**
this.ctx.waterfall(…, "approval/request", req, () => Promise.resolve("unavailable"))
  .then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable",
        () => "unavailable");

// 3) dsh-sandbox/lib/index.js:117-121 —— 消费侧 switch + assertNever
case "allowed-once": return mode;
case "rejected": throw new Error(`the user rejected escalating this ${subject} …`);
case "unavailable": throw new Error(`… requires approval, but no approval channel is available`);
default: return assertNever(outcome, "EscalationOutcome");

// 4) 官方客户端 dsh-client-ui-approval/lib/client.js:79,131 —— 它就是发裸字符串
answer(event.key === "Enter" ? "allowed-once" : "rejected");
```

**原来的错误**：App 发 `value: {approved: true}`（**对象**）。
它不在 `OUTCOMES` 里 → 被归一化成 `'unavailable'` → 沙箱抛
「requires approval, but no approval channel is available」。
**用户点了"允许"，却得到"没有审批通道"**，且**全程无任何报错**。

**提问同理**：原来发 `{answer: "文本"}`；权威形状是
`{answers: [{id, selected: string[]}]}`（`dsh-user-questions/lib/index.js:58-70`），
其中 **`id` 是「问题」的 id**（不是选项 id）、**`selected` 是所选选项的 label 数组**。
官方客户端同样如此（`dsh-client-ui-user-questions/lib/client.js:529-531`）：
```js
settle(() => pending.answer({ answers: [{ id: review.id, selected: [label] }] }), …)
```

**同时修正的两处**：
- 选项来源：真实 payload 是 `questions[0].options[].label`（**对象数组**），
  原来按字符串数组解析**必然为空**；
- `remember`（记住本次选择）**故意不上线**：宿主 `ApprovalOutcome` 词表只有那四个字符串，
  **没有"记住"这一档**，发出去同样会被归一化成 `'unavailable'`。
- `HostRequest` 新增 `answerable` 标志：`emit` 是纯通知（如 `schedule/changed`），
  **应答它毫无意义**；只有 `waterfall` 才在等结果。原来靠事件名里是否含
  `approval`/`question` 来猜，既会漏也会误判。

**守护**：e2e 新增 `[9b]` outcome 分型 4 项 + `[9c]` App 源码静态守护 10 项
（含"审批必须用裸字符串"、"提问必须取问题 id"、"选项必须从 `.label` 取"）。
`[9c]` 做了**突变测试**：把形状改回错误值后断言确实变红，证明不是假绿。

> **教训**：透明桥**不做语义校验**，所以「形状合法但值不在词表里」的错误
> **在网关层完全看不出来**（e2e 也照绿）。这类错误只能靠
> ①读权威源码的**归一化分支**、②在 App 侧做静态守护 来防。

### 9.6 🔴 发现 5：会话列表混入大量**点不开的**子代理会话（判据经两轮实测修正）

> ⚠️ **本节的两个早期结论都被实测推翻了，保留过程是因为判据错了的代价是真实的**
> ——要么把能打开的会话误藏（用户找不到自己的会话），要么把打不开的留在主列表
> （用户点进去全是错误页）。最终判据只认 `origin == "subagent"`。

**第一轮（错的）**：看到 68 条里 53 条是裸 UUID（非 `session-` 前缀），推断
「非 `session-` 前缀 = 打不开」。

**第二轮（仍是错的）**：改判据为 `origin == "subagent" || parentSessionId != null`。

**第三轮（对，用实测裁决）**：新增
`packages/dsh-mobile-gateway/scripts/verify-subagent-classifier.mjs` —— 对**每一条**会话
真的发一次 `session/page`，按返回结果给三张交叉表，并打印**反例**。
全部 **72 条**实测结果：

| 判据 | 误藏能打开的 | 漏藏打不开的 | 结论 |
|---|---|---|---|
| 非 `session-` 前缀 | **10** | 0 | ❌ 不可用 |
| `origin=="subagent" \|\| parent!=null` | **1** | 0 | ❌ 不可用 |
| **只认 `origin=="subagent"`** | **0** | **0** | ✅ 精确 |

```
■ 判据 A：id 前缀          session- 前缀 共 18 可打开 18 / 非 session- 共 54 可打开 10 打不开 44
■ 判据 B：origin          origin=(无)   共 28 可打开 28 / origin=subagent 共 44 可打开 0 打不开 44
■ 判据 C：parentSessionId  无 共 27 可打开 27 / 有 共 45 可打开 1 打不开 44

反例 [A]「|| parent!=null」会误藏 1 条：
    session-57329df2-86bc-49be-b468-15ffbdf08a8a  origin=null → **能打开**
反例 [B]「只认 origin」会漏藏 0 条
反例 [C]「非 session- 前缀」会误藏 10 条
```

**关键洞察**：那 1 条带 `parentSessionId` 却无 `origin` 的是 `session.fork` 出来的
**普通会话、打开完全正常**。所以 `parentSessionId` **不能**作为判据 ——
`origin` 与「能否打开」是**充要**关系（44 条 subagent ↔ 44 条实际打不开），
而 id 前缀与 parentSessionId 都只是**相关**，不是判据。

**后果**：点进去得到 `subagent Sessions require their durable parent address`（实测确认）。

**修复**：
- App：`SessionRow` 增加 `isSubagent` / `parentSessionId`；`SessionsViewModel` 把子代理会话
  **分流**到 `subagentRows`，默认不混在主列表；顶栏加「显示/隐藏子代理会话」开关，
  且子代理行**不可点开**（避免又跳进错误页）。判据**只认 `origin == "subagent"`**，
  三处（`SessionsViewModel`/`AppViewModel`/`docs/api-contract.md`）都写明了原因。
- 网关：`session/list` 瘦身逻辑**保留 `origin`/`parentSessionId`/`blank`/`agentAvailable`/`cwd`**
  （早前只留 `title`，App 拿不到判据）。瘦身后仍 ~28 KB，远低于 120 KB 门限。
- 顺带：`JsonRender.bool()` 新增（替代 `content == "true"` 这种脆弱写法）。

**可复现**：
```powershell
node packages\dsh-mobile-gateway\scripts\verify-subagent-classifier.mjs https://203.0.113.10:2444 dsh <密码>
```

### 9.7 公网写路径实测（脚本化，绕开模拟器 UI 不稳定因素）

模拟器 UI 自动化有两个坑：`adb shell input text` **传中文直接 NPE**；键盘弹出会遮住发送按钮。
因此把「协议对不对」与「UI 点得到点不到」分开验证 —— 新增
`packages/dsh-mobile-gateway/scripts/public-write-test.mjs`，用与 App **逐字同构**的信封
打同一个公网网关：

```
[1] 登录            ok POST /mobile-gateway/login → 200 · 拿到令牌 len=43
[2] 读路径基线       ok session/list → 65 个会话
[3] 新建会话         ok session/create → session-f7881122-…
[4] 发消息           ok session/prompt → result.ok
                     ok 缺 requestId → 被主机拒绝（证明该字段确实必填）
[5] 读回             ok 主机自报 cursor · session/page → 6 条 records
[6] 其余             ok session/cancel
[7] 特权闸门         ok settings/describe · credentials/set · pluginManager/install 全部 403
```

后续独立复验（等 turn 结束后重翻页）确认消息**真实抵达主机**，`session/page` 读到
`seq=8 user/message` 正文即测试所发内容，并出现 `session/title`、`turn/start`、`turn/end` 等真实事件。

**两处"失败"经甄别均非我方缺陷**：
- `session/search` → 主机回 `SessionQueryError: session search is disabled: this deployment…`
  —— 该部署**禁用了搜索**，直连主机同样被拒；
- `session/cancel` → 对**子代理会话**回 `session/agent-busy`（它归 subagent 所有），
  对普通会话正常。

### 9.8 全接口巡检脚本的判据修正

`check-all-endpoints.mjs` 公网跑出 17 通过 / 10 失败，其中 **8 个是假失败**：

- **E 组（7 个）**：脚本调 `rpc()`，而 `rpc()` 内部把期望状态**硬编码**成 `expect:[200]`，
  于是网关**正确地**返回 403 时反被记成 FAIL。改为直接 `probe` 断言 **HTTP 403 +
  错误码 `loopback_only`**（= 被网关拦下、根本没触达主机）。
- **F1（1 个）**：原来断言 `/api/respond` 返回 200 —— 那正是 §9.5 证伪的端点。
  改为：断言旧路径 **404**（防止改回去），并断言 `$events/result` **可达主机**
  （回「无活跃事件流」而非 404）。

修正后该脚本的"失败"项全部变为有意义的断言。

### 9.9 本轮未验证 / 待重启

| 项 | 状态 |
|---|---|
| 真实主机接受我们的 mux 帧（`open` → `ready`/`emit`） | **未验证** —— 网关改动需**重启 DSH** 才生效 |
| `$events` 流是否真能推出 approval/waterfall 帧 | **未验证** —— 同上 |
| 审批应答端到端（`$events/result` 带真实 clientId） | **未验证** —— 同上 |
| 子代理会话不再出现在主列表 | **未验证** —— 需重装 APK 后确认（已编译通过） |
| release 包正式签名 | 仍未做（与 debug 同证书） |
| 真机（非模拟器）验证 | 仍未做（当前用模拟器） |

> 网关改动落在 `packages/dsh-mobile-gateway/`，安装副本在
> `C:\Users\me\.dsh\node_modules\dsh-mobile-gateway`。**重启 DSH 前需要先把改动同步到安装副本**，
> 否则重启加载的仍是旧代码。
