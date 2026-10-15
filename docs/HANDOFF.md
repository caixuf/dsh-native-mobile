# 交接文档 · DSH Native Mobile

> 交接时间：2026-10-15 下午　|　最新发布：**v0.4.4**　|　最新提交：`39b18dd`
> 仓库：https://github.com/caixuf/dsh-native-mobile　|　本机路径：`C:\Users\20247\Downloads\aiwork\dsh-native-mobile`

**一句话现状**：功能侧已交付 5 个可安装版本；正在按"拆解桌面版 → 系统性对齐"的新方法补齐会话界面能力。
**接手第一件事**：读下面 §2「未提交的工作」，那里有一个**已知未完成项**（readability 端到端场景会卡死）。

---

## 1. 已经发出去的（都验证过，可直接用）

| 版本 | 内容 | 下载 |
|---|---|---|
| v0.4.4 | 注入上下文折叠成注记 + 工具独立耗时 + 每轮总结 + 真机首轮验收 | [APK](https://github.com/caixuf/dsh-native-mobile/releases/download/v0.4.4/dsh-mobile-v0.4.4.apk) |
| v0.4.3 | 工具名说人话（不再显示 `pwsh`/`web_search`） | 同上目录 |
| v0.4.2 | 过程条 + 步骤分隔线 + 实时过程（`session/follow`） | 同上目录 |
| v0.4.1 | 实时过程改走 `session/follow`，修掉"卡一会儿忽然出结果" | 同上目录 |
| v0.4.0 | 实时流 + 归档 + 重命名 + 可读性 + 9 场景端到端 | 同上目录 |

**验证口径**：`node --run verify` → **561 条断言**（client 371 / gateway 96 / android 94）。
端到端 `node scripts/e2e-app-ui.mjs --scenario=all` → **10 个场景**（chain / collapse / archive / queue / session-ops / readability / live / stats / bad-token / approval）。

**⚠️ ColorOS 手机（如真机 RMX5200 / Android 17）**：`pm grant` 与 appops 都拒绝授权通知权限，**通知必须用户手动开**（App 内有引导 + 跳设置页）。

---

## 2. 未提交的工作（接手先处理这个）

`git status` 里有一批改动，**都没有提交**：

```
新增  src/lib/session-stats.ts            底部状态栏的数据解析与格式化（纯函数）
新增  src/components/chat/SessionStatsBar.tsx   状态栏组件
新增  scripts/test-session-stats.mjs      10 条测试（已做变异验证）
改动  src/App.tsx                         接线：session/projections 拉取 + 快照择多保留
改动  src/components/screens/ChatScreen.tsx   传入 readouts
改动  src/lib/session-page.ts             pickRicherLines（快照/翻页择多保留）
改动  scripts/e2e-app-ui.mjs              新增 stats 场景；readability 改为自造样本
改动  scripts/test-session-page.mjs       +1 条 pickRicherLines 测试
新增  docs/desktop-teardown/              4 份拆解文档（见 §4）
```

### 2.1 🔴 已知未完成项：readability 场景会卡死

`scripts/e2e-app-ui.mjs` 的 `scenarioReadability` 第一步改成"自己造一条长消息当样本"
（新建会话 → 发指令要 agent 原样吐出 `package.json` → 等宿主出现 >800 字的助手消息，**上限 90 秒**）。
**实测这个等待不收敛**：`--scenario=all` 跑了 40 分钟零输出，被手工杀掉。

可能原因（未验证，按可能性排序）：
1. 新建的空会话发 prompt 后，host 侧 agent 没被真正驱动（对照：`chain` 场景同样流程是通过的）；
2. 回复始终不到 800 字，循环空转到 90 秒后 `expect` 失败，但 `hostPageRecords` 每轮自身还有超时，叠加放大；
3. 与 `stats` 场景争抢"最近会话"，挑错了 sessionId。

**接手建议**：先把这一步的等待改成**短超时 + 明确失败信息**（例如 30 秒），或改回"扫描已有会话找长消息"（旧实现在 git 历史里），别让它无限等。

### 2.2 已验证通过的部分（可以放心保留）

- `node --run verify` **全绿**（含新增的 10 条 session-stats 测试）
- `tsc -b` 通过；APK 构建安装正常
- **`--scenario=stats` 单独跑 3/3 通过**，设备实显：
  `20 轮 937 步 · 293 tok/s　347M tok · 缓存命中 94.5%　上下文 38.3%`
  与宿主 `session/projections` 真值**逐项断言一致**
- `pickRicherLines` 修的是真 bug：超大会话（900+ 步）点开一片空白，而 `session/page` 明明 200 过

---

## 3. 🔴 协议事实（全部真主机实测，**别再猜**）

| 事实 | 说明 |
|---|---|
| 端点用**斜杠** | `session/list`、`session/page`、`session/prompt`… 写成点号会 404 `not found` |
| payload 包一层 | `{args:{...}}`；args 键名 = 服务端形参名（`session/list`→`_request`，其余→`request`） |
| **实时内容走 `session/follow`** | args `{request:{address:{kind:'session',sessionId}}}`；先 `item:snapshot`（含 cursor+records，**裸事件**无 `{event:...}` 包装），随后逐条 `item:event`。`{request:{sessionId}}` 会被边界校验拒 |
| `$events` 只有粗粒度信号 | 只有 `api-session/status`（args=`[sessionId, running]`）、`api-session/activity`、`api-session/added`。**不含任何内容事件** |
| **统计数字在 `session/projections`** | args 是**扁平** `{request:{sessionId}}`。`{request:{address:{...}}}` 会被拒。`session/list` 里**没有**这些字段 |
| **`session/modelCatalog` 不接参数** | 空对象 `{}` 即可。返回 `{default:{provider,model}, routableProviders:[…], groups:[{id,name,models:[{id,name,reasoning?{efforts:[…]}}]}]}` |
| 审批应答 | RPC `$events/result`，args `{clientId, eventId, outcome}`；`outcome.value` 必须是**裸字符串** `allowed-once\|rejected\|cancelled\|unavailable`（词表外的值**不报错**、被静默归一化成 `unavailable`=拒绝） |
| 没有 archive 端点 | 桌面版的归档是 host 能力（`workspace/archiveSession`），我们网关走 `session.*` 族，所以移动端只能**本机归档**（UI 已如实标注） |

---

## 4. 拆解文档（`docs/desktop-teardown/`，本轮新增）

| 文件 | 行数 | 核心结论 |
|---|---|---|
| `01-chat-ui.md` | 367 | 会话界面信息架构 + **41 条交互清单** + 7 个 projection/11 个端点的数据契约。**桌面版没有流式光标**（是 `data-streaming`+`TextShimmer`），**没有**手动重试/编辑已发消息，用户消息不渲染 markdown |
| `03-attachment.md` | 337 | 普通文件走 `POST /api/session/uploadFileBinary`（**原始字节**）→ 消息只带 `{type:'file',receiptId}`；**图片走 `content:[{type:'image',mediaType,data:base64}]`**；都落成 `user/message` 事件。**手机最省事方案：引用电脑路径**（`@path`，零字节传输） |
| `04-sidebar-layout.md` | 614 | 侧边栏按 Workspace 实体分组（非 cwd 字符串）；右栏是每会话一个 dock（files/terminal/browser/text/changes-review/guide）；**190 个主题 token 全表** + 15 条移动端映射 = 浅色主题的施工输入 |
| `06-gap-audit.md` | 252 | 64 个包逐包对账 + **Top 10 缺口** |
| `02-model-selection.md` | ❌ 未完成 | 已把实测到的 `modelCatalog` 返回结构喂给子智能体，仍未产出 |
| `05-stats-context.md` | ❌ 未完成 | 已把实测到的真实 projection 数值喂给子智能体，仍未产出 |

**桌面版源码**（只读，克隆在**工作区之外**）：`C:\Users\20247\Downloads\oss-study\deepseek-harness`
⚠️ 里面有多份 `AGENTS.md`/`CLAUDE.md`，DSH 运行时会把它们当项目指令自动加载 —— 所以必须克隆在工作区外，且**绝对不要写入该目录**。

---

## 5. 剩下的缺口（按对账表排序）

| # | 缺口 | 难度 | 备注 |
|---|---|---|---|
| **P0** | **审批/提问支持多选 + 自由输入** | 低 | **纯前端**，当前只取 `questions[0]` 单选 → 用户被卡死、任务停住。最高优先级 |
| 1 | 模型切换 | 低 | 端点已实测可用（`modelCatalog` 无参、`selectModel` 待核 args），差 UI |
| 2 | 斜杠命令 + 技能面板 | 中 | `command.list`/`command.execute`/`skill.list` |
| 3 | 文件传输（主路径：浏览电脑文件树 → 发 `@路径`） | 中 | 需确认 `workspaceFiles.*` 能否过网关 |
| 4 | 本轮改动文件卡 | 中 | `changes.summary` + `changes.diff` |
| 5 | 浅色主题 | 大 | 施工输入已在 `04-sidebar-layout.md`（190 token + 15 条映射）；移动端现状：`src/index.css` 只有 15 个深色变量、组件里约 531 处硬编码 hex |
| 6 | 拍照/相册 → 图片附件 | 中 | **我们的 WebView 没有 `onShowFileChooser`**，网页 `<input type=file>` 点了没反应，需要原生桥 |
| 7 | 计划模式 / 目标条 / 后台任务 / 子代理导航 / 定时 | 中 | 方法名来自 ui-* 注入契约，**落地前必须对活主机探针核对** |

---

## 6. 命令速查

```powershell
# 环境（本机 node 不在 npm 侧，node 在 PATH 上但 npm 没有）
$node = "C:\Users\20247\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$adb  = "C:\Users\20247\Downloads\android-toolchain\android-sdk\platform-tools\adb.exe"

# 测试与构建
& $node --run verify                 # 561 条断言
& $node --run build:apk              # 产物在 android/app/build/outputs/apk/debug/
Copy-Item android\app\build\outputs\apk\debug\app-debug.apk dist-apk\dsh-mobile-vX.Y.Z.apk -Force

# 端到端（--serial 可指定设备；真机要先 adb reverse + forward CDP）
& $adb -s <serial> reverse tcp:19387 tcp:19387
& $node scripts\e2e-app-ui.mjs --serial=<serial> --scenario=all
& $node scripts\e2e-app-ui.mjs --serial=<serial> --scenario=stats   # 单场景调试

# 发版（无 gh CLI，走 REST API；脚本已参数化）
powershell -NoProfile -ExecutionPolicy Bypass -File .scratch\release-v040.ps1
```

---

## 7. 环境陷阱（都踩过）

1. **PowerShell 5.1**：无 `pwsh`；`.ps1` 含中文必须存成**带 BOM 的 UTF-8**；`Set-Content` 写 ANSI/GARBAGE → 一律用 `[IO.File]::WriteAllText($p,$t,[Text.UTF8Encoding]::new($false))`
2. **vite 偶发报 `remove ...Temp\esbuild-*: Access is denied`**：根因是**残留 esbuild 进程**占句柄。`Get-Process esbuild | Stop-Process -Force`，或把 `TEMP/TMP` 指到工作区内
3. **真机 localStorage 落盘有延迟**：刚写完就 `am force-stop` 会丢（LevelDB 没刷盘）。**先按 HOME 让页面转后台再杀**就能扛住 —— 这是 `restartApp()` 存在的原因
4. **CDP 在 WebView 上才可用**（debug 构建才开 `setWebContentsDebuggingEnabled`）；uiautomator 对 WebView 返回空树
5. **主机协议用斜杠**；探针里写成点号会得到 404 `not found`（这个坑我踩了两次）

## 8. 协作铁律

- **Lead 绝不能在写手有未提交改动时构建/打包** —— 会把半成品打进产物（实测：整片白屏 + RPC 仍 200，极难排查）
- 写手禁跑 vite/gradle/tsc；Lead 负责构建
- **每条结论必须有 `文件路径:行号`**；引用不存在的行号视为不合格；测试要能红（变异验证）

---

## 9. 我做错过的事（别重蹈）

1. **没有先读桌面版就动手** → 一路打补丁。用户的原话："设计时候没有完整读取人家桌面版，现在到处打补丁了"。现在改成先拆解再实现。
2. **凭"代码没报错"当通过**：注入假 fetch 的单测永远抓不到 `Illegal invocation`（整条网页 RPC 全废而单测全绿）。
3. **用固定 `sleep` 当判据** → 偶发假红。必须"等条件成立 + 超时明确"。
4. **断言写成"JSON 里有 true"** 这种松判据 → 被别的字段蒙混过关，真机上复查才暴露。
5. **凭猜测写文档/注释**（比如"状态栏数字在 session/list 里"）→ 实测才发现真源是 `session/projections`，且 args 形状完全不同。
