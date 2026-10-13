# DSH 移动端（原生）

给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 做的**原生 Android 客户端**，
配套一个 DSH 宿主插件做进程内鉴权网关。

```
dsh-native-mobile/
├─ packages/dsh-mobile-gateway/   DSH 宿主插件（npm，Apache-2.0）
└─ apps/android/                   Kotlin + Jetpack Compose 原生 App
```

## 为什么不用现成方案

社区已有的两个方案都把**官方 Web GUI 送到手机**上跑：

| 方案 | 手机上跑的其实是 | 问题 |
|---|---|---|
| `@linxin666/dsh-remote-web-ui` | 同一份官方 Web GUI，竖屏时注入 CSS 覆盖层 | 桌面界面压进手机，怎么调都是挤 |
| `dsh-mobile`（0.6.4） | 专用移动页 + **Kotlin WebView 薄壳**，README 原话「不内置另一份网页」 | WebView 壳改不了布局与交互手感 |

本项目**不送界面，只送协议**：DSH 的 `/api` 经设备令牌鉴权后在**进程内**桥接到手机，
由独立的原生 App 呈现。DSH 源码零改动。

## 架构

```
Android App ──HTTP/WS──▶ dsh-mobile-gateway ──进程内──▶ DSH Host 服务
 (Kotlin/Compose)          (cordis 插件)              connection / typertGateway
```

网关做且只做四件事：

1. **配对**：电脑上生成一次性配对码 → 手机换长期设备令牌；令牌磁盘上只留 SHA-256 摘要。
2. **鉴权**：`Authorization: Bearer <token>`，HTTP 与 WebSocket 升级都验；吊销按请求生效。
3. **协议桥**：`POST /mobile-gateway/api/<method>` → 官方 `ConnectionFetchHandler`，
   envelope 原样透传，App 与官方 Web 客户端讲同一种协议。
4. **事件流**：唯一的 mux `/mobile-gateway/remote.mux`（帧协议）→ 逻辑流
   `$events` → `typertGateway.wireStream.open()`；审批/提问的应答走 RPC
   endpoint `$events/result`。

**没有隧道、没有 TLS、没有账号体系**——那是 dsh-mobile 的职责。本项目假定你已经有办法
把自己的电脑暴露出去（局域网直连、Tailscale、cloudflared、自建反代……），把地址填进 App 即可。

## 安全模型（重要）

| 面 | 可达性 |
|---|---|
| `GET /mobile-gateway/health` | 公开，只回服务名与实例名 |
| `POST /mobile-gateway/pair` | 需一次性配对码，码 5 分钟过期且一次性消费 |
| `POST /mobile-gateway/api/*` | 需有效设备令牌 |
| `WS /mobile-gateway/remote.mux` | 同上；认证失败**不完成握手**，直接裸 HTTP 401/403 |
| `GET /mobile-gateway/manage*` | **仅回环 TCP 对端**（按 `req.socket.remoteAddress` 判断，不是 Host 头） |

**特权方法闸门**：官方 node 载体把 `settings.*`、`credentials.*`、`pluginManager.*`、
`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory/openPath`、`llm.discoverModels`
用**空信任表**过栅栏，从而钉死在回环。而我们的内部请求永远是回环身份——若原样转发，
等于给配对设备额外开了一整片本机特权面。因此网关显式复刻那张名单并默认拒绝
（见 `lib/bridge.mjs` 顶部的 `PRIVILEGED_METHODS`）。可配置，但别轻易放开。

已配对设备是**完全控制凭据**：它能驱动这台电脑上的 DSH（会话、文件、工具）。手机丢了立刻在管理面板吊销。

## 安装

### 1. 电脑端装网关

```powershell
pwsh -File scripts\install-gateway.ps1
```

它会做三件事：把插件复制到 `<dsh-home>\node_modules\dsh-mobile-gateway`、装上运行时依赖、
在**机器级** `<dsh-home>\cordis.patch.yml` 的 `insert` 列表里追加注册行。

> 为什么不直接用 `dsh plugin add`：这是 **host 插件**（`package.json` 里没有 `dsh.client`），
> 不是 bundle，`install_bundle` 会返回 `error.code: not-bundle` —— 形态差异，不是失败。
> 另外 DSH 的组合树按 `<dsh-home>\node_modules` 解析裸包名，最终位置必须自己落对。

**重启 DSH 后生效。** 这是必须的：DSH 运行期间改 patch 会让设置写入的 revision 乐观锁错位，
重启会重新读盘对齐。

### 2. 打开管理面板

```
http://127.0.0.1:<DSH 端口>/mobile-gateway/manage
```

点「刷新配对码」。想出二维码就在插件配置里填 `publicBaseUrl`（你的公网地址）；
不填就手动输入配对码。

### 3. 手机端装 App

```powershell
cd apps\android
.\gradlew.bat assembleDebug
# 产物：app\build\outputs\apk\debug\app-debug.apk
```

传到手机安装，或用 `adb install -r app\build\outputs\apk\debug\app-debug.apk`。

Release 构建目前复用 debug 签名（先能装上跑通，正式签名后补）：
`.\gradlew.bat assembleRelease`

## 工具链

本机已在 `C:\Users\me\Downloads\android-toolchain` 装好 Temurin JDK 17 + Android SDK
（`platforms;android-35`、`build-tools;35.0.0`、`platform-tools`）+ Gradle 8.11.1。
换机器见 `docs/BUILD.md`。

`apps/android/local.properties` 指向 SDK 路径，是本机相关的，已 gitignore。

## 测试

**网关端到端**：真实 HTTP + WebSocket，只打桩 DSH 宿主服务。

```powershell
cd packages\dsh-mobile-gateway
node test\e2e.mjs          # 81 断言
```

覆盖：配对码格式与一次性消费、令牌鉴权（缺失/伪造/吊销）、`/api` 桥透传与业务错误、
**特权方法被拒且未触达宿主**、单条 mux 的帧协议（`open`/`item`/`end`/`error`）、
协议违规（重复 streamId 关 1008、非法帧关 1008、未知 streamId 静默丢弃）、
`$events/result` 应答通道、**审批/提问的 outcome 形状分型**、以及一组
**App 源码静态守护**（防旧通道与错误形状回归）。

**公网全接口巡检**（需先起好公网入口，或换成本机地址）：

```powershell
node packages\dsh-mobile-gateway\scripts\check-all-endpoints.mjs https://203.0.113.10:2444   # 45 断言
```

**子代理会话判据复核**（对每条会话真的发一次 `session/page`）：

```powershell
node packages\dsh-mobile-gateway\scripts\verify-subagent-classifier.mjs https://203.0.113.10:2444 dsh <密码>
```

**App 编译**：

```powershell
cd apps\android
.\gradlew.bat assembleDebug
```

## 当前实现范围

**已做**：账号密码登录（+ 配对码/扫码备选）、设备列表、会话列表（**子代理会话自动分流**）、
新建会话、会话历史分页、发消息、停止当轮、审批/提问卡片应答、断线指数退避重连、
令牌加密存储（`EncryptedSharedPreferences`）。

**已知取舍**：

- **历史读取走 `session.page` 分页 + 增量轮询**，不是官方 `session/follow` 订阅。
  事件流（单条 mux + `$events`）已实现，但**尚未端到端验证**（需重启 DSH 后真机确认）；
  在那之前轮询是唯一已验证可用的路径。
- **子代理会话默认折叠**：真实主机把它们也列在 `session/list` 里，但它们**不能用裸
  sessionId 打开**（会得到 `subagent Sessions require their durable parent address`）。
  判据**只认 `origin == "subagent"`** —— 用 id 前缀或 `parentSessionId` 都会误伤
  （实测有 `session.fork` 出来的普通会话带 `parentSessionId` 却能正常打开）。
- **审批应答不支持"记住本次选择"**：宿主 `ApprovalOutcome` 词表只有
  `allowed-once | rejected | cancelled | unavailable` 四项，**没有"记住"这一档**；
  发词表外的值不会报错，而是被**静默归一化成 `unavailable`**（表现为"点了允许却说没有审批通道"）。

## 文档

- `docs/architecture.md` — 设计取舍与替代方案
- `docs/protocol.md` — 网关线协议与安全模型
- `docs/api-contract.md` — `/api` 契约（**含 4 处已证伪条目的更正**，取证顺序：真实主机源码 → 真实请求 → 本文）
- `docs/host-seams.md` — DSH 宿主插件可用接缝（实测取证）
- `docs/public-access.md` — 公网访问：FRP + Caddy 白名单（地址为占位符）
- `docs/device-test.md` — **两轮真机/公网实测报告**（含 5 个真实缺陷的定位与修复）
- `docs/test-audit.md` — 测试体系审计
- `docs/BUILD.md` — 从零构建工具链
- `docs/minimax-code-study.md` — MiniMax Code 客户端设计调研
- `docs/open-source-android-agents.md` — 开源安卓 AI Agent 客户端源码研读（8 个仓库）

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[Apache-2.0](LICENSE)。