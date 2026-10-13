# 贡献指南

感谢愿意帮忙。这个项目有两个部分，改动前请先读对应章节。

## 项目结构

```
dsh-native-mobile/
├─ packages/dsh-mobile-gateway/   DSH 宿主插件（Node ESM，cordis 插件，npm 包）
├─ apps/android/                  Kotlin + Jetpack Compose 原生 App
├─ docs/                          设计与实测文档（**改动协议前必读**）
└─ scripts/                       安装与运维脚本
```

## 🔴 最重要的规矩：协议取证顺序

**这个项目最大的教训是「文档/客户端 bundle 与真实主机不一致」**，已经踩过 4 次：

| 曾经写错的 | 真实主机 |
|---|---|
| `session.history` | 不存在，真名 `session.page` |
| `/api/events.mux`、`/api/events.host` | 不存在，只有**一条** `/api/remote.mux` |
| `POST /api/respond` | 不存在，应答走 `$events/result` |
| 子代理会话判据用 `parentSessionId` | 只能用 `origin == "subagent"` |

**因此：任何写进客户端的调用，必须按下列顺序取证，缺一不可 ——**

1. **真实主机源码**：`app.asar` 内 `@deepseek-ai/dsh-*/lib/*.js`
   （含 zod schema 与归一化分支 —— **归一化分支最容易漏，见下）
2. **对运行中的主机发一次真实请求**，看它接受什么
3. 本仓库 `docs/api-contract.md`（挖自客户端 bundle，**可能过时**）
4. ❌ **绝不要**只凭文档、README、客户端 bundle 或"看起来合理"就下结论

### ⚠️ 特别注意「静默归一化」

透明桥**不做语义校验**。值不在宿主词表里时**不报错**，而是被悄悄替换成兜底值：

```js
// dsh-user-approval/lib/index.js:176
.then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable")
```

所以「形状合法但值不在词表里」这类错误，**在网关层和 e2e 里完全看不出来**（全绿），
只在真机上表现为「点了允许却说没有审批通道」。**读源码时要专门找这种归一化分支。**

## 开发环境

- **Windows PowerShell 5.1**（本仓库脚本按它写；无 `pwsh`）
- **JDK 17**（硬约束）
- **Node**：用 DSH 自带的
  `resources\runtime\primary-runtime\dependencies\node\bin\node.exe`
- **Android SDK**：`apps/android/local.properties` 指向本机 SDK 路径（已 gitignore）

细节见 `docs/BUILD.md`。

## 构建与测试

```powershell
# 网关端到端（真实 HTTP + WS，只打桩宿主）
cd packages\dsh-mobile-gateway
node test\e2e.mjs                 # 期望 81 通过 / 0 失败

# App
cd apps\android
$env:JAVA_HOME="<你的 JDK17 路径>"
.\gradlew.bat assembleDebug
```

**改 `.mjs` 后必须重启 DSH 才生效**（Node ESM 不热重载）。且安装副本有两处，
重启前要同步（见 `scripts/install-gateway.ps1`）。

## 编码约定

- **文本文件一律 UTF-8 无 BOM**。⚠️ PowerShell 5.1 的 `Set-Content`/`Add-Content`
  会写成 **ANSI/GBK** —— 本仓库的 `.gitignore` 就曾被这样写坏（含非法 UTF-8 字节）。
  改文本用 `[IO.File]::WriteAllText($p, $t, [Text.UTF8Encoding]::new($false))`。
- **注释用中文**，并写**为什么**而不是**是什么**。本仓库的注释风格是「记录踩过的坑」
  —— 有事故复盘、有实测数据、有反例，这些比代码本身更值钱。
- **改动安全逻辑（`lib/bridge.mjs` 的闸门）必须同时改测试**，并做**突变测试**：
  把防护去掉，确认测试真的变红（否则是假绿 —— 本仓库发生过）。
- **`docs/device-test.md` 是事实记录**，修了缺陷就在对应小节追加处置，别删历史。

## 提交

- 提交信息用中文，格式 `type(scope): 摘要`，type ∈ `feat|fix|refactor|docs|test|chore|perf`
- 署名用你自己的身份；若需临时指定，用 `git -c user.name=… -c user.email=… commit`，
  **不要改全局 git 配置**

## 🔴 安全红线

- **绝不提交**：真实公网 IP / 内网地址 / 域名 / 个人路径 / 密钥 / 令牌 / `.env`
- 地址占位统一用 **RFC 5737 文档网段**：`203.0.113.x`、`198.51.100.x`、`192.0.2.x`，
  或 `example.com`
- 提交前自查：`git grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|BEGIN .*PRIVATE KEY'`
  （再加上你自己的用户名/域名 —— 本仓库的检查清单里就不写具体值了）
- ⚠️ **历史也会泄漏**：如果敏感信息已经进过提交，改工作树是不够的，
  必须重写历史（本仓库做过一次，见 `docs/device-test.md`）

## 研读外部代码时注意

⚠️ **克隆第三方仓库到工作区内，其 `AGENTS.md` / `CLAUDE.md` 会被运行时当作项目指令自动加载**
（本仓库实测过）。这可能被恶意仓库利用来注入指令。

**做法**：把外部仓库克隆到**工作区之外**，或克隆后立刻删除其 `AGENTS.md`/`CLAUDE.md`。

## 许可证

贡献即表示同意以 [Apache-2.0](LICENSE) 授权。
