# 整 app 端到端验证报告（T5 独立验证）

> ## 🔄 复验更新（本报告首轮之后的修复轮）
>
> 首轮验证对象是 `024afe1`。此后报告里列出的问题**已全部修掉**，
> 并在新 commit 上重跑 `--scenario=all`：**6 个场景全绿**
> （chain 10/10、collapse 6/6、archive 4/4、queue 6/6、bad-token 4/4、approval 5/5）。
>
> | 报告里的结论 | 现状 |
> |---|---|
> | F1 fetch 接收者丢失 | ✅ 已修；并加了「接收者必须是 globalThis」的严格桩回归（还原 bug 会逐字复现浏览器报错） |
> | F2 聊天内容映射三连（P0） | ✅ 已修：user 走 `data.content`、assistant 跳过 reasoning 取全部 text 段、`system/message` 不再渲染 |
> | F3 归档入口不可达 | ✅ 已修；顺带修掉**双写入方**（组件在受控模式仍写 localStorage） |
> | F4 子代理会话静默失败 | ✅ 已把主机原因显示在横幅并指路父会话（主机侧仍不支持用 `session.page` 读子代理记录） |
> | F5 切会话串台 | ✅ 已修：切开时先清空 + fetch 回来校验 sessionId 未变 |
> | （Lead 追加）发送后回复不渲染 | ✅ 已修：turn watch 只在**见过 running=true 之后**的 false 才停，并 1s 边转边刷 |
>
> **一处契约变更（是变好，脚本已同步）**：T8 之后「发送时网络失败」不再报错+留草稿，
> 而是**落盘进离线待发队列**（连上自动补发），草稿因此可以清空。
> 脚本现在断言的不变量是「**字不能丢**（草稿里或 outbox 里）+ **必须告知用户**」。
>
> 另修掉两条**脚本自身**的判据问题（会造成假红）：归档场景的 `stillVisible` 把
> **归档区里的卡片**也算成工作区卡片；场景不清归档状态导致多次运行累积。

> 验证者：teammate `verifier`（独立验证；**没有改** `src/**`、`electron/**`、`packages/**` 一行代码）
> 验证对象：commit **`024afe1`**（`fix(conn): 修掉让整条网页 RPC 全废的 fetch 接收者丢失（真机实测）`）**以及由它构建的 APK**
> APK：`dist-apk/dsh-mobile-v0.4.0.apk`（versionCode 7，设备侧 `assets/index-CsNvWyDz.js`）
> 设备：模拟器 `emulator-5554`（AVD `dsh_test`，1080×2400）；真网关 `http://127.0.0.1:19387`（`adb reverse tcp:19387`）
> 所有结论都附**命令输出原文**；没有原文的一律归到 §9「仍未验证」。
>
> ⚠️ **范围声明**：本报告的设备侧结论全部来自**上面那个已安装的 APK**（bundle 哈希在设备上实测确认）。
> 单测结论（`node --run test`，274 条）是在**工作树仍等于 `024afe1`**（`git diff HEAD` 为空）时采集的。
> 验证期间 Lead 已开始第二波并修改了 `src/App.tsx`、`src/lib/session-page.ts`、`android/**` 等
> （`git diff --stat HEAD` 可见），**这些改动不在本次验证范围内**；§8 里标"未修"的项都是针对 `024afe1` 的判断。

---

## 0. 结论摘要

**交付物①可用**：`node scripts/e2e-app-ui.mjs` 一条命令跑完"配对页 → 真配对 → 按工作区分组 → 折叠/展开 → 打开会话看历史 → 新建会话发 ASCII 指令 → 校验指令与回复都真的渲染出来 → console 无 error"，退出码 0/1，失败点名**具体步骤**并附现场。

| 面 | 结果 |
|---|---|
| 交付物① 整链路（`--skip-send`，8 步） | ✅ **全绿 20s**（配对/分组/折叠/历史非空/无 console error） |
| 交付物① 整链路（完整，含发送+回复） | ❌ **必然在第 9 步失败** —— 根因是 App 聊天页的内容映射缺陷（见 F2），不是发送链路 |
| T1 分组 | ✅ 8 个工作区、按 cwd 正确分组、最近的组默认展开 |
| T1 折叠持久化（**真重启进程**） | ✅ pid 变过、默认是"展开"、重开后仍读到"折叠" |
| T1 归档隐藏/恢复 | ❌ **不可验证：真 app 里根本没有归档入口**（F3） |
| T2 运行中输入可用 / 队列删除 / 失败保草稿 | ✅ 三条都实测通过（假主机断连制造真失败） |
| T3 坏令牌 → 停止重连 + UI 提示 | ✅ 34s 内只 1 次 WS 握手 + 1 次 HTTP 探测，再静置 10s 仍停 |
| T3 已应答审批重启后不再弹 | ✅ 假主机重放同一 eventId 3 次，横幅/卡片都不再出现 |
| T3 设备唯一名 | ✅ 网关侧 9 台 web 设备 9 个唯一名 |
| T4 桌面壳 | ✅ 56/0 真绿；**5 组变异全部能红**（不改作者文件） |
| 全量单测 | ✅ `node --run test` exit 0，共 **274** 条断言 |

**发现 5 个真问题，全部落在 Lead 的集成层（T1–T4 交付物本身的核心承诺都成立）**：

1. **F1**（P0，**已由 Lead 修复，本轮复验通过**）`this.fetchImpl(...)` 丢失接收者 → 整条网页 RPC 全废；
2. **F2**（P0，**未修**）聊天页内容映射三连：
   - **F2a（确定性）**：`user/message` 的文本在 `data.content`，App 读 `data.message.content` → **自己发的指令永远显示为空气泡**（实测 5 个气泡全是 `""`）；
   - **F2b（随模型而变）**：助手 `content` 多段时只取 `content[0].text`；模型先输出 reasoning 时**把私有推理当回答**、真正正文被吞；
   - **F2c**：所有非 user 事件都渲染成助手气泡 → **整段系统提示词（1 万多字）出现在聊天里**；
3. **F3**（P1，**未修**）`App.tsx` 没把 `onArchive/onUnarchive/archivedIds` 传给 `SessionsScreen` → **归档功能在真 app 里不可达**（131 张卡片 0 个归档按钮）；
4. **F4**（P1，**未修**）**子代理会话打不开**：`kind:'subagent'` 被 wire schema 拒；`kind:'session'` 的各种 parent 形状都被主机以 `subagent Sessions require their durable parent address` 拒；App 把异常吞成 `console.warn`，用户只看到空历史；
5. **F5**（P2，**未修**）切会话时**旧会话消息串台**：刚进新会话时时间线里还是上一个会话的 386 个节点，2–3s 后才落定。

> 另有一条"我自己的假绿"教训（§3.3）：第一版断言用"页面里有没有那串字"判回复，被**模型 reasoning 里复述的同一串字**骗过，一度给出 3 次"通过"。改成"从宿主记录取真正文 + 要求卡片正文**相等**"后，问题才暴露。

---

## 1. 方法与边界

### 1.1 为什么是 CDP

App 是「一个 WebView 承载整个 SPA」，而 **WebView 的 DOM 不对 uiautomator 暴露**（`uiautomator dump` 是空树），坐标点击既脆又只会说"点空了"。所以整条验证走 WebView DevTools 协议：

```bash
adb -s emulator-5554 shell pidof io.github.dshmobile.app
adb -s emulator-5554 forward tcp:9222 localabstract:webview_devtools_remote_<pid>
# GET http://127.0.0.1:9222/json → webSocketDebuggerUrl → WS + Runtime.evaluate
```

- ⚠️ 抽象 socket 名带 **pid**：`am force-stop` 后必须重新 forward（脚本每次重启都重新 `attach()`）。
- WS 客户端用 Node 24 内置全局 `WebSocket`；只在假主机里用仓库的 `ws` 起服务端（同时兼容 named / default 导入）。
- 观测包装（netlog）经 `Page.addScriptToEvaluateOnNewDocument` 注入，统计 `fetch`/`WebSocket` 调用与 HTTP 状态。

### 1.2 观测本身也可能改变被测系统（两次踩坑，都靠 A/B 排除）

1. 我第一版 fetch 包装写成 `OF.call(this, ...)`。App 的调用点是 `await this.fetchImpl(url)`（getter 返回 `fetch`），`this` 是 `DshConnection` 实例 → 原生 fetch 抛 `Failed to execute 'fetch' on 'Window': Illegal invocation`。
   **A/B 判定**：`--no-netlog`（完全不注入任何包装）时同一步仍然失败 → 失败与我无关；真机页面直接量语义也证实：

   ```
   fetch.call(null, url)                                  → ok 200
   const o={F:fetch};        o.F(url)                     → ERR Illegal invocation
   const o={get F(){return fetch;}}; o.F(url)             → ERR Illegal invocation
   Object.prototype.hasOwnProperty.call(window,'fetch')   → true（原型上无兜底）
   ```

   包装改为 `OF.call(window, ...)` 后恢复。这同时是 §8 F1 的独立复现。
2. 我用 `hasAssistantText(哨兵)` 判"回复渲染出来了"，被模型 reasoning 里复述的同一串字骗过（§3.3）。

### 1.3 配对码只有一枚（测试隔离）

```
mint#1 pin = 023 449 display = dshm1.ATRK-6ATG-9Z6R-HUW3
mint#2 pin = 235 324 display = dshm1.7DP9-SHZ7-9JJ2-4HHK
用 mint#1 去配对 → 403 {"code":"mismatch","message":"配对码不匹配"}
用 mint#2 去配对 → 200 "ok"
```

我在跑链路的同时用宿主脚本铸了探针码，把 App 正在用的那枚顶掉了 → 链路第 4 步假失败（页面原文 `当前没有有效配对码，请在电脑上重新生成`）。
已修：脚本改成**填表那一刻才铸码**（间隔 <1s）；§10 写明"跑 e2e 时不要并行铸码"。

### 1.4 退出码与失败定位

失败 `exit 1`，并自动附上现场（最近 8 条 fetch 状态/失败原因 + 页面文字 + 该步自己带的证据），例如：

```
✗ 失败：场景 archive，具体失败步骤「2. 点「归档」→ 卡片从分组消失、出现在「已归档」区」
  会话卡片上没有任何「归档」按钮（卡片 131 个）—— SessionCard 的归档按钮仅在 onArchive/onUnarchive
  被传入时渲染，而 App.tsx 渲染 <SessionsScreen ... /> 时**没有传**这两个回调 …
```

---

## 2. 交付物①：`scripts/e2e-app-ui.mjs`

```
node scripts/e2e-app-ui.mjs                      # 整 app 链路（默认）
node scripts/e2e-app-ui.mjs --scenario=all       # 链路 + 全部对抗性场景
node scripts/e2e-app-ui.mjs --scenario=collapse  # T1 折叠持久化（真重启进程）
node scripts/e2e-app-ui.mjs --scenario=archive   # T1 归档隐藏/恢复（真重启进程）
node scripts/e2e-app-ui.mjs --scenario=queue     # T2 运行中输入/队列删除/失败保草稿
node scripts/e2e-app-ui.mjs --scenario=bad-token # T3 令牌失效 → 停止重连 + UI 提示
node scripts/e2e-app-ui.mjs --scenario=approval  # 待审批横幅 + 应答 + 重启不再弹
# 其它：--skip-send --keep-state --no-netlog --serial= --port= --json=<证据文件>
```

- 自带**假主机**（`127.0.0.1:19400`，需 `adb reverse tcp:19400`）：只实现信号面最小子集
  （`session/list`、`session/page`〔**故意先回 `past cursor` 报错**，走 App 真实的重试路径〕、`session/prompt`、`session/create`、`$events/result` + mux WS），
  并**逐字校验**应答形状（args 键集合、clientId、eventId、`outcome.value` 必须在主机词表内）。
- **回复判定用宿主真值**：脚本用 App 自己的令牌直连主机读 `session.page`，取出 assistant 记录的 `text` 段，再要求 App 把**同一串正文原样**渲染成助手卡片正文（相等比较，而不是"页面里有没有这串字"）。
- 收尾一定把设备指回真网关（令牌先验证有效），并吊销本次临时铸造、最终没在用的设备令牌。

---

## 3. 整 app 链路（chain）

### 3.1 `--skip-send`：8 步全绿（20s，原文）

```
✓ 1. preflight：adb / 模拟器 / 真网关都可用
✓ 2. 启动 app 并清空本地状态 → 停在配对页
    证据: {"onPairScreen":true,"baseUrl":"http://127.0.0.1:4142","code":null,"pins":[null,null,null,null,null,null],"submitting":false}
✓ 3. 铸真配对码并填进配对页（6 位 PIN 输入框）
    证据: {"pinDisplay":"126 053","baseUrl":"http://127.0.0.1:19387","pins":"126053","hiddenCodeInput":"126053"}
✓ 4. 点「完成配对」→ 真网关接受 → 进入会话列表并出现按工作区的分组
    证据: {"groupCount":8,"groups":[{"label":"dsh-native-mobile 的会话列表","expanded":true,"header":"dsh-native-mobile\n19\n3 运行中"},
          {"label":"claude-code-providers 的会话列表",...},{"label":"aiwork 的会话列表",...},{"label":"desktop 的会话列表",...}]}
✓ 5. 分组概览正确（N 个工作区 · M 个会话）   证据: {"matched":"8 个工作区 · 132 个会话"}
✓ 6. 折叠 / 展开一个工作区组（aria-expanded + panel hidden + 子树清空）
    证据: {"collapsed":{"expanded":false,"hidden":true,"childCount":0},"reopened":{"expanded":true,"hidden":false,"childCount":1}}
✓ 7. 打开一个会话 → 历史记录真的渲染出来（非空）
    证据: {"history":{"onChat":true,"userBubbles":2,"assistantCards":224,"specularCards":345,"timelineChildren":348}}
          ← 这就是 session.page 那两个 bug 的回归：address 带 kind、throughSeq 先探再重试
✓ 8. 整轮运行没有 JS console error / 未捕获异常
    证据: {"consoleErrorCount":0,"resourceErrors":[],"knownNoiseIgnored":1,"totalLogs":2}

✓ 全部通过：chain      用时 20s
```

`knownNoiseIgnored:1` = App 默认地址 `127.0.0.1:4142` 探测失败的**网络层**日志（预期噪音，已显式白名单）。

### 3.2 完整链路：第 9 步失败（原文，判定基准 = 宿主真值）

```
  ✓ 8. 新建一个一次性会话（不污染用户既有会话）
    · 宿主真值：content 分块=[reasoning,text] 正文="E2E-REPLY-7719"
    · 同一记录的 reasoning="The user wants me to reply with exactly: E2E-REPLY-7719 … Just reply with that exact text."
  ✗ 9. 发送 ASCII 指令 → 我的指令可见 + 助手正文原样渲染（判定基准取宿主记录）
    我发出的指令没有渲染成用户气泡：实测 5 个用户气泡，文本是 ["","","","",""]
      （user/message 记录的文本在 data.content[0].text，而 App 读的是 data.message.content[0].text → 永远取不到）
      ／ 助手正文没有原样渲染：宿主正文="E2E-REPLY-7719"，content 分块=[reasoning,text]，
        App 渲染出的助手卡正文=["You are an AI agent powered by DeepSeek Harness.…(+12252)", "The user wants me to reply …"]
    证据: {"hostTruth":{"partTypes":["reasoning","text"],"replyText":"E2E-REPLY-7719"},
          "renderedUserBubbles":["","","","",""],
          "renderedAssistantBodies":[…系统提示词…, …reasoning…]}
```

另一轮（模型这一步没输出 reasoning）：

```
    · 宿主真值：content 分块=[text] 正文="E2E-REPLY-7719"
  ✗ 9. … 我发出的指令没有渲染成用户气泡：实测 5 个用户气泡，文本是 ["","","","",""]
    证据: {"obs":{"bubbles":["","","","",""],"bodies":[…系统提示词(+12252)…, "E2E-REPLY-7719"]}}
```

→ **用户气泡永远是空的（确定性）**；助手正文只有在 `content[0]` 恰好是 `text` 段时才渲染得出来。

### 3.3 我自己的"假绿"，以及为什么最终判定换了基准

第一版断言是"页面里出现哨兵就算收到回复"（`hasAssistantText` 搜 `.specular-card`）。它**连续 3 次报通过**，但其中 3 条会话的 `content[0]` 都是 reasoning：

```
### session-5401946e…  assistantRecords=1
  [0] parts=2 reasoning:"The user wants exactly \"E2E-REPLY-7719\". Just" || text:"E2E-REPLY-7719"
### session-2857d82c…  [0] parts=2 reasoning:"The user wants exactly \"E2E-REPLY-7719\". This" || text:"E2E-REPLY-7719"
### session-3980cef5…  [0] parts=2 reasoning:"The user asks to reply with exactly: E2E-REPLY-7719. Simple." || text:"E2E-REPLY-7719"
### session-03890cb5…  [0] parts=2 reasoning:"The user asks to reply exactly with a token. Just reply." || text:"E2E-REPLY-7719"
```

模型在 reasoning 里**复述了哨兵**，所以"页面里有没有这串字"被命中 —— 真正的助手正文一个字都没渲染。
换成现在的判定（宿主真值 + 卡片正文**相等**）后，这个问题立刻稳定暴露。

> 这条与 §1.2 是同一类教训：**断言写得"松"会把缺陷照成绿的**。本项目的 T3 单测也踩过同一个坑（假 fetch 不检查接收者）。

---

## 4. T1 会话分组 / 折叠 / 归档

### 4.1 分组正确 —— ✅

见 §3.1 第 4/5 步：8 个工作区 132 个会话，组标题 = 工作区 basename，组内计数与"运行中"标记都对，最近的组默认展开、其余默认折叠（与 `defaultCollapsedState()` 一致）。

### 4.2 折叠状态**真重启进程后仍记得** —— ✅（`--scenario=collapse`）

刻意选**默认展开**的组去折叠（默认值是"展开"，所以"没记住"必然长成展开），再 `am force-stop` + `am start`：

```
✓ 2. 读到分组与默认折叠状态 (76ms)
✓ 3. 主动折叠「dsh-native-mobile 的会话列表」并把状态写进 localStorage (1488ms)
    证据: {"after":{"expanded":false,"hidden":true,"childCount":0},
          "localStorage":"{\"C:/Users/.../dsh-native-mobile\":true,\"…::subagents\":false, …}"}
✓ 4. force-stop 真重启 app 进程（pid 必须变 → 重新 forward + 重新附着 CDP） (7664ms)
    证据: {"oldPid":"10616","newPid":"10753","cdpTarget":"file:///android_asset/web/index.html"}
✓ 5. 重开 app 后「dsh-native-mobile 的会话列表」仍然是折叠的（不是回落到默认展开） (734ms)
    证据: {"afterRestart":{"expanded":false,"hidden":true,"childCount":0},"defaultExpanded":true}
✓ 6. 展开回来（恢复原状） (635ms)
✓ 全部通过：collapse
```

**pid 真的变了**（10616→10753），重开后读回 `expanded:false`，而默认是 `true` → 真持久化，不是碰巧。

### 4.3 归档是否真隐藏且可恢复 —— ❌ **不可验证：入口不存在**

```
✗ 2. 点「归档」→ 卡片从分组消失、出现在「已归档」区
    会话卡片上没有任何「归档」按钮（卡片 131 个）—— …
    证据: {"step":{"archiveButtons":0,"restoreButtons":0,"cards":131}, …}
```

`grep 'onArchive|onUnarchive|archivedIds' src/App.tsx` → **零命中**。
所以"归档是否真隐藏、能否恢复、重启后是否仍隐藏"这一条**没验**（不是没通过，是没入口）。
一旦接上，`--scenario=archive` 会立刻给结论。

---

## 5. T2 队列 / 草稿

全部 ✅（`--scenario=queue` 6/6，原文）：

```
✓ 3. 运行中（running）输入框仍可用，发送按钮变成「加入待发队列」 (272ms)
    证据: {"running":{"inputDisabled":false,"sendLabel":"加入待发队列","hasRunningBadge":true},
          "afterType":{"value":"E2E-QUEUED-002","disabled":false,"sendLabel":"加入待发队列"}}
✓ 4. 运行中发送 → 进入待发队列 → 删除该条 → 队列消失且没有误发 (4054ms)
    证据: {"queued":{"present":true,"text":"待发队列\n1 条\n任务结束后依次发送\n1\nE2E-QUEUED-002…",
          "removeLabels":["删除第 1 条待发消息"]},"gone":{"present":false},
          "after":{"queue":{"present":false},"misSent":false}}
✓ 5. 发送失败（session/prompt 这一跳被断连）→ 草稿真的保留 + 明确告警 + 落盘 (634ms)
    证据: {"alert":"消息未发送成功，草稿已保留，可直接重试\n重试","inputValue":"E2E-DRAFT-003",
          "draftRaw":{"dsh_chat_draft_v1:session-fake-e2e-1":"E2E-DRAFT-003"},"destroyedPromptSockets":2}
✓ 6. 把 baseUrl 指到真正不可达的端口：连接层如实报错、不伪造会话列表 (7456ms)
    证据: {"body":"遥控会话\n降级: 连接已关闭，准备重连…\n等待连接…","cards":0,
          "netlog":{"ws":4,"fetch":4,"responses":[],"failures":[{"url":"http://127.0.0.1:9/…/session/list","error":"Failed to fetch"} ×4]}}
```

要点：`running` 时输入框不禁用、发送按钮语义变"加入待发队列"；入队后删除**不会**被自动补发误发（等 3.5s 越过 1.5s 补发窗口确认 `misSent:false`）；发送失败时输入框保留原文 + `role=alert` 明说"草稿已保留" + **落盘**；不可达地址不伪造列表，且按 1s/2s/4s 退避重试（网络故障的正确策略）。

> 工具卡的细节（结果并回调用卡、>600 字符折叠、复制按钮、错误态自动展开）只验到"会渲染"，未逐项断言 → §9。

---

## 6. T3 连接层（真机 + 真网关）

### 6.1 坏令牌 → **停止重连**且 UI 提示重新配对 —— ✅（`--scenario=bad-token`）

```
✓ 2. 观察 24s：只允许 1 次 WS 握手，之后必须停止重连 (24084ms)
    证据: {"wsAttempts":1,"fetchAttempts":1,
          "wsUrls":["ws://127.0.0.1:19387/mobile-gateway/remote.mux?token=***"],
          "fetchUrls":["http://127.0.0.1:19387/mobile-gateway/api/session/list"]}
✓ 3. UI 明确提示"登录状态已失效 → 重新配对"，而不是静默转圈
    证据: {"body":"⚠️ 登录状态已失效（HTTP 401）：请在\"我的电脑\"里重新配对。 去处理\n遥控会话\n
          降级: 令牌已失效（HTTP 401），已停止自动重连，需要重新配对\n…","hasAuthBanner":true,"mentionsRepair":true}
✓ 4. 静置再观察 10s：确认真停了（不是刚好在退避窗口里） (10064ms)
    证据: {"wsBefore":1,"wsAfter":1,"fetchBefore":1,"fetchAfter":1}
✓ 全部通过：bad-token
```

24s + 10s 观察窗内 WS **只 1 次**、HTTP 探测**只 1 次**，"无限重试"的旧行为确实断了；UI 同时给出原因（HTTP 401）与"重新配对"入口。

### 6.2 已应答审批重启后不再弹 —— ✅（`--scenario=approval`，自带假主机）

```
✓ 2. 非聊天页（会话列表）也出现「待审批」横幅 (128ms)
    证据: {"banner":"有 1 项待你处理：工具调用需要批准\n去处理","waterfalls":3}
✓ 3. 点横幅「去处理」→ 聊天页出现审批卡片，displayReason 不是 [object Object] (711ms)
    证据: {"text":"…工具调用需要批准\n将要执行 rm -rf build/（假主机 e2e）\n拒绝 (Reject)\n允许一次 (Allow Once)…",
          "hasObjectObject":false}
✓ 4. 点「允许一次」→ 假主机收到词表内的 allowed-once，且已应答账本落盘 (1583ms)
    证据: {"result":{"method":"$events/result","args":{"clientId":"fake-client-1","eventId":"ev-e2e-fixed-1",
          "outcome":{"kind":"result","value":"allowed-once"}}},"ledger":"{\"v\":1,\"ids\":[\"ev-e2e-fixed-1\"]}"}
✓ 5. force-stop 真重启 → 假主机重放同一个 eventId → 不再弹 (10851ms)
    证据: {"replayed":3,"state":{"banner":0,"card":false,"onSessions":true,
          "ledger":"{\"v\":1,\"ids\":[\"ev-e2e-fixed-1\"]}"},"waterfalls":7}
```

要点：审批在会话列表页也可见（横幅）；`displayReason` 是**多语言对象**、卡片显示中文原文且**无 `[object Object]`**；应答形状逐字正确（`$events/result`、args 恰好三键、outcome 在主机词表内）；**应答成功后才落盘**；重启后重放同一 eventId **不再弹**。

### 6.3 客户端设备唯一名 —— ✅（网关侧）

```
devices total= 11  web= 9
  dev_ZdzroReGMm93 | "Web Remote Client"            | nameLen= 17
  dev_cLucNBUORrST | "Web Remote Client · ahzlei"   | nameLen= 26
  dev_OqHgE-1fzxaU | "Web Remote Client · w2ukl6"   | nameLen= 26
  dev_id38xL8uTxXm | "Web Remote Client · vbjbrz"   | nameLen= 26
  dev_ZDMnjKM7F7si | "Web Remote Client · ad0uxy"   | nameLen= 26
  dev_Z5-_d2aVw-d2 | "Web Remote Client · pydusw"   | nameLen= 26
  dev_yRoTxrSUp-ei | "Web Remote Client · l3m07v"   | nameLen= 26
  dev_LWLn4gu4Cp5B | "Web Remote Client · hnt4et"   | nameLen= 26
unique web names = 9
```

9 台 web 设备 9 个唯一名，8 台带 6 位后缀（长度 26 ≤ 网关 `slice(0,64)`）→ 网关 `platform+name` 判据下不再互相顶。
**未做**两台真机同时在线互顶的实测 → §9。

---

## 7. T4 桌面壳：真绿 + 真能红

### 7.1 基线（HEAD 024afe1）

```
node scripts/test-desktop-notify.mjs     → ✓ 56 passed, 0 failed   (exit 0)
node --run test                          → exit 0，合计 274 条断言
  44 markdown / 10 incremental / 27 approval-contract / 12 session-page /
  39 session-groups / 38 message-queue / 43 connection-policy /
   5 fetch-binding（Lead 新增）/ 56 desktop-notify
```

### 7.2 "能红"：**不改作者文件**的变异测试

把 `scripts/test-desktop-notify.mjs` 与 `electron/{desktop-state,notification-options,preload,main}.cjs`
**逐字节复制**到 `.scratch/t4-mut/`（保持相对层级，§I/§N 的源码扫描继续有效），在**副本**上打变异。
`Get-FileHash` 校验：5 个文件 `identical=True`；副本基线 `✓ 56 passed, 0 failed`。

| 变异 | 位置 | 结果 | 原文（节选） |
|---|---|---|---|
| J | `buildRelayStatusText` 去掉「待审批 N」 | **54/2 fail** | `[§J] tooltip 已连接：带主机与待审批数  expected: "…· 待审批 3" actual: "…"` |
| K | `resolveWindowState` 跳过可见性检查 | **54/2 fail** | `[§K] 屏幕被拔掉（坐标 99999）… 越界坐标不许被当成「可恢复」 expected: false actual: true` |
| D | `truncateBody` 按 UTF-16 下标切 | **55/1 fail** | `[§D] …不劈开 emoji 正文里出现了孤立代理对 —— 界面上会是乱码方块` |
| L | `normalizeDeepLink` 空 sessionId `null`→`""` | **54/2 fail** | `[§L] …空 sessionId 变 null 空串会骗过 if(sessionId) expected: null actual: ""` |
| M | `buildApprovalAction` 把 `allow` 三态压成布尔 | **55/1 fail** | `[§L] allow=null（只点了一下通知）不许被压成 false … expected: null actual: false` |

还原后复跑 `✓ 56 passed, 0 failed` → **56 条不是恒真断言**，每组失败都能直接指出"哪里错了、代价是什么"。

> 未验证：没有启动真正的 Electron GUI（无显示器/交互）；托盘、系统通知、窗口状态落盘、单实例唤回只到"纯模块 + 源码接线"这一层 → §9。

---

## 8. 发现的问题

### F1 —— 网页 RPC 全废：`fetch` 接收者丢失（P0，**已修，本轮复验通过**）

- 现象：会话列表恒空、顶部只有「降级: 主机未响应 session…」，而原生中继照常工作。
- 根因：`this.fetchImpl(...)` → getter 返回的 `fetch` 被以 `DshConnection` 实例为 `this` 调用 → `Illegal invocation`。
- 独立复现两条：`--no-netlog` 的 A/B（§1.2）+ 真机页面直接量语义。
- 影响面：`call()` / `probeAuthStatus()` / `respond()` 三条路径都在这个 getter 上；T3 单测**全注入假 fetch**，假函数不检查接收者 → 永远测不到（Lead 已补 `test-connection-fetch-binding.mjs`，5 条）。
- 复验：修复后 `--skip-send` 链路 8/8 绿；坏令牌/审批/队列三场景全绿。

### F2 —— 聊天页内容映射三连（P0，**未修**）

代码位置：`src/App.tsx` 的 `loadChatPage()`：

```js
const role = kind.startsWith('user') ? 'user' : 'assistant';
const text = data?.message?.content?.[0]?.text || (data?.result ? String(data.result) : '') || '';
```

**F2a（确定性）自己发的指令永远不显示。** 实测 5 个用户气泡文本全为 `""`：

```
"renderedUserBubbles":["","","","",""]
```

根因：`user/message` 记录的形状是 `{content:[{type:'text',text:'…'}], role:'user', id:'…'}` —— **没有 `message` 包装**，
而 App 读的是 `data.message.content[0].text` → 永远 undefined → 渲染成空气泡。
（对照：`assistant/message` / `system/message` 的形状是 `{message:{role,content:[…]}}`，所以那两个能取到。）

**F2b（随模型而变）助手正文被 reasoning 顶掉。** 真机记录：

```json
{"event":{"type":"assistant/message","data":{"message":{"role":"assistant","content":[
  {"type":"reasoning","text":"The user asks to reply exactly with a token. Just reply."},
  {"type":"text","text":"E2E-REPLY-7719"}]}}}}
```

App 取 `content[0].text` = reasoning → 助手卡显示"模型的私有推理"，真正的 `E2E-REPLY-7719` **一个字都没渲染**。
实测 6 次发送里 4 次的记录首段是 reasoning；同一脚本因此时绿时红（§3.3 的"假绿"）。

**F2c 系统提示词被当助手消息渲染。** `role` 只区分 `user` 前缀，其余全是 assistant →
`system/message`（整段系统提示词，1.2 万字）、`request/*`、`turn/*`、`step/*` 全都变成"DeepSeek 远程执行响应"气泡。
实测：一个新会话渲染出 15–16 张助手卡，其中一张正文就是完整系统提示词
`"You are an AI agent powered by DeepSeek Harness. …(+12252)"`。

**影响**：用户看到的是"自己发的话不见了、回答是一句莫名其妙的思考、还夹着大段系统提示词" —— 聊天页基本不可读。
**建议修法**：按 `content` 数组取所有 `type==='text'` 段拼起来（`reasoning` 单列或忽略）；`user/message` 走 `data.content`；
只渲染 `user/message` / `assistant/message` / `tool/*`，其余事件不进时间线。

### F3 —— 归档功能在真 app 里**不可达**（P1，**未修**）

- 证据：131 张会话卡片，`button[aria-label^="归档会话 "]` = **0**（恢复按钮也是 0）；`grep -n 'onArchive\|onUnarchive\|archivedIds' src/App.tsx` → **零命中**。
- 根因：`SessionCard` 的归档按钮条件 `canToggleArchive = archived ? !!onUnarchive : !!onArchive`；App 没传这三个 prop → 按钮不渲染 → `applyArchive()` 不可达。
- 影响：T1 的纯函数、组件、持久化、`ArchivedSection` 全都写好了，**用户永远看不到入口**（静默不可用，没有任何信号）。
- 复现：`node scripts/e2e-app-ui.mjs --scenario=archive` → 第 2 步如实失败。

### F4 —— 子代理会话**打不开**（P1，**未修**）

真主机对 8 种 address 形状的实测（只读探针）：

| 形状 | 结果 |
|---|---|
| `{kind:'subagent',sessionId,parentSessionId}` ← **App 现在写法** | ✗ `gateway/input-invalid: wire field "request" failed boundary validation` |
| `{kind:'subagent',sessionId}` / `+parent:{…}` / `+parentSession:{…}` / `+parentAddress:{…}` | ✗ 同上（`kind:'subagent'` 不在 wire schema 里） |
| `{kind:'session',sessionId:<subagent>}` | ✗ `session/agent-busy: subagent Sessions require their durable parent address`（`details.reason: use subagent delivery for this child session`） |
| `{kind:'session',sessionId:<sub>,parent|parentSessionId|parentId|parentAddress|request.parent}` | ✗ 同样 `session/agent-busy` |
| （对照）`{kind:'session',sessionId:<父会话>}` | ✓ `cursor=2468 records=28` |

- 结论：`session.page` 在当前主机上**拿不到子代理记录**；App 的 `sessionAddress()` 产出的正是被拒的形状。
- 影响：`loadChatPage()` 把异常 `catch` 成 `console.warn('Failed to fetch chat page')` → 用户展开「子代理 (N)」点进去只看到**空聊天页、没有任何错误**（又是静默失败）。
- 备注：`src/lib/session-page.ts` 注释称"子代理必须带 durable parent"；实测该形状被拒，注释与主机行为不符。

### F5 —— 切会话时旧会话消息串台（P2，**未修**）

```
"immediateOnOpen":{"assistantCards":251,"specularCards":374,"timelineChildren":378},
"settled":{"assistantCards":3,"specularCards":3},
"staleCardsOnOpen":374
```

刚进新建的会话时时间线里还是**上一个会话**的 374 个节点，2–3s 后才落定。
根因：`handleOpenSession()` 只 `setCurrentSession + setRoute('chat')`，`chatLines` 要等 `loadChatPage()` 回来才换；
期间**标题已是新会话、内容还是旧会话**。
建议：`handleOpenSession` 里先 `setChatLines([])`（或给 lines 打 sessionId 标记、渲染时过滤）。

### 非问题（我怀疑过、实测是正确行为）

- 不可达 baseUrl 按 1s/2s/4s 退避重试（queue 场景第 6 步：7.5s 内 4 次 WS + 4 次 fetch）——网络故障的正确策略；
  **只有 401/403 才立即停**（bad-token 场景：34s 内 1 次）。
- 「暂无匹配的遥控会话」空态在"还没连上"时也会渲染 —— **我的脚本**读早了（已修：空态必须叠加「双向流就绪」）。
- 默认地址 `127.0.0.1:4142` 探测失败的网络层 error 日志属预期噪音（1 条），已白名单。

---

## 9. 仍未验证 / 未覆盖（诚实清单）

| 项 | 为什么没验 |
|---|---|
| **聊天页"发送 → 看到回复"的绿** | F2a 是确定性的（用户气泡恒空），所以完整 chain **必然**停在第 9 步；修掉内容映射后应转绿（`--skip-send` 已 8/8） |
| **归档隐藏/恢复/重启后仍隐藏** | F3：真 app 里没有归档入口 |
| **子代理会话历史** | F4：主机拒绝所有可试的 address 形状 |
| **流事件防抖刷新（`handleStreamTick`）** | 需要真实流式 `emit` 才能把"事件驱动刷新"与"兜底轮询刷新"分开；未单独断言 |
| **工具卡细节** | 结果并回调用卡、>600 字符折叠、复制按钮、错误态自动展开 —— 只验到"会渲染" |
| **Electron 真桌面壳** | T4 只做纯模块单测 + 变异变红 + 源码接线扫描；没启动 GUI，托盘/通知/窗口落盘/单实例唤回未真机验证 |
| **`reportRelayStatus` / `onReconnectRequest` 端到端** | 只在 Electron 主进程有意义（Android 下是空操作）；同上未启动桌面壳 |
| **待审批横幅"会话不在列表里"的兜底分支** | 未构造该场景（走的是"打开抽屉"分支） |
| **两台真机同时在线互顶** | 只验了网关设备表的唯一名，没有第二台设备并发连 |
| **登录（账号密码）路径** | 本轮走 6 位 PIN 配对；`PairingClient.login` 未用真凭据验证 |
| **Android BACK 键行为** | Lead 已知问题，未纳入本轮 |
| **弱网/离线入队（T8）** | 功能未实现 |
| **`--scenario=all` 一次串跑 6 个场景** | 各场景已分别跑通；串跑约 3 分钟，未做 |

---

## 10. 复现清单

```bash
# 0) 前置
adb -s emulator-5554 reverse tcp:19387 tcp:19387
adb -s emulator-5554 reverse tcp:19400 tcp:19400     # 假主机类场景
$NODE=<...>/node/bin/node.exe

# 1) 全部单测（274 条断言）
$NODE --run test

# 2) 交付物①
$NODE scripts/e2e-app-ui.mjs --skip-send            # 8 步全绿（20s）
$NODE scripts/e2e-app-ui.mjs --json .scratch/e2e-chain.json   # 完整链路（当前会停在第 9 步，F2a）

# 3) 对抗性场景
$NODE scripts/e2e-app-ui.mjs --scenario=collapse    # ✅
$NODE scripts/e2e-app-ui.mjs --scenario=archive     # ❌ 入口检查（F3）
$NODE scripts/e2e-app-ui.mjs --scenario=queue       # ✅
$NODE scripts/e2e-app-ui.mjs --scenario=bad-token   # ✅
$NODE scripts/e2e-app-ui.mjs --scenario=approval    # ✅

# 4) T4 变异（不改作者文件）
mkdir -p .scratch/t4-mut/{electron,scripts}
cp electron/{desktop-state,notification-options,preload,main}.cjs .scratch/t4-mut/electron/
cp scripts/test-desktop-notify.mjs .scratch/t4-mut/scripts/
$NODE .scratch/t4-mut/scripts/test-desktop-notify.mjs     # 56/0 基线
```

**注意**：跑 e2e 期间**不要**并行铸配对码（网关只有一枚有效码，会顶掉 App 正在用的那枚）；
脚本收尾会把设备指回真网关（令牌先验证有效）并吊销自己临时铸造、最终没在用的令牌；`--keep-state` 仅调试用。

---

## 附：本轮改动

- 新增 `scripts/e2e-app-ui.mjs`（Lead 已把它随 `024afe1` 提交；本报告对应的版本在此基础上补了：
  ① mint 时机、② 假主机 `stop()` 不再等客户端断开、③ 重启后的等待逻辑〔空态必须叠加链路就绪〕、
  ④ 失败现场自动诊断、⑤ **宿主真值判定**聊天正文、⑥ archive 入口检查）。
- 新增本报告 `docs/verify-app-e2e.md`。
- **没有改动** `src/**`、`electron/**`、`packages/**`；所有变异都在 `.scratch/t4-mut/` 的副本上做，做完已还原。