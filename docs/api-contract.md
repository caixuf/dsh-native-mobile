# DSH Web 传输层 API 契约

> 面向原生 Android 客户端的机器可读契约参考。机器可读版本见 [`api-contract.json`](./api-contract.json)（53 个 unary 方法 + 35 个 Remote 端点 + 22 种事件帧 + 39 个错误码）。
>
> 本文中每一条结论都标注了 `文件:行号`，可逐条回查。

---

## 0. 关于版本与来源（重要）

任务描述中给出的 `dsh-client-connection@0.2.0-rc.2` **在磁盘上并不存在**。实际下载到的是 `0.0.1-rc.1`。本文所有引用均指向磁盘上真实存在的文件：

| 简称 | 实际路径 |
|---|---|
| `cc/client.js` | `.probe/sdk/_deepseek-ai_dsh-client-connection-0.0.1-rc.1/package/lib/client.js`（9945 行） |
| `cc/index.js` | `.probe/sdk/_deepseek-ai_dsh-client-connection-0.0.1-rc.1/package/lib/index.js`（585 行） |
| `cc/types/*.d.ts` | `.probe/sdk/_deepseek-ai_dsh-client-connection-0.0.1-rc.1/package/lib/types/` |
| `sc/typert.remote-client.d.ts` | `.probe/.probe/sdk/_deepseek-ai_dsh-api-session-controller-0.2.0-rc.2/package/lib/typert.remote-client.d.ts` |
| `wc/typert.remote-client.d.ts` | `.probe/.probe/sdk/_deepseek-ai_dsh-api-workspace-controller-0.2.0-rc.2/package/lib/typert.remote-client.d.ts` |

`cc/client.js` 中确实存在任务描述提到的全部 `//#region ../../host/apiproxy/src/api/*.schema.ts` 标记（rpc、session-search、sessions、approvals、workspace、events、commands、skills、agent-presets、goals、settings、credentials、llm、subagents），位置见 §3。

---

## 1. 传输层（Transport）

### 1.1 存在**两套** RPC 表面

原生客户端最容易踩的坑：**协议不是一套，而是两套并存**。

| | 表面 A：ApiProxy typed RPC | 表面 B：Generic Connection RPC |
|---|---|---|
| 方法名风格 | 点分 `session.list` | 斜杠 `session/follow` |
| 路径 | `POST /api/<method>` | `POST /api/<ns>/<method>` |
| 谁在用 | 全部浏览器/移动端 UI | TypeRT gateway 的 Remote 分发与流式端点 |
| 包络 | 完全相同 | 完全相同 |
| 来源 | `cc/client.js:6144` | `cc/client.js:9868` |

两者的**信封格式完全一致**（见 1.3），所以一个 HTTP 客户端可以同时支持两者。

### 1.2 Unary RPC 调用

```
POST /api/<method>
content-type: application/json

{
  "type": "client-request",
  "rpcId": "<客户端自铸的 UUID>",
  "method": "<必须与路径中的 <method> 完全一致>",
  "payload": { ... }
}
```

- **路径前缀是硬编码的**：`callUnary` 写死了 `'/api/'` 前缀，method 取自函数参数，**不从 body 里取**（`cc/client.js:6144`）。
- **除 `content-type` 外不需要任何请求头**（`cc/client.js:6124`）。
- 路由常量：`API_PATH = "/api"`（`cc/types/api-path.d.ts:7`）。
- **额外要求**：`body.method` 必须等于路径末段，否则服务端返回 `bad-request`，错误信息为 `method "X" does not match endpoint "Y"`（`cc/index.js:284-288`）。
- 请求体大小上限默认 32 MiB（`cc/index.js:474`）。当存在 `attachments` 服务时，上限必须 ≥ `ceil(maxMessageImageBytes * 4/3) + 1 MiB`，否则插件激活直接抛错（`cc/index.js:466-471`）。

### 1.3 精确的信封键（Envelope）

**只有四种完整形式，按 `type` 做判别联合**（`cc/client.js:5129-5138`）：

| type | 键 | 方向 | 来源 |
|---|---|---|---|
| `client-request` | `type`, `rpcId`, `method`, `payload` | C→S | `cc/client.js:5110-5115` |
| `server-response` | `type`, `rpcId`, `result` | S→C | `cc/client.js:5117-5121` |
| `server-request` | `type`, `rpcId`, `method`, `payload` | S→C | `cc/client.js:5123-5128` |
| `client-response` | `type`, `rpcId`, `result` | C→S | `cc/client.js:5133-5137` |

**响应体**（`cc/client.js:5117-5121` + `5100-5108`）：

```json
{
  "type": "server-response",
  "rpcId": "<必须回显你的 rpcId>",
  "result":
    | { "ok": true,  "value": <业务值> }
    | { "ok": false, "error": { "code": "...", "message": "...", "details": {...} } }
}
```

要点：

- `rpcId` 是**不透明回显令牌**，无长度约束，客户端自铸（`crypto.randomUUID()`，`cc/client.js:6113-6115`）。服务端校验不通过会**抛异常而非返回错误结果**：`rpcId mismatch for ${method}: sent X, got Y`（`cc/client.js:6147`）。
- **HTTP 非 2xx 同样抛异常**，不是 `RpcResult`。消息为 `transport failure for ${path}: HTTP ${status}`（`cc/client.js:6128`）。原生客户端必须把「传输故障」和「业务失败」分成两条错误路径处理。
- `error.details` **恒存在**（可能是 `{}`），且按 `code` 分支形状不同。
- 载荷槽 `payload` / `result.value` 在线上是 `unknown()` —— **两级解析**：先解信封，再按 method 做第二次解析（`cc/client.js:4837-4840`）。
- zod `object` 非 strict，多余键会被**静默剥离**。

### 1.4 `/api/respond` —— 服务端主动请求的回答通道

服务端推送的、需要回答的请求（审批、提问）**不走 WebSocket**，而是通过这个独立端点回传（`cc/client.js:6291-6295`）：

```
POST /api/respond
content-type: application/json

{ "type": "client-response", "rpcId": "<该帧的 rpcId>", "result": { "ok": true, "value": {...} } }
```

回执（`cc/client.js:5140-5143`）：

```json
{ "accepted": true }
{ "accepted": false, "reason": "not-pending" | "bad-response" }
```

**审批载荷**（`cc/client.js:5406-5410`）：

```json
{ "sessionId": "...", "approvalId": "...", "outcome": "allowed-once" | "rejected" }
```

- `rpcId` 是**服务端铸造**的，且在审批未回答期间**跨重连保持稳定**——每次 mux 重开都会以同一个 id 重放（`cc/client.js:7859-7862`）。原生客户端必须按 id 去重，不能因为重连就重复弹窗。
- `result.ok === false` 会被服务端视为 **cancelled**（`cc/client.js:9594`）。
- `approval/resolved` 帧的 outcome 枚举比请求更宽，多出 `cancelled` 和 `unavailable`（`cc/client.js:5517-5522`）。

**提问载荷形状未验证**——见 §6。

### 1.5 HTTP 状态码

| 状态 | 含义 | 来源 |
|---|---|---|
| 200 | 信封送达，业务结果在 `result.ok` 内 | — |
| 400 | body 不是 JSON | `cc/index.js:279` |
| 403 | 信任栅栏拒绝 | `cc/index.js:552`、`cc/index.js:535` |
| 404 | 方法非 POST 或路径未匹配 | `cc/index.js:273`、`cc/index.js:544` |
| 413 | body 超过上限 | `cc/index.js:40` |
| 415 | content-type 不是 application/json | `cc/index.js:274` |
| 426 | 对事件路径发了 GET | `cc/index.js:536-541` |
| 500 | handler 抛异常 | `cc/index.js:293` |

### 1.6 超时

默认 30 s（`cc/client.js:6057`）。策略由调用点决定（`cc/client.js:6121`）：

- `"default"`：`AbortSignal.timeout(30000)`，与调用方 signal 用 `AbortSignal.any` 合并。
- `"caller-signal-only"`：**无内建超时**，只有调用方能取消。适用于两个方法：`host.pickDirectory`（`cc/client.js:6236`，原生目录选择器可能长时间阻塞）与 `command.execute`（`cc/client.js:6251`）。

---

## 2. 两条只下行 WebSocket

### 2.1 基本参数

| 项 | 值 |
|---|---|
| 路径 | `/api/events.mux`、`/api/events.host`（`cc/types/api-path.d.ts:9`、`:11`） |
| 协议 | `ws:` / `wss:`，由页面 origin 的 http/https 决定（`cc/client.js:9785`） |
| **子协议** | **无。** `WebSocketServer` 以 `{ noServer: true }` 构造，未设 `handleProtocols`（`cc/index.js:371`）。客户端**不得**发送 `Sec-WebSocket-Protocol` |
| 查询串 | **无。** 不支持订阅过滤；socket 一升级，服务端立即以 `payload: {}` 开流（`cc/index.js:384-399`） |
| 方向 | **只下行。** 客户端发任何消息 → 服务端以 **code 1008, reason `"downlink only"`** 关闭（`cc/index.js:424-426`） |

### 2.2 帧格式

**一个事件 = 一个 WebSocket 文本帧**（非二进制，UTF-8 JSON）：

```json
{
  "type": "server-request",
  "rpcId": "<服务端铸造>",
  "method": "<等于 payload.type>",
  "payload": { "type": "<MuxFrame|HostFrame 判别值>", ... }
}
```

服务端组帧代码见 `cc/index.js:331-338`。客户端双层解析：`serverRequestSchema.parse(JSON.parse(data))` → `frameSchema.parse(full.payload)`；任一层失败只记日志并丢弃该帧，**流不中断**（`cc/client.js:9797-9816`）。

**`rpcId` 的语义（重要）**：

- 纯推送（`session/event`、`host/*` 等）每次**新铸一个** id，无意义。
- 可回答帧（`approval/requested`、`question/requested`）的 id **是稳定的逻辑句柄**，你必须把它原样回送到 `/api/respond`（`cc/client.js:484-487`）。
- `method` 字段就是帧的 `payload.type` 原文（`cc/index.js:336`）。

### 2.3 重连要求

**协议不实现重连，客户端必须自己实现。** 参考实现（`ConnectionController`）：

| 项 | 值 | 来源 |
|---|---|---|
| 触发 | 任一条流结束或出错即重连 | `cc/client.js:90-91`、`:121-131` |
| 退避 | `min(10000, 500 × 2^(attempt-1))`，再取 `[cap/2, cap]` 随机抖动 | `cc/client.js:8-13`、`:61-65` |
| 就绪握手 | 两条 socket **都**打开 **且** `host.describe` 成功，才算 connected；超时 3000 ms | `cc/client.js:95-102`、`:12` |
| sink 隔离 | 业务层回调抛异常只记日志，不影响连接层 | `cc/client.js:132-140` |
| 流终态 | 收到 `stream/error` 帧即 break 出循环，随后服务端关闭 socket | `cc/client.js:124`、`:443` |

**原生客户端必须做的**：重连后重建订阅状态，并处理审批/提问重放（同 id 去重），同时用 `session/subscribed` 的 `lastSeq` 检测事件缺口（`cc/client.js:5500-5504`）。

### 2.4 降级为 SSE 的情况

`AbstractApiClient` 基类把**同样的两条路径**当作 `text/event-source` 读（`\n\n` 分帧、`data: ` 行，`cc/client.js:6162-6213`），`WebApiClient` 才覆写为真正的 WebSocket upgrade（`cc/client.js:9777-9782`）。原生客户端应走 WebSocket 路径。

---

## 3. 全部 RPC 方法表（表面 A，共 53 个）

方法名到返回 schema 的映射表在 `cc/client.js:6001-6055`；调用点绑定在 `cc/client.js:6214-6290`。

### session（12）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `session.list` | `cursor?: string` | `{ items: SessionSummary[] }` | 列出会话，`cursor` 分页 | `cc/client.js:6002` / 参数 `:5202` |
| `session.search` | `query: string`（trim，1..500，不含 NUL） | `{ items: {sessionId,snippet}[≤20], hasMore }` | 全文检索，snippet 上限 240 码点 | `cc/client.js:6003` / `:5205-5213` |
| `session.create` | `workspaceId?`, `cwd?`, `sessionId?`, `agentPreset?` | `{ sessionId, agentPreset? }` | `workspaceId` 与 `cwd` **互斥** | `cc/client.js:6004` / `:5214-5224` |
| `session.history` | `sessionId`, `beforeSeq?: int≥0`, `maxMessages?: int>0` | `{ events: HistoryEntry[], hasMore, projections? }` | 倒序翻页；`projections` 基线只在末页出现 | `cc/client.js:6005` / `:5240-5244` |
| `session.models` | `sessionId` | `{ current, routable, groups, failures }` | 当前模型 + 可路由目录 + 逐 provider 失败 | `cc/client.js:6006` / `:5312-5319` |
| `session.selectModel` | `sessionId`, `provider`, `model`, `reasoningEffort?` | `{ selected: ModelSelection }` | 锁定精确 provider/model | `cc/client.js:6007` / `:5320-5327` |
| `session.rename` | `sessionId`, `title` | `{ title, seq }` | 返回归一化后的标题及其事件 seq | `cc/client.js:6008` / `:5225-5233` |
| `session.fork` | `sessionId`, `atSeq?: int≥0` | `{ sessionId }` | 从指定 seq（缺省为头部）分叉 | `cc/client.js:6009` / `:5234-5239` |
| `session.prompt` | `sessionId`, `mode: 'queue'\|'steer'`, `content: PromptContentPart[]` | `{ accepted: true, command?: { kind:'success', text? } }` | `queue` 排到运行轮之后；`steer` 注入当前轮。`command` 仅在文本触发了斜杠命令时出现 | `cc/client.js:6010` / `:5347-5359` |
| `session.attachment` | `sessionId`, `attachmentId` | `{ attachment: ImageAttachmentRef, data: base64 }` | 取持久化图片附件 | `cc/client.js:6011` / `:5371-5379` |
| `session.updateQueue` | `sessionId`, `itemId`, `action: {kind:'edit',content} \| {kind:'remove'} \| {kind:'steer'}` | `{ accepted: true }` | 编辑/删除/提升队列项 | `cc/client.js:6012` / `:5380-5393` |
| `session.cancel` | `sessionId` | `{ accepted: true }` | 取消当前轮 | `cc/client.js:6013` / `:5394-5396` |

### subagents（4）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `subagent.list` | `parentSessionId` | `{ entries: SubagentListEntry[], parentAvailable }` | 列出子 agent，含不健康诊断行 | `cc/client.js:6014` / `:5963-5968` |
| `subagent.history` | `parentSessionId`, `childSessionId`, `mode: 'one-shot'\|'continuable'`, `beforeSeq?`, `maxMessages?` | `{ events, hasMore, projections? }` | 翻子会话日志 | `cc/client.js:6015` / `:5969-5981` |
| `subagent.prompt` | `parentSessionId`, `childSessionId`, `mode: 'continuable'`, `content: ContentBlock[]` | `{ messageId: string }` | 向可续跑子 agent 发后续轮 | `cc/client.js:6016` / `:5982-5987` |
| `subagent.interrupt` | `parentSessionId`, `childSessionId`, `mode: 'continuable'` | `{ accepted: true }` | 打断运行中的子 agent | `cc/client.js:6017` / `:5988-5994` |

### host（5）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `host.describe` | — | `{ version, cwd, provider?, model?, attachedSessions }` | **兼作连接就绪握手**，两条流之外应先调它 | `cc/client.js:6018` / `:5617-5625` |
| `host.pickDirectory` | — | `{ path: string \| null }` | 打开宿主原生目录选择器，null = 用户取消。**仅回环**，无内建超时 | `cc/client.js:6019` / `:5626-5628` |
| `host.listDirectory` | `path?: string` | `{ path, home, crumbs, entries, truncated }` | 列目录 + 面包屑 | `cc/client.js:6020` / `:5635-5643` |
| `host.createDirectory` | `path`, `name`（单个非空段，禁 `/` `\` `.` `..`） | `{ path }` | 建单级目录，返回绝对路径 | `cc/client.js:6021` / `:5644-5649` |
| `host.openPath` | `path`（min 1） | `{ opened: true }` | 在宿主桌面打开路径。**仅回环** | `cc/client.js:6022` / `:5650-5652` |

### workspace（6）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `workspace.list` | — | `{ items: WorkspaceView[], archivedSessionIds }` | 列出工作区与归档集 | `cc/client.js:6023` / `:5427-5432` |
| `workspace.create` | `path` | `{ workspace, created }` | `created=false` 表示已存在 | `cc/client.js:6024` / `:5433-5438` |
| `workspace.rename` | `workspaceId`, `title`（trim 后非空） | `{ workspace }` | 改名 | `cc/client.js:6025` / `:5439-5444` |
| `workspace.delete` | `workspaceId` | `{ deleted: true }` | 删除 | `cc/client.js:6026` / `:5445-5447` |
| `workspace.insertSessionBefore` | `workspaceId`, `sessionId`, `beforeSessionId?` | `{ workspace }` | 工作区内移动/重排；省略 `beforeSessionId` 移到队首 | `cc/client.js:6027` / `:5448-5454` |
| `workspace.archiveSession` | `sessionId` | `{ archivedSessionIds }` | 归档，返回**完整**归档集 | `cc/client.js:6028` / `:5455-5457` |

### approvals / commands / skills（4）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `command.list` | `sessionId` | `{ commands: CommandDescriptor[] }` | 列斜杠命令 | `cc/client.js:6029` / `:5665-5667` |
| `command.execute` | `sessionId`, `line` | `{ matched, commandId? }` | **纯准入**：结果靠后续生命周期事件，用 `commandId` 关联。无内建超时 | `cc/client.js:6030` / `:5668-5679` |
| `skill.list` | `sessionId` | `{ skills: SkillEntry[] }` | 列会话可见技能 | `cc/client.js:6031` / `:5693-5695` |
| （审批） | 走 `/api/respond`，见 §1.4 | `{ accepted }` | 审批响应 | `cc/client.js:5406-5410` |

### agent-presets（6）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `agentPreset.list` | — | `{ presets, authorable, hasDocument }` | **非**仅回环 | `cc/client.js:6032` / `:5711-5717` |
| `agentPreset.select` | `sessionId`, `agentPreset` | `{ agentPreset }` | 绑定 preset。**非**仅回环 | `cc/client.js:6033` / `:5718-5723` |
| `agentPreset.read` | `agentPreset` | `{ agentPreset, trust, content, name?, description? }` | **仅回环** —— composition 揭示会话运行的插件，读取即侦察 | `cc/client.js:6034` / `:5724-5732` |
| `agentPreset.copy` | `from`, `agentPreset`, `name?` | `{ agentPreset }` | **仅回环**。唯一创作写入 | `cc/client.js:6035` / `:5733-5739` |
| `agentPreset.openDocument` | `agentPreset` | `{ opened: true } \| { opened: false, path }` | **仅回环** | `cc/client.js:6036` / `:5740-5745` |
| `agentPreset.remove` | `agentPreset` | `{}` | **仅回环** | `cc/client.js:6037` / `:5746-5748` |

### goals（6）

全部为**纯变更**，返回值只是 `{ ref: { id, revision } }` 确认；**当前 goal 状态只走 session projection 的 `goal` 键**（`cc/client.js:5751-5755`）。

| 方法 | 参数 | 返回 | 来源 |
|---|---|---|---|
| `goal.create` | `sessionId`, `objective`, `maxGoalRounds?: int>0` | `{ ref }` | `cc/client.js:6038` / `:5763-5769` |
| `goal.edit` | `sessionId`, `ref`, `objective?`, `maxGoalRounds?`（二者至少一个） | `{ ref }` | `cc/client.js:6039` / `:5770-5777` |
| `goal.pause` | `sessionId`, `ref` | `{ ref }` | `cc/client.js:6040` / `:5778-5783` |
| `goal.resume` | `sessionId`, `ref` | `{ ref }` | `cc/client.js:6041` / `:5784-5789` |
| `goal.complete` | `sessionId`, `ref` | `{ ref }` | `cc/client.js:6042` / `:5790-5795` |
| `goal.clear` | `sessionId`, `ref` | `{ cleared: true }` | `cc/client.js:6043` / `:5796-5801` |

### settings（5，全部仅回环）

| 方法 | 参数 | 返回 | 来源 |
|---|---|---|---|
| `settings.describe` | — | `{ writable, hasDocument, namespaces }`（secrets 已脱敏） | `cc/client.js:6044` / `:5824-5830` |
| `settings.openDocument` | — | `{ opened: true }` | `cc/client.js:6045` / `:5831-5833` |
| `settings.update` | `ns`, `patch: Record<string,unknown>`, `expectedRevision?` | `SettingsNamespaceView` | `cc/client.js:6046` / `:5834-5840` |
| `settings.replace` | `ns`, `section: Record<string,unknown>`, `expectedRevision?` | `SettingsNamespaceView` | `cc/client.js:6047` / `:5841-5863` |
| `settings.mutate` | `ns`, `ops: ({op:'set',path:string[],value} \| {op:'unset',path:string[]})[]`, `expectedRevision?` | `SettingsNamespaceView` | `cc/client.js:6048` / `:5847-5861` |

`expectedRevision` 是乐观并发控制，不匹配返回 `settings-conflict { ns, expected, actual }`（`cc/client.js:5017-5024`）。

### credentials（3，全部仅回环）

| 方法 | 参数 | 返回 | 来源 |
|---|---|---|---|
| `credentials.describe` | `refs: string[]`（≤64，POSIX 环境变量名） | `{ credentials: Record<string, CredentialView> }` | `cc/client.js:6049` / `:5880-5882` |
| `credentials.set` | `ref`, `value`（min 1） | `{}` | `cc/client.js:6050` / `:5883-5888` |
| `credentials.unset` | `ref` | `{}` | `cc/client.js:6051` / `:5889-5891` |

### llm（3）

| 方法 | 参数 | 返回 | 说明 | 来源 |
|---|---|---|---|---|
| `llm.providers` | — | `{ providers }` | **非**仅回环：不含端点与密钥状态 | `cc/client.js:6052` / `:5907-5909` |
| `llm.models` | — | `{ groups, failures }` | 全局模型目录 | `cc/client.js:6053` / `:5910-5915` |
| `llm.discoverModels` | `settingsNs`, `provider?`, `baseURL?`, `api?`, `apiKey?` | `{ models }` | **仅回环**。让**宿主**去 GET 调用方指定的 URL 并回报 —— 对宿主可达而浏览器不可达的目标构成 SSRF 探针（`cc/index.js:491-495`） | `cc/client.js:6054` / `:5923-5931` |

---

## 4. 表面 B：Generic Connection RPC / TypeRT Remote（35 个已验证）

传输帧格式与表面 A 完全相同，只是 endpoint 用斜杠（`cc/client.js:9858-9878`）。endpoint 段须匹配 `^[A-Za-z0-9_$.-]+$`，拒绝空段、`.`、`..`（`cc/client.js:9884-9887`）。

### session-controller（21）

`fileReferences/list`、`session/attachment`、`session/cancel`、`session/canOpenWorkspacePath`、**`session/control`（流）**、`session/create`、**`session/follow`（流）**、`session/fork`、`session/initializeDefaultModel`、`session/list`、`session/modelCatalog`、`session/openWorkspacePath`、`session/page`、`session/projections`、`session/prompt`、`session/rename`、`session/search`、`session/selectModel`、`session/updateQueue`、`session/workspacePathApplications`、`skills/list`

来源：`sc/typert.remote-client.d.ts:40-60`。

### workspace-controller（14）

`directoryPicker/createDirectory`、`directoryPicker/list`、`directoryPicker/pick`、`workspace/archiveSession`、`workspace/create`、`workspace/delete`、**`workspace/follow`（流）**、`workspace/initializeDefault`、`workspace/insertBefore`、`workspace/insertSessionBefore`、`workspace/pinSession`、`workspace/rename`、`workspace/unarchiveSession`、`workspace/unpinSession`

来源：`wc/typert.remote-client.d.ts:30-43`。

⚠️ 三个流式端点（`session/control`、`session/follow`、`workspace/follow`）的**帧结构与分帧方式未验证** —— 定义在未下载的 apiproxy/gateway 包里。

⚠️ 另有 `goals/create`、`goals/edit`、`goals/pause`、`goals/resume`、`goals/complete`、`goals/clear` 六个端点，**仅出现在客户端 fixture 中**（`cc/client.js:9604-9612`），服务端无注册记录，标记为 low confidence。

---

## 5. 事件帧 schema

两条流各自是一个 `discriminatedUnion('type')`。

### 5.1 MuxFrame（9 种，`cc/client.js:5493-5559`）

| type | payload | 来源 |
|---|---|---|
| `session/event` | `sessionId`, `event: SessionEvent`, `view?: ToolEventView` | `cc/client.js:5494-5499` |
| `session/subscribed` | `sessionId`, `lastSeq: int` | `cc/client.js:5500-5504` |
| `approval/requested` | `sessionId`, `approvalId`, `toolName`, `callId?`, `reason?` — **可回答** | `cc/client.js:5505-5512` |
| `approval/resolved` | `sessionId`, `approvalId`, `outcome: 'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'` | `cc/client.js:5513-5523` |
| `question/requested` | `sessionId`, `questions: AskUserQuestionItem[]`（≥1）— **可回答** | `cc/client.js:5524-5528` |
| `question/resolved` | `sessionId`, `questionRpcId`, `outcome: 'answered'\|'cancelled'` | `cc/client.js:5529-5534` |
| `session/queue` | `sessionId`, `items: {id, placement:'queued'\|'steering'\|'context', message}[]` — **全量状态，非增量** | `cc/client.js:5535-5547` |
| `session/projection` | `sessionId`, `key`（min 1）, `value: unknown`, `seq: int≥0` | `cc/client.js:5548-5554` |
| `stream/error` | `error: RpcError` — **终态**，收到后连接关闭 | `cc/client.js:5555-5558` |

### 5.2 HostFrame（13 种，`cc/client.js:5561-5616`）

| type | payload | 来源 |
|---|---|---|
| `host/session-added` | `sessionId`, `blank`, `parentSessionId?`, `origin?: 'subagent'`, `cwd?`, `agentPreset?` | `cc/client.js:5562-5570` |
| `host/session-removed` | `sessionId` | `cc/client.js:5571-5574` |
| `host/session-status` | `sessionId`, `running` | `cc/client.js:5575-5579` |
| `host/agent-error` | `sessionId`, `message` | `cc/client.js:5580-5584` |
| `host/workspace-changed` | `workspace: WorkspaceView` | `cc/client.js:5585-5588` |
| `host/workspace-removed` | `workspaceId` | `cc/client.js:5589-5592` |
| `host/archived-sessions-changed` | `archivedSessionIds: string[]` | `cc/client.js:5593-5596` |
| `host/commands-changed` | （无）→ 重新拉 `command.list` | `cc/client.js:5597` |
| `host/session-preset-changed` | `sessionId`, `agentPreset` | `cc/client.js:5598-5602` |
| `host/settings-changed` | `ns` → 重新拉 `settings.describe` | `cc/client.js:5603-5606` |
| `host/credentials-changed` | `ref` | `cc/client.js:5607-5610` |
| `host/models-changed` | （无） | `cc/client.js:5611` |
| `stream/error` | `error: RpcError` | `cc/client.js:5612-5615` |

### 5.3 关键共享类型

| 类型 | 形状 | 来源 |
|---|---|---|
| `SessionEvent` | `{ type: string, seq: int≥0, time: number, data: unknown, sourceEventSeqs?: number[], surfaceOp?: unknown }` —— **信封严格、`data` 完全开放**；未知事件类型必须走文档化的默认分支 | `cc/client.js:5182-5189` |
| `SessionSummary` | `{ sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, agentPreset?, projections? }` | `cc/client.js:5191-5201` |
| `ToolEventView` | `{ for:'call'\|'result', view: { card, ...宽松 } }` —— 只锁判别符与 card 标签，内部是宿主计算产物 | `cc/client.js:5285-5291` |
| `WorkspaceView` | `{ workspaceId, path, title, sessionIds, createdAt: string, updatedAt: string }` —— ⚠️ **时间戳是 ISO 字符串**，与线上其他所有数字时间戳不同 | `cc/client.js:5419-5426` |
| `PromptContentPart` | `{type:'text',text}` \| `{type:'image', mediaType:'image/png'\|'image/jpeg'\|'image/webp'\|'image/gif', data:base64, name?}` | `cc/client.js:5338-5346` |
| `GoalRef` | `{ id: string, revision: int>0 }` | `cc/client.js:5757-5760` |

完整 23 个共享类型见 `api-contract.json` 的 `sharedValueTypes`。

### 5.4 错误码（39 个）

全部为 `code` 判别的联合，每个分支的 `details` 形状不同且**恒存在**（`cc/client.js:4850-5094`）。完整表见 JSON 的 `transport.errorCodes`。常用的几个：

`bad-request`、`cancelled`、`session-not-found`、`session-conflict {sessionId, requestedCwd, existingCwd?}`、`agent-busy`、`settings-conflict {ns, expected, actual}`、`credential-rejected`、`llm.discoverModels` 相关的 `model-discovery-failed {settingsNs, baseURL?}`、`subagent-*` 系列 6 个、`internal`（兜底）。

---

## 6. 认证与信任

### 6.1 明确结论：**完全没有认证层**

> 「The fence is a reachability policy, not authentication; the Web carrier provides no authentication layer.」
> —— `cc/README.md:9`

整个 `/api` 表面**不读取也不要求**任何 token、cookie、`Authorization` 头、API key 或会话凭据。原生客户端不需要、也无法携带任何凭据。

### 6.2 `/api` 栅栏实际检查什么

函数 `isTrustedApiRequest(request, trustedHosts)`（`cc/index.js:179-193`，签名见 `cc/types/api-request-trust.d.ts:41`），**对每个请求都执行**，按顺序：

| # | 检查 | 来源 |
|---|---|---|
| 1 | `Host` 头必须存在且能被 WHATWG 解析 | `cc/index.js:180-183` |
| 2 | `Host` 的 hostname 必须是**回环**（`localhost`、`[::1]`、或 `127.0.0.0/8`）**或**匹配某个 `trustedHosts` 条目 | `cc/index.js:184`；回环判定实现 `cc/index.js:95-99` |
| 3 | `sec-fetch-site` 若存在，**不得**为 `cross-site` | `cc/index.js:185` |
| 4 | `Origin` 若存在，**必须**与 `Host` authority 完全相等；`Origin` 缺失则通过 | `cc/index.js:186-192` |

`trustedHosts` 匹配规则（`cc/index.js:166-172`）：带端口的条目精确匹配 `host:port`，不带端口的条目按 hostname 匹配**任意端口**；两侧都经 WHATWG 归一化后比较。

**刻意不为例外开绿灯**：明文 HTTP 下浏览器的图片/导航读取既不带 `Origin` 也不带 Fetch-Metadata，无标记请求仍可能是被 DNS 重绑的页面发起的读取，而 `Host` 是重绑唯一伪造不了的请求头（`cc/README.md:9`）。

**拒绝行为**：HTTP 直接 403 `forbidden`，发生在任何 RPC 分发之前（`cc/index.js:551-555`）；WebSocket 在任何事件流启动前拒绝握手（`cc/index.js:567-570`）。

`trustedHosts` 配置项会校验：非规范裸 authority 会让插件**加载即报错**，而不是被静默忽略（`cc/index.js:143-147`）。

### 6.3 特权方法（即使配置了 `trustedHosts` 也仅限回环）

这 15 个方法以**空信任表**过栅栏（`cc/index.js:501-517`）：

`agentPreset.read`、`agentPreset.copy`、`agentPreset.openDocument`、`agentPreset.remove`、`host.pickDirectory`、`host.openPath`、`settings.describe`、`settings.openDocument`、`settings.update`、`settings.replace`、`settings.mutate`、`credentials.describe`、`credentials.set`、`credentials.unset`、`llm.discoverModels`

**刻意排除在外的 4 个**：`llm.providers`、`llm.models`、`agentPreset.list`、`agentPreset.select` —— 它们不携带端点/密钥状态，LAN 客户端的模型选择器需要它们（`cc/index.js:497-499`）。

### 6.4 对原生客户端的影响

- **能连上 socket，就等于拥有整个 API。**
- 默认只绑回环，所以这是**唯一有效的控制手段**。
- 一旦以 `--host 0.0.0.0` 部署并配置 `trustedHosts`，**一个未认证的 LAN 调用方就能拿到 53 个方法里的 38 个**。
- 原生客户端必须设置 `Host` 头（HTTP/1.1 下由 OkHttp 自动设置），**不要**设置 `Origin`，更不要设 `sec-fetch-site: cross-site`。

---

## 7. Gaps / 未验证项

以下内容**在下载到的六个包中找不到依据**，不做猜测：

| 项 | 状态 | 依据 |
|---|---|---|
| **job / terminal / account 域** | **不存在** | 六个包中不存在任何匹配 `"job.*"` / `"terminal.*"` / `"account.*"` 的字符串字面量。这三个域在本契约中**根本不存在** |
| `QuestionResponsePayload` 的 schema | 未验证 | 仅作为类型导出（`cc/types/client/api.d.ts:1`），zod 定义不在任何 schema region 中。可参考 `AskUserQuestionItemSchema`（`cc/client.js:5466-5480`）推断，但有风险 |
| `/api/respond` 服务端路由与 pending 表 | 未验证 | `cc/index.js:545` 把所有未匹配的 `/api` 请求转交 `apiProxy` 服务；pending 表实现在**未下载**的 `@deepseek-ai/dsh-host-apiproxy` 中。仅有客户端契约（`cc/client.js:6291-6295`）与一份 fixture 模拟（`cc/client.js:9561-9597`） |
| `goals/*` 通用 RPC 端点 | 未验证 | 仅出现在客户端 fixture（`cc/client.js:9604-9612`），无服务端注册；`{ args: {...} }` 载荷外壳是 fixture 专有的 |
| 三个流式端点的帧结构 | 未验证 | `session/control`、`session/follow`、`workspace/follow` 是 `RemoteStreamHandle`，帧联合定义在未下载的 apiproxy/gateway 包 |
| `SessionEvent.data` 的逐事件结构 | **刻意开放** | `cc/client.js:5186` 声明为 `unknown()`；核心是 merge-extensible 的。按事件的具体结构在 `dsh-session/types` 与 `dsh-client-ui-chat` 中，后者只暴露视图类型 |
| `settings` 的 schema/value JSON 形状 | **刻意开放** | `cc/client.js:5816-5817` 声明为 `unknown()`；namespace schema 由宿主运行时提供 |

---

## 8. 原生客户端落地清单（要点汇总）

1. `POST /api/<method>` + `content-type: application/json`，body `{type:"client-request", rpcId, method, payload}`；`method` 必须与路径一致。
2. 先开两条 WebSocket，等两条都 open **且** `host.describe` 成功，才算连接就绪。
3. WebSocket **不带子协议、不带查询串**；收到任何客户端消息会被 1008 关闭 —— 保持只读。
4. 区分两类错误：HTTP 非 2xx / rpcId 不匹配 = **抛异常**；`result.ok === false` = **业务错误**。
5. 实现指数退避重连（500 ms × 2ⁿ，上限 10 s，50%–100% 抖动），并对审批/提问按**稳定 rpcId** 去重。
6. `host.pickDirectory` 与 `command.execute` 需要自备超时，不要套用默认 30 s。
7. `WorkspaceView` 的 `createdAt`/`updatedAt` 是 ISO 字符串，不是数字。
8. `SessionEvent` 只严格校验 `type/seq/time`，`data` 必须有未知类型兜底分支。
9. 不需要携带任何认证凭据 —— 也正因如此，部署侧的绑定策略是唯一防线。