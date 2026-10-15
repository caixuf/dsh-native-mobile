# 交接文档 · DSH Native Mobile

> 交接时间：2026-10-16　|　最新发布：**v1.0.7**　|　仓库：https://github.com/caixuf/dsh-native-mobile
> 本机路径：`C:\Users\20247\Downloads\aiwork\dsh-native-mobile`

**一句话现状**：**已收尾**。桌面端核心能力全部对齐并完成移动端原生适配；构建已做成可复现的；
`node --run verify` **584 条断言全绿**，端到端 **11 个场景全通过**，工作树干净、无未提交改动。

**能装的东西只有一个入口**：[Releases](https://github.com/caixuf/dsh-native-mobile/releases)（APK 用 debug 密钥签名，覆盖安装即可）。

---

## 1. 发布历史

| 版本 | 内容 |
|---|---|
| **v1.0.7** | 顶栏统计条视觉截断修复 + `no-scrollbar` 死类 + 标签对比度达 AA + Tailwind 扫描范围显式化（构建可复现） |
| v1.0.6 | 触感反馈 / 流式光标 / 键盘视口动态 + 建会话落真工作区 |
| v1.0.5 | 视觉重叠与字距挤压修复 + 四边安全区（刘海/挖孔）适配 |
| v1.0.4 | 扫码配对 + 相机/选图权限（补齐附件链路） |
| v1.0.3 | 扫码相机无限重启 + 扫描循环条件写反（自造回归） |
| v1.0.0 | 审批提问全能卡 + 运行时切模型 + 改动文件 Diff + 斜杠指令 + 图片附件 + 计划模式 |

## 2. 验证口径（"绿"的定义）

```powershell
node --run verify                 # 584 条断言 = client 394 + gateway 96 + Android 94，另加 tsc + vite build
node --run test:android           # 注意：Gradle 会判 UP-TO-DATE 复用旧结果；
                                  # 要确认**本机真的跑过**就加 --rerun-tasks（见 §8）
node scripts/e2e-app-ui.mjs --serial=emulator-5554 --scenario=all   # 11 个场景，约 7 分钟
```

- 端到端**必须**跑在真网关（`http://127.0.0.1:19387` = DSH 本体）上，且先 `adb reverse tcp:19387 tcp:19387`；
  `queue` / `approval` 场景额外用脚本自带的假主机（19400），需 `adb reverse tcp:19400 tcp:19400`。
- 断言总数 = **逐行求和**（`scripts/*.mjs` 每个文件结尾的 `N passed` 相加），不是估算：
  client 44+10+27+27+6+1+15+10+11+59+57+66+5+56 = **394**（含 qr-decode 那条基准断言），
  gateway 85+11 = **96**，Android 94。

## 3. 🔴 协议事实（全部真主机实测，**别再猜**）

| 事实 | 说明 |
|---|---|
| 端点用**斜杠** | `session/list`、`session/page`… 写成点号会 404 `not found`（这坑踩过两次） |
| payload 包一层 | `{args:{...}}`；args 键名 = 服务端形参名（`session/list`→`_request`，其余→`request`） |
| 实时内容走 `session/follow` | args `{request:{address:{kind:'session',sessionId}}}`；先 `item:snapshot`，随后逐条 `item:event`。`{request:{sessionId}}` 会被边界校验拒 |
| `$events` 只有粗粒度信号 | 只有 `api-session/status` / `activity` / `added`，**不含任何内容事件** |
| 统计数字在 `session/projections` | args 是**扁平** `{request:{sessionId}}`；`{request:{address:{…}}}` 会被拒。`session/list` 里**没有**这些字段 |
| `session/modelCatalog` 不接参数 | 空对象 `{}` 即可 |
| 审批/提问应答 | RPC `$events/result`，args `{clientId, eventId, outcome}`；`outcome.value` 必须是**裸字符串** `allowed-once\|rejected\|cancelled\|unavailable`（词表外的值**不报错**、被静默归一化成 `unavailable`=拒绝） |
| 没有 archive 端点 | 桌面版归档是 host 能力（`workspace/archiveSession`），网关只有 `session.*` 族 → 移动端只能**本机归档**（UI 已如实标注） |
| `session/rename` / `session/fork` | args 都要 `{request:{…}}`：rename → `request.sessionId + request.title`；fork → `request.sessionId`(+可选 `atSeq`) |
| subagent 会话 | `session/list` 里 `origin=="subagent"` 的会话**不能用裸 sessionId 打开**；判据只能认 `origin`（用 `parentSessionId` 会误伤 fork 出来的普通会话） |

## 4. 目录地图

| 路径 | 是什么 | 规模（实测） |
|---|---|---|
| `src/` | React 19 + Vite 6 + Tailwind v4 客户端（整个 SPA 跑在 WebView 里） | 51 文件 / 14164 行 |
| `packages/dsh-mobile-gateway/` | cordis 宿主插件：配对、令牌、RPC 中继、mux 桥接 | — |
| `android/` | Kotlin 壳 + **原生审批中继前台服务**（锁屏也能收审批并直接作答） | 3277 行 Kotlin |
| `scripts/` | 单元测试 + `e2e-app-ui.mjs`（CDP 驱动 WebView）+ 打包/配对/发版工具 | — |
| `docs/` | 协议 / 设计 / 拆解 / 真机验收 / 本文档 | — |
| `docs/desktop-teardown/` | 桌面版拆解（chat UI / 附件 / 侧边栏 190 主题 token / 缺口审计） | — |

## 5. 环境陷阱（都踩过，别再花时间）

1. **PowerShell 5.1**：无 `pwsh`；`.ps1` 含中文必须存成**带 BOM 的 UTF-8**；`Set-Content` 会写 ANSI → 一律 `[IO.File]::WriteAllText($p,$t,[Text.UTF8Encoding]::new($false))`；`.cmd`/`.bat` 被 cmd.exe 按 ANSI 读，**必须纯 ASCII**。
2. **vite 报 `remove ...\Temp\esbuild-*: Access is denied`**：本次实测进程列表里**根本没有 esbuild 进程**，所以"杀进程"不一定管用。稳的做法是把 `TEMP`/`TMP` 指到工作区内：
   `$env:TEMP=(Resolve-Path .temp).Path; $env:TMP=$env:TEMP`（`.temp` 已 gitignore）。改名后 `verify` 一次通过。
3. **写文件偶发 `ReplaceFileW EIO (Win32 1175)`**：本次遇到 2 次，**原样重试一次**即可（防病毒/索引器短暂占用）。
4. **真机 localStorage 落盘有延迟**：刚写完就 `am force-stop` 会丢，先按 HOME 转后台再杀（`restartApp()` 存在的原因）。
5. **CDP 只在 debug 构建可用**；`uiautomator` 对 WebView 返回空树（所以一切 UI 验收都走 `webview_devtools_remote_<pid>`，注意 pid 变了要重新 `adb forward`）。
6. **Tailwind v4 的自动源探测会扫构建产物**（v1.0.7 已修，见 `src/index.css` 顶部注释）：新增会被扫描的目录时要留意，否则产物又开始依赖构建历史。
7. **GitHub 发版没有 `gh` CLI**：走 REST API，令牌从 `git credential fill` 取（脚本模式见 `.scratch/release-v107.ps1`，`.scratch/` 不入库）。

## 6. 协作铁律

- **Lead 绝不能在写手有未提交改动时构建/打包** —— 会把半成品打进产物（实测过：整片白屏，而 RPC 仍返回 200，排查方向极易跑偏）。
- 写手禁跑 vite / gradle / tsc；构建由 Lead 统一做。
- **每条结论必须带 `文件路径:行号`**；引用不存在的行号视为不合格。
- 测试要能**变红**（变异验证）：写完断言先证明它在旧代码上失败，再证明修复后转绿。

## 7. 仍未做的（诚实清单）

| 缺口 | 难度 | 现状与入口 |
|---|---|---|
| **浅色主题** | 大 | 施工输入齐全：`docs/desktop-teardown/04-sidebar-layout.md` 有 190 个主题 token + 15 条移动端映射。**但移动端现状是深色硬编码**：`src/index.css` 只有 20 个自定义变量，`src/**` 里 **682 处**硬编码 hex —— 这不是"换个变量表"能完成的量级 |
| **文件传输主路径**（浏览电脑文件树 → 发 `@路径`） | 中 | 结论在 `03-attachment.md`：手机侧最省事是引用电脑路径（零字节传输）。未做，因为要先确认 `workspaceFiles.*` 能否过网关 |
| **计划模式进阶 / 后台任务 / 子代理导航 / 定时** | 中 | 方法名来自 ui-* 注入契约，**落地前必须对活主机探针核对**，不能照抄桌面版 |
| **ColorOS 真机通知权限** | — | `pm grant` 与 appops 都拒绝授权，**必须用户手动开**（App 内已有引导 + 跳设置页）。非本机可修 |
| **CI** | 小 | 目前**没有** `.github/`。要上的话先解决：`scripts/test-android.mjs` 硬编码了本机 JDK/Gradle 路径（`C:\Users\20247\Downloads\android-toolchain\...`），得先参数化或跳过 android 段 |

## 8. 命令速查

```powershell
# 环境：node 在 PATH 上（v24.18.1），但 npm/pnpm 没有；vite 构建请先用工作区内 TEMP
$env:TEMP=(Resolve-Path .temp).Path; $env:TMP=$env:TEMP
$adb = "C:\Users\20247\Downloads\android-toolchain\android-sdk\platform-tools\adb.exe"

# 测试 / 构建
node --run verify                 # 584 条断言 + tsc + vite build
node --run build:apk              # 产物 dist-apk\dsh-mobile-v<版本>.apk（版本号从 build.gradle.kts 读）
# Android 单测要真跑（否则 Gradle 报 UP-TO-DATE 复用旧结果）：
$env:JAVA_HOME="C:\Users\20247\Downloads\android-toolchain\jdk17"
& "C:\Users\20247\Downloads\android-toolchain\gradle-8.11.1\bin\gradle.bat" -p android testDebugUnitTest --rerun-tasks

# 端到端（真机/模拟器先 reverse）
& $adb -s emulator-5554 reverse tcp:19387 tcp:19387
& $adb -s emulator-5554 reverse tcp:19400 tcp:19400
node scripts/e2e-app-ui.mjs --serial=emulator-5554 --scenario=all
node scripts/e2e-app-ui.mjs --serial=emulator-5554 --scenario=stats   # 单场景调试

# 发版（无 gh CLI，走 REST API；脚本在 .scratch/，不入库）
#   1. 改 android/app/build.gradle.kts 的 versionCode/versionName
#   2. node --run build:apk
#   3. commit + tag + push
#   4. powershell -NoProfile -ExecutionPolicy Bypass -File .scratch\release-v107.ps1
```

## 9. 我做错过的事（别重蹈）

1. **没有先读桌面版就动手** → 一路打补丁。用户原话："设计时候没有完整读取人家桌面版，现在到处打补丁了"。改成先拆解再实现。
2. **用固定 `sleep` 当判据** → 偶发假红。必须"等条件成立 + 超时明确"。
3. **断言写成"JSON 里有 true"** 这种松判据 → 被别的字段蒙混过关，真机复查才暴露。
4. **凭猜测写文档/注释**（比如"状态栏数字在 session/list 里"）→ 实测才发现真源是 `session/projections`，args 形状也完全不同。
5. **只断言 `innerText` 的测试抓不到视觉截断**（v1.0.7 实测）：`text-overflow: ellipsis` 只做视觉裁剪，`innerText` 仍是全文 —— 状态栏三段被压到 79/154、84/163、**0/33** 全在吞字，文本断言却**全绿**。
   → 教训：凡是"用户能不能看见"的断言，**必须量 `clientWidth / scrollWidth`**，不能只查文本。
6. **用了但从未定义的 CSS 类没人报错**（`no-scrollbar` 用了两处、全项目无定义）→ "隐藏滚动条"从未生效。
   → 教训：自定义 utility 要么有定义，要么别写；页面看起来很"脏"的一根线往往就是这种死类。