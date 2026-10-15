# 03 · 桌面版文件传输 / 附件链路拆解（供移动端复刻）

> 源码（**只读**）：`C:\Users\20247\Downloads\oss-study\deepseek-harness`
> **路径约定**（下文所有引用都用短前缀）：
> `attachment/…` = `packages/attachment/attachment/…`；`attachment-local/…` = `packages/attachment/attachment-local/…`；
> `file-upload/…` = `packages/client/file-upload/…`；`ui-attachment/…` = `packages/client/ui-attachment/…`；
> `ui-conversation/…` = `packages/client/ui-conversation/…`；`ui-chat/…` = `packages/client/ui-chat/…`；
> `session-controller/…` = `packages/api/session-controller/…`；`llm/…` = `packages/llm/llm/…`；
> `connection/…` = `packages/client/connection/…`；`workspace-files/…` = `packages/api/workspace-files/…`；
> `desktop-app/…` = `apps/desktop/…`。本仓库（移动端）路径写成 `本仓库 …`。
> 行号均为本次实际打开文件确认的行；**没读到出处的判断标注"未找到"或"未验证"**，不做推测性补齐。
> 事件类型 / 字段名一律逐字抄自源码或测试夹具；**JSON 示例是按类型定义拼装的（未在运行中抓包）**，已在 §3.2 标明。

---

## 0. 一分钟结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | 附件分**两条完全不同的链路**：**图片**读进消息（base64 走 prompt RPC），**普通文件**先上传到 host 拿收据，消息里只放 `receiptId` | `attachment/src/types.ts:100-118`、`session-controller/src/types.ts:90-98`、`file-upload/src/client/runtime.ts:191-221` |
| 2 | 上传通道是 **HTTP 原始字节路由**：`POST /api/session/uploadFileBinary`，body=文件原始字节，**不是** multipart、**不是** base64 | `file-upload/src/protocol.ts:2`、`file-upload/src/http-route.ts:22-45` |
| 3 | 普通文件在**选中瞬间**就开始上传（不是发送时），由后台 Web Worker/XHR 发，带 `onProgress{loaded,total}` | `ui-conversation/src/client/service.ts:302-319,345-383`、`file-upload/src/client/runtime.ts:84-105` |
| 4 | 附件最终落在 **`user/message`** 事件里，是 `content[]` 的一个 block（`image` / `file`），**没有**专门的 attachment 事件 | `session-controller/src/commands.ts:341,592`、`llm/src/types.ts:79-102` |
| 5 | 图片**有**大小/数量上限（单图 20 MiB、单条消息 20 张 / 200 MiB、64M 像素、单边 8192px）；普通文件**没有**类型和大小上限 | `attachment-local/src/index.ts:34-42`、`attachment/README.md:40` |
| 6 | 普通文件对模型**永远不是字节**：请求装配时被替换成**一行 handle 文本**（名字+字节数+digest 前 8 位+只读路径） | `llm/src/content.ts:151-158,185-208` |
| 7 | 已发送附件**不可撤回**（不删除、不可编辑）；只有**还在队列里**的消息能整条 `remove` | `attachment/attachment/README.md:119`、`session-controller/src/types.ts:168-175`、`ui-conversation/src/client/queue/QueueDock.tsx:291` |
| 8 | 桌面端还有一条**不是附件**的路：拖入/选择**文件夹**（或带真实路径的文件）会变成 `@路径` **文本引用**，字节根本不上传；**仅桌面端**（靠 Electron 的路径桥） | `ui-conversation/src/client/apply.ts:104-112,496-514`、`desktop-app/src/preload-app.ts:79-84` |
| 9 | 移动端最省事的做法是走第 8 条的思路（引用**电脑上的**路径），而不是把手机文件搬过去；但 host 目前**没有**"把已有路径登记成附件"的端点 | `attachment/src/index.ts`（`saveFile`/`admitEncodedFile` 只有"提交字节"两个入口，见 §5.4） |

---

## 1. 用户能传什么，各走哪条链路

### 1.1 四条入口 + 一种特殊情况

| 入口 | 触发代码 | 结果 |
|---|---|---|
| **文件选择** | 命令 `file`（回形针图标）→ `pickFiles()` → 隐藏 `<input type="file" multiple>` | 参见 §4.1 |
| **拖拽** | document 级 `dragenter/dragover/dragleave/drop` | 见 §4.2 |
| **粘贴** | 编辑器 keymap 读 `clipboardData.items` | `ui-conversation/src/client/input/editor/keymap.ts:161-176` |
| **文件夹**（桌面专属） | 拖拽/选择时带 `webkitGetAsEntry().isDirectory` | 变成 `@路径` 文本引用，见 §1.3 |
| **纯文本** | 直接打字/粘贴文本 | 只是 `{type:'text'}`，**不算附件**（长文本也一样） | `session-controller/src/types.ts:90-91` |

### 1.2 图片 vs 普通文件：分流点是浏览器声明的 MIME

| 类别 | 判定 | 链路 | 证据 |
|---|---|---|---|
| 图片 `image/png` \| `image/jpeg` \| `image/webp` \| `image/gif` | `isImageMediaType(file.type)` | 草稿里用 `URL.createObjectURL` 预览；**发送时**读成 canonical base64 放进 prompt | `ui-conversation/src/client/service.ts:302-309,569-575`、`attachment/src/types.ts:7-8` |
| 其它任何文件 | 上面判定为 false | **选中即上传**原始字节 → 拿 `receiptId`；发送时只带 `receiptId` | `ui-conversation/src/client/service.ts:310-318,259-263` |
| 图片但 MIME 不在白名单（如 `image/bmp`） | `imageMediaType()` 抛 `UnsupportedImageMediaTypeError` | 校验期被拒（toast），不进 rail | `ui-conversation/src/client/service.ts:578-588`、`ui-conversation/src/client/apply.ts:522-524` |

⚠️ 注意：**MIME 是浏览器声明的**，不是嗅探出来的；真正的类型校验在 host 侧（`IMAGE_TYPE_MISMATCH` / `INVALID_IMAGE`，见 §2.5）。

### 1.3 文件夹 = `@路径` 文本引用（**不是附件**，且仅桌面端）

| 步骤 | 代码 | 说明 |
|---|---|---|
| 判定成员是否目录 | `drop-events.ts:9-20`（`webkitGetAsEntry().isDirectory`，浏览器没有该 API 就报"没有目录"） | 目录和空文件在 `File` 上无法区分 |
| 取真实路径 | `apply.ts:110-112` 读 `globalThis.__DSH_HOST_PATHS__`；Electron preload 用 `webUtils.getPathForFile(file)` 实现 | `desktop-app/src/preload-app.ts:79-84` |
| 非桌面端 | `bridge === undefined && directory` → 拒绝，文案"只有桌面端支持添加文件夹" | `apply.ts:497-498`、`ui-conversation/src/client/locales.ts:38` |
| 造引用文本 | `relativizeToCwd(path,cwd)` + `formatFileMention({path,kind:'file'})` → `@path` 或 `@"a b.md"`；目录保留结尾 `/` 并在草案里显示为 folder chip | `apply.ts:505-513`、`util/workspace-path/src/index.ts:107`、`context/file-reference/src/grammar.ts:45-55` |
| **带路径的普通文件** | `path !== ''` 且非图片 → 也走 `@path`（不上传）；只有 `path === ''`（例如粘贴的字节）或图片才进上传队列 | `apply.ts:499-504` |

对移动端的含义：**桌面版自己就有"不传字节、只引用电脑上路径"的成熟模式**，只是它依赖 Electron 提供路径。这条是 §5 推荐方案的依据。

---

## 2. 传输协议本质：上传到 host 再引用（图片除外）

### 2.1 三条通道

| 通道 | 方向 | 载体 | 何时用 | 证据 |
|---|---|---|---|---|
| A. **HTTP 原始字节路由** | 手机/浏览器 → host | `POST` + `application/octet-stream` body | 普通文件的 `Blob` / `ReadableStream`（浏览器首选） | `file-upload/src/http-route.ts:22-45`、`file-upload/src/client/runtime.ts:198-212` |
| B. **Remote `fileUploads/upload`** | 客户端 → host | JSON + **canonical base64** 字符串 | 只有"已经是精确字节"（`Uint8Array`）时；或没有 Worker 的载体 | `file-upload/src/client/runtime.ts:213-220`、`file-upload/src/index.ts:104-111` |
| C. **prompt RPC 内联 base64** | 客户端 → host | `session/prompt` 的 `content[]` | **图片**（发送时编码） | `session-controller/src/types.ts:90-98`、`ui-conversation/src/client/service.ts:259-263` |

**没有 multipart/form-data**：原始路由显式拒绝其它 content-type（`415`，`http-route.ts:26-29`）。

### 2.2 通道 A：HTTP 路由逐字形状

| 项 | 值 | 证据 |
|---|---|---|
| method | `POST`（其它方法 `405` + `allow: POST`） | `http-route.ts:22-25` |
| path | `/api/session/uploadFileBinary`（浏览器内是文档相对形式，去掉前导 `/`） | `file-upload/src/protocol.ts:2-7` |
| query | `sessionId`（必填，空 → `400`）、`name`（可选，文件名） | `http-route.ts:30-35` |
| header | `content-type: application/octet-stream`（必填，否则 `415`） | `http-route.ts:26-29` |
| body | **文件原始字节流**（host 逐块读，不聚合；路由注册为 `requestBody:'streaming'`） | `http-route.ts:40-44,69-81`、`file-upload/src/index.ts:72-79` |
| 响应 | 恒 `200` + JSON：`{ok:true,value:{receiptId,file:{attachmentId,name,bytes}}}` 或 `{ok:false,error:{code,message,details}}` | `http-route.ts:9-14,60-66` |
| 返回结构校验 | 客户端逐字段校验 `receiptId` / `file.attachmentId` / `file.name` / `file.bytes` | `file-upload/src/client/runtime.ts:300-334` |

`receiptId` 与 `file` 的类型：`FileUploadValue{receiptId, file:FileAttachmentRef}`（`file-upload/src/types.ts:14-22`）。

### 2.3 通道 C：提交 RPC（把三类 part 合成一条消息）

wire 方法名 = `session/prompt`：wire 形式是 `命名空间/方法名`（同类实例：`session/openWorkspacePath`，`connection/tests/node-half.host.spec.ts:369`），host 侧注册为 `@Remote('prompt')`（`session-controller/src/index.ts:461-462`）。

| 项 | 形状 | 证据 |
|---|---|---|
| args | `{requestId, sessionId, mode:'queue'\|'steer', content: PromptContentPart[], clientTimeZone?}` | `session-controller/src/types.ts:343-352`、`ui-conversation/src/client/sessions/session.ts:271-277` |
| 空内容 | host 拒绝：必须含非空白 text **或**附件，否则 `gateway/bad-request` | `session-controller/src/index.ts:464-466` |
| `content[]` 客户端形状 | `{type:'text',text}` \| `{type:'image',mediaType,data(base64),name?}` \| `{type:'file',receiptId}` | `session-controller/src/types.ts:90-98` |
| 响应 | `{accepted:true}`；失败是 RemoteError（`session/attachment-invalid` 等） | `session-controller/src/types.ts:354-357`、`commands.ts:353-359` |
| host 侧处理顺序 | ① 图片先校验模型是否支持视觉（否则 `MODEL_DOES_NOT_SUPPORT_IMAGES`）② `fileUploads.resolve(agent,receiptId)` 换出 `FileAttachmentRef` ③ `attachments.admitPromptContent()` 把 base64 图片落盘成 ref ④ `createUserMessage({content,source})` ⑤ `bindPrompt()` + `followup/steer` | `session-controller/src/commands.ts:320-362` |
| 文件收据不匹配 | `resolvePromptFileReceipts()` 抛 `session/attachment-invalid`，`details.reason='FILE_NOT_STAGED'` | `session-controller/src/commands.ts:563-582` |
| 收据的会话归属 | 收据表按 **Agent 的 Session 对象**为 key；别的会话的 receiptId 解析不到 | `file-upload/src/index.ts:59,138-140` |
| 收据生命周期 | `bindPrompt` 事务式绑定；`commit()` 后由队列/历史观察（`user/message` 带同一 `rpcId`）退休；失败回滚 | `file-upload/src/index.ts:150-168,232-236` |
| 子代理会话 | **不接受** file part（`SUBAGENT_FILE_UNSUPPORTED`），所以 composer 在混合批次里提前拒绝 | `ui-conversation/src/client/sessions/session.ts:278-286`、`ui-conversation/src/client/skeleton/InputBar.tsx:214-219` |

### 2.4 大小上限（**三档，别混**）

| 对象 | 默认值 | 常量 / 证据 |
|---|---|---|
| 单张图片（源字节） | **20 MiB** | `attachment-local/src/index.ts:34` |
| 单条消息图片张数 | **20** | `attachment-local/src/index.ts:36` |
| 单条消息图片源数据总和 | **200 MiB** | `attachment-local/src/index.ts:38` |
| 单图像素 | **64,000,000** | `attachment-local/src/index.ts:40` |
| 单图单边 | **8192 px** | `attachment-local/src/index.ts:42` |
| 规范化后单图像素预算 | **2048×2048 = 4,194,304** | `attachment-local/src/index.ts:50` |
| 规范化后单边 | **8192 px**（⚠️ 与 README 的"长边 2048"不一致，见 §6） | `attachment-local/src/index.ts:52` |
| 规范化后单图字节 | **4 MiB** | `attachment-local/src/index.ts:54` |
| **普通文件** | **无类型限制、无大小限制**（逐字节原样保存） | `attachment/README.md:40,118`、`attachment/src/index.ts`（`saveFile`/`saveFileStream` 不施加 admission 限制，见 `docs/subsystems/attachment.md:169-170`） |
| **HTTP/RPC 请求体上限** | **300 MiB**（buffered 路由统一上限，按 200 MiB 图片 ×4/3 + 1 MiB envelope 反推校验） | `connection/src/http-bridge.ts:11-15,59-75`、`connection/src/index.ts:75-89` |
| 上传路由是否受限 | 否：该路由注册为 `requestBody:'streaming'`，不走 buffered 上限 | `file-upload/src/index.ts:72-79`、`connection/src/http-bridge.ts:59-61` |

### 2.5 稳定失败码（客户端该能逐码给文案）

| 码 | 含义 | 证据 |
|---|---|---|
| `TOO_MANY_IMAGES` / `IMAGES_TOO_LARGE` | 批级：张数 / 总字节 | `attachment/src/error.ts:3-13` |
| `UNSUPPORTED_IMAGE_TYPE` / `INVALID_IMAGE_BASE64` / `INVALID_IMAGE` / `IMAGE_TYPE_MISMATCH` | 类型、编码、解码、声明与内容不符 | 同上 |
| `IMAGE_TOO_LARGE` / `IMAGE_TOO_MANY_PIXELS` / `IMAGE_DIMENSION_TOO_LARGE` | 单图三项上限 | 同上 |
| `INVALID_FILE_BASE64` / `INVALID_ATTACHMENT_REF` | 文件编码 / ref 非法 | `attachment/src/error.ts:18-28` |
| `ATTACHMENT_CORRUPT` / `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_READ_FAILED` | 读回校验失败（digest/缺失/IO） | 同上 |
| `ATTACHMENT_FILES_UNSUPPORTED` | 后端不支持逐字节文件 | 同上 |
| `session/attachment-invalid` + `details.reason` | RPC 层映射（`FILE_NOT_STAGED` / `ATTACHMENT_NOT_REFERENCED` / 图片码） | `commands.ts:355-357,571-577,392-398` |

---

## 3. 附件最终以什么形态进入对话

### 3.1 事件类型：`user/message`（没有专门的 attachment 事件）

| 事实 | 证据 |
|---|---|
| host 在 prompt admission 通过后 `createUserMessage({content, source})`，再 `followup/steer`，最终落成 **`user/message`** 事件 | `commands.ts:341,350-351` |
| 收据退休靠观察 `user/message`（且 `event.data.source.kind === 'user'` 且带 `rpcId`） | `file-upload/src/index.ts:232-236`、`commands.ts:591-595` |
| 有测试夹具证明附件就长在这个事件的 `data.content[]` 里 | `session-controller/tests/commands-queue-attachment.host.spec.ts:400-404,440-443` |

### 3.2 真实结构（字段名逐字来自类型定义；**值是我按定义拼的示例**）

来源：`llm/src/message.ts:139-148,162-164`（`MessageBase`/`UserMessage`）、`llm/src/types.ts:79-102`（`ImageBlock`/`FileBlock`）、`attachment/src/types.ts:11-46`（两个 ref）、`commands-queue-attachment.host.spec.ts:440-443`（事件信封 `type/seq/time/surfaceOp/data`）。

```jsonc
{
  "type": "user/message",
  "seq": 12,
  "time": 1760000000000,
  "surfaceOp": "append",
  "data": {
    "id": "<uuid>",
    "role": "user",
    "source": { "kind": "user", "rpcId": "<client 生成的 requestId>" },
    "content": [
      { "type": "image",
        "attachment": {
          "attachmentId": "sha256:<64 hex>",   // 后端当前形态，消费方不得解析
          "mediaType": "image/png",
          "bytes": 184320,
          "width": 1024, "height": 768,
          "name": "whiteboard.png"
          // "originalDimensions": {"width":1536,"height":1152}   // 仅当规范化缩小时出现
        }
      },
      { "type": "file",
        "attachment": {
          "attachmentId": "sha256:<64 hex>",
          "name": "report.pdf",
          "bytes": 5242880
        }
      },
      { "type": "text", "text": "帮我看下这两份" }
    ]
  }
}
```

| block | 字段（逐字） | 证据 |
|---|---|---|
| `image` | `type:'image'`、`attachment:ImageAttachmentRef`、可选 `offloaded?: true`（只在 durable 日志里谈"图片卸载"，不出现于已卸载后的请求） | `llm/src/types.ts:79-89`、`compaction/compaction-image-offload/tests/image-offload.spec.ts:298-303` |
| `file` | `type:'file'`、`attachment:FileAttachmentRef`（**只有** `attachmentId/name/bytes`） | `llm/src/types.ts:98-102`、`attachment/src/types.ts:39-46` |
| `ImageAttachmentRef` | `attachmentId`、`mediaType`、`bytes`、`width`、`height`、`name?`、`originalDimensions?` | `attachment/src/types.ts:11-32` |
| 客户端界面侧的对应形状 | `UserContentAttachment = {type:'image',image} \| {type:'file',file}` | `ui-chat/src/client/contract/slots.ts:228`、`ui-chat/src/client/chat/MessageItem.tsx:31-36` |

### 3.3 durable 事件里**不会**出现的东西

base64、浏览器 objectURL、host 临时路径、provider URL 都不进日志（`docs/subsystems/attachment.md:5,7`；`attachment/src/types.ts:12,24-27` 的注释也逐条写了"never a filesystem path or bearer URL"）。

### 3.4 模型实际看到什么

| 类别 | 模型收到 | 证据 |
|---|---|---|
| 图片 | 由 provider adapter 把 ref 解析成**确定性请求版本**（按 route 选尺寸/字节目标）；DeepSeek adapter 有 **Files 引用**与**内联 base64** 两档，并各自有预算 | `llm-deepseek/src/images.ts:1,13-21,38-74`、`attachment` 服务 `readImageRequest`（`docs/subsystems/attachment.md:296-297`） |
| 普通文件 | **一行 handle 文本**，逐字模板：`[File "name" (N bytes, sha256:XXXXXXXX): verbatim read-only copy saved at "PATH". Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`；路径解析不到时有另一句"无法访问可读路径"的替代文案 | `llm/src/content.ts:151-158` |
| 替换发生点 | 请求装配时把每个 `file` block 换成 `text` block（`replaceFilesWithHandles` / `projectFilesToText`） | `llm/src/content.ts:161-175,185-208` |
| 图片在"无视觉模型"路由 | 有 text-only 占位文案（`textOnlyImageText`） | `llm/src/content.ts:76` |

### 3.5 读回（历史图片/replay）

| 动作 | 端点/方法 | 证据 |
|---|---|---|
| 读单张图片（授权校验：必须被本会话事件引用） | `session/attachment`（`{sessionId,attachmentId}` → `{attachment, data(base64)}`）；未引用 → `ATTACHMENT_NOT_REFERENCED` | `session-controller/src/index.ts:493`、`commands.ts:377-411` |
| 客户端封装 | `session.readAttachment(attachmentId)` → `readAttachment` → 页面转 `data:` URL | `ui-conversation/src/client/sessions/session.ts:322-329`、`ui-conversation/src/client/conversation/historical-images.ts:114` |

---

## 4. 桌面版 UI

### 4.1 入口：**不是**输入框左侧那个「+」

| 元素 | 真实身份 | 证据 |
|---|---|---|
| 输入行左侧圆形 `+` 按钮（`IconPlusOutlineMedium`） | 打开**斜杠命令菜单**（`t('input.commands')`），不是文件选择器 | `ui-conversation/src/client/skeleton/InputBar.tsx:441-454` |
| 文件入口 | 注册成命令 UI 动作：`name:'file'`、`label:t('input.file')`（中文"文件"）、`icon:IconPaperclipOutlineRegular`（**回形针**）；`run` → `inputHub.pickFiles(sessionId)` | `ui-conversation/src/client/apply.ts:298-307`、`ui-conversation/src/client/locales.ts:27` |
| 真实控件 | 隐藏的 `<input type="file" multiple>`；`onChange` → `intakeFiles(files)`，**选完立刻清空 value**（允许重复选同一文件） | `InputBar.tsx:455-462,243-249` |
| 无 `accept` 属性 | 代码里没有 `accept`（图片白名单在 intake 时按 MIME 过滤）；`disabled` 仅当子代理会话 | `InputBar.tsx:455-462` |
| 目录选择器（桌面） | 另有 `__DSH_DIRECTORY_PICKER__`（Electron IPC `directoryPick`） | `desktop-app/src/preload-app.ts:76-78` |

### 4.2 拖拽

| 行为 | 实现 | 证据 |
|---|---|---|
| 只在拖的是文件时介入 | `dataTransfer.types.includes('Files')` | `ui-attachment/src/client/drop-events.ts:36-40` |
| 嵌套计数器决定 overlay 显示 | `dragDepth` ref + `dragenter/leave` | `drop-events.ts:45-64` |
| 不可接收时给"禁止"光标 | `dropEffect = canAcceptDrop ? 'copy' : 'none'` | `drop-events.ts:51-56` |
| drop | `onAddFiles(files, droppedDirectories(...))` | `drop-events.ts:65-73` |
| overlay 文案 | "文件或图片拖动到此处即可添加" + "图片限制：最多 {count} 张，每张 {size}"（`{count}`/`{size}` 由 `imageLimits` 传入） | `ui-attachment/src/DropOverlay.tsx`、`InputBar.tsx:407-418`、`locales.ts:35-36` |
| 拖拽区安装点 | `ComposerAttachments` 挂 document 监听（不需要用户瞄准某个盒子） | `ui-attachment/src/client/ComposerAttachments.tsx:32-34` |

### 4.3 草稿轨 / 进度 / 失败重试 / 发送前移除

| 能力 | 实现 | 证据 |
|---|---|---|
| 横向附件轨（隐藏滚动条、边缘箭头翻页、新加的自动滚到末尾） | `AttachmentRail` | `ui-attachment/src/AttachmentRail.tsx:56-60,76-85,136-170` |
| 图片缩略图 + 原图灯箱 + `×` 移除 | 缩略图按钮 → `ImageLightbox`；`×` → `onRemoveAttachment` | `ComposerAttachments.tsx:74-105` |
| 文件卡三态 `uploading \| ready \| error` | `FileCard`：上传中=spinner+**进度条**（`progress = loaded/total`）、成功=扩展名+大小、失败=整卡按钮可点重试 | `ui-attachment/src/FileCard.tsx:19,22-48,50-62,71-78` |
| 进度数据源 | `DraftFileUpload{status:'uploading',loaded,total?}`；`onProgress` 由 Worker/XHR 上报 | `ui-conversation/src/client/contract/slots.ts:50-57`、`file-upload/src/client/runtime.ts:86-105` |
| 重试 | `onRetryFile(id)` → `retryFileUpload(sessionId,id)`：**仅当状态是 `error`** 才重新上传 | `ComposerAttachments.tsx:70`、`ui-conversation/src/client/apply.ts:531-533`、`ui-conversation/src/client/service.ts:326-331` |
| 发送前校验（图片：张数/单张/总量；文件：不校验） | `intakeFiles()`：批级拒绝 + toast；文件"选中即上传，无客户端上限" | `InputBar.tsx:206-239` |
| 发送时若还有文件在上传 | 阻止发送并提示"文件还在上传，请等待上传完成后发送" | `ui-conversation/src/client/input/editor/view-binding.ts:128-131`、`locales.ts:64` |
| 移除/释放 | `removeAttachment` → `conversation.releaseDraftAttachment(id)`（同时中止该文件的上传） | `apply.ts:527-529`、`ui-conversation/src/client/service.ts:345-353` |

### 4.4 发送后怎么展示（历史里）

| 内容 | 展示 | 证据 |
|---|---|---|
| 用户文本 + 附件 | `MessageItem.contentParts()` 把 `content[]` 拆成 `text` / `attachments(image|file)` / `rest` | `ui-chat/src/client/chat/MessageItem.tsx:18-40` |
| 图片 | 走 `conversation.chat.user.images` 插槽 → `MessageImages` → `ImageGallery`（用授权 loader 按 `attachmentId` 载入，**不用**日志里的字节） | `ui-attachment/src/client/index.ts:26-34`、`MessageImages.tsx:15-20` |
| 文件 | `{type:'file', file:FileAttachmentRef}`（名字/字节数来自 durable ref） | `ui-chat/src/client/contract/slots.ts:228`、`MessageItem.tsx:34-36` |
| 发送瞬间的回显（echo） | 用本地 `previewUrl` / 已 ready 的 `file` 复用同一套渲染；本地上传还没完成就发出会先显示 echo | `MessageItem.tsx:255-275` |

### 4.5 撤回能力边界（**这条决定移动端怎么设计"取消"**）

| 场景 | 能撤回吗 | 依据 |
|---|---|---|
| 选中后、发送前 | **能**：`×` 移除（文件卡/图片），文件上传被中止 | `ComposerAttachments.tsx:69,88`、`service.ts:345-353` |
| 已发送但**还在队列里**（未开始执行） | **能整条移除**：`updateQueue(itemId,{kind:'remove'})`；顺带 `retirePrompt` 收据 | `session-controller/src/types.ts:168-175`、`ui-conversation/src/client/queue/QueueDock.tsx:291`、`file-upload/src/index.ts:175-177` |
| 队列里想**改**附件 | **不能**：`QueueAction.kind:'edit'` 的 content 类型是 **`TextBlock[]`（纯文本）** | `session-controller/src/types.ts:168-175`、`ui-conversation/.../contract/slots.ts` 无编辑附件的入口 |
| 已落库（`user/message` 已 append） | **不能**：附件"永不删除"，没有删除端点 | `attachment/attachment/README.md:119`、`docs/subsystems/attachment.md:170`（retention-neutral，GC 推迟） |

---

## 5. 移动端可行性（重点）

### 5.1 先摆两个移动端现状事实（本仓库）

| 事实 | 证据 |
|---|---|
| 我们的 Android 壳**没有**实现 `WebChromeClient.onShowFileChooser`，所以网页里的 `<input type="file">` 点了**不会弹系统选择器**（WebView 里属于静默失败） | `本仓库 android/app/src/main/java/io/github/dshmobile/app/MainActivity.kt:115-119`（只覆写 `onPermissionRequest`）；全仓 grep `onShowFileChooser` 零命中 |
| 我们的网关 `POST /mobile-gateway/api/<method...>` 是**通用透传**（会转发到 `http://127.0.0.1/api/<method...>`），但 **body 全量缓冲在内存里，上限 32 MiB**；响应也 `arrayBuffer()` 全量缓冲 | `本仓库 packages/dsh-mobile-gateway/lib/bridge.mjs:17,112-125,216-243`（`MAX_BODY_BYTES = 32*1024*1024`，`:98`） |
| 透传闸门只拦 `settings./credentials./pluginManager./directoryPicker.` 前缀 —— `session/uploadFileBinary`、`workspaceFiles.list/stat/readBytes` 都**不在**拒绝名单 | `本仓库 …/bridge.mjs:32-62,163-172` |

结论：**"手机 → 电脑搬字节"这条路今天要额外做流式改造，而"引用电脑上的文件"这条路几乎不需要改网关。**

### 5.2 三条候选方案对比

| 方案 | 手机侧动作 | 需要新增什么 | 优点 | 致命缺点 |
|---|---|---|---|---|
| **A. 手机本地文件上传**（复刻桌面通道 A/B） | 系统 SAF 选文件 → 读字节 → `POST …/uploadFileBinary` → `content:[{type:'file',receiptId}]` | ① Android 原生 SAF/camera 桥或 `onShowFileChooser`；② 网关流式转发 + 去掉 32 MiB 全缓冲；③ 手机侧 auth 注入 | 语义与桌面完全一致（durable 快照、审计、模型能读副本） | 大文件要**先从电脑上传到手机再传回去**？不是——但如果文件本来就在电脑上，这是纯浪费；且要改网关（当前会 413 / OOM） |
| **B. 拍照 / 相册 → 图片附件** | `ACTION_IMAGE_CAPTURE` / photo picker → base64 → `session/prompt` 的 `{type:'image',mediaType,data}` | ① 原生桥返回 base64（或 `onShowFileChooser`）；② 前端附件 UI | **手机唯一不可替代的能力**（拍屏幕/白板/报错）；端点**今天就能用**；单图 ≤20 MiB 对手机照片足够 | 只解决"图片"；base64 走 RPC，300 MiB 上限够但不适合大图批量 |
| **C. 直接引用电脑上的文件/目录**（推荐主路径） | 手机上浏览 host 的目录树 → 选中 → 把 `@相对路径` 作为**文本**发出去（或未来做成 file block） | ① 手机端文件浏览器 UI；② 复用 `workspaceFiles.list`（+`stat`/`readBytes` 预览）；③ 若要"附件卡"语义则需**新端点** | 字节零传输、无大小上限、手机流量/内存友好；与桌面 `@path` 行为**逐字一致**；网关今天就能透传 | 只是文本引用：**不是**不可变快照（模型读的是当前文件，可能被改）；没有 file block 的展示/审计/收据语义 |

### 5.3 推荐：主路径 C，辅路径 B，A 只在"文件确实在手机上"时用

**为什么 C 是"最省事且可靠"**：
1. 用户的诉求是"**让电脑上的 agent 处理文件**"。文件已经在电脑上时，把它搬到手机再搬回去，只增加失败面（网关 32 MiB 缓冲、移动网络、电量），不增加任何能力。
2. 桌面版**已经证明** `@path` 文本引用这条链路可用：`apply.ts:505-513` 造引用、`grammar.ts:45-55` 规定逐字语法（含空格用 `@"…"`）、并在 child prompt 里被显式区别对待（`InputBar.tsx:214-219`）。移动端只要生成同样的文本，**host 侧的引用解析、工具读取完全复用**。
3. 网关只需透传 `workspaceFiles.list/stat`（RPC），**不需要改流式上传**；响应体积由 host 侧 `maxEntries:2000` / `maxBytes` 兜底（`workspace-files/src/index.ts:186-191`）。
4. 语义损失是**可解释的**：`@path` 是"让 agent 去读那个路径"，不是"冻结这份字节"。对"帮我看下 ~/Downloads/report.pdf"这类请求完全够用。

**推荐的具体产品形态（三步）**：
- 会话页输入区加**回形针**按钮 → 打开"电脑文件"浏览器（宿主目录树：`workspaceFiles.list`，root = 会话的 `cwd`，可向上/向下；条目显示 name/type/size）；
- 选中 → 插入 `@相对路径`（目录则 `@相对路径/`），与桌面同一语法；
- 另加**相机/相册**按钮 → 走方案 B 的图片附件（base64 + `session/prompt`）。

**如果必须要有"附件卡 + 不可变快照"语义**（例如需要"这份文件当时就是这样"的审计、或要把文件内容喂给无文件工具的环境），才需要 §5.4 的新端点。

### 5.4 需要的新端点 / 原生能力清单

| # | 能力 | 必要性 | 形状（建议，标注了与现有代码的对齐点） |
|---|---|---|---|
| N1 | **浏览 host 文件树** | 主路径必需 | 直接复用**已有** `workspaceFiles.list(scope, path)` / `stat` / `readBytes`（`workspace-files/src/index.ts:233-343`）；`workspaceFileScope` 由 sessionId 解析（`:202-221`）。⚠️ 手机只需一个新的 UI + 一次 `session.*`/`workspaceFiles.*` RPC 调用 |
| N2 | **把已有 host 路径登记成 file 附件**（可选，补 C 的语义） | 想要附件卡/审计才需要 | **现有端点里不存在**：host 侧只有两条写文件的入口 —— `fileUploads.upload/uploadStream`（要客户端送字节，`file-upload/src/index.ts:104-130`）与 `attachments.saveFile/saveFileStream`（`attachment/src/index.ts` 的抽象，仅被 `admission.ts:70` 与 file-upload 调用）。需要新增例如 `attachments.saveHostFile({ownerSessionId, path, name?}) → FileAttachmentRef`（host 侧读自己磁盘 → 落 immutable 对象），然后照旧 `content:[{type:'file',receiptId 或 ref}]`。**此端点属于桌面版没有的能力，需与 host 团队确认** |
| N3 | **拍照 / 相册** | 辅路径必需（且是手机独占价值） | 两条实现路线：(a) **WebView 内**：给 `MainActivity` 加 `onShowFileChooser` + `FileChooserParams`（并在 manifest/FileProvider 配 camera intent），网页照抄桌面 `encodeImage`（`ui-conversation/src/client/service.ts:569-575`）→ `{type:'image',mediaType,data}`；(b) **原生桥**：`NativeBridge.pickImage()` 返回 `{mediaType, base64, name?, width?, height?}`（与现有 `NativeBridge` 的"只返回 JSON 字符串、不抛异常"约定一致），前端合成同样的 image part |
| N4 | **网关流式上传 + 上限放开**（只在选 A 时需要） | 方案 A 必需 | 现在 `readBody` 全缓冲 + 32 MiB 上限（`本仓库 …/bridge.mjs:112-125`）。需要：把 raw 路由标成 streaming 并边读边转发；同时确认 host 侧 `/api/session/uploadFileBinary` 在网关这条链路上的鉴权（网关用 operator peer 转发，`bridge.mjs:135-137`） |
| N5 | **附件 UI（移动端）** | 主/辅路径都要 | 复刻 `AttachmentRail`/`FileCard`/缩略图，但**不要**复刻拖拽（手机没有）；进度只在方案 A 有意义 |
| N6 | **发送前校验** | 方案 B 必需 | 复刻 `intakeFiles` 的三条图片校验（张数/单张/总量，`InputBar.tsx:220-235`），因为手机照片常在 20 MiB 边缘 |

### 5.5 明确不要做的

1. **不要把"传文件"默认实现成"手机中转大文件"**：host 端普通文件本来就没有大小限制（逐字节），而我们的网关今天 32 MiB 全缓冲 —— 一传大文件就会 413 或内存尖峰（`本仓库 …/bridge.mjs:98,112-125`）。
2. **不要假设图片能走"仅引用路径"**：图片走的是 base64 prompt 通道（`session-controller/src/types.ts:90-98`），路径引用对图片没有等价物。
3. **不要指望发送后撤回附件**：只有队列里的整条消息能 `remove`，落库后附件永久保留（§4.5）。
4. **不要只做 `@path` 文本而忘记"路径是相对的"**：桌面用 `relativizeToCwd(path, cwd)`（`util/workspace-path/src/index.ts:107`），移动端也必须拿到会话 `cwd`（会话列表里已有该字段），否则引用会失效。

---

## 6. 未验证 / 文档与代码不一致

| 项 | 情况 |
|---|---|
| 规范化"长边"上限 | 文档写"long edge to 2048 pixels"（`docs/subsystems/attachment.md:59`），**代码是** `normalizedImageMaxDimension = 8192`、像素预算才是 `2048*2048`（`attachment-local/src/index.ts:50-54`）。实现以代码为准；文档那句是简化说法 |
| 图片到 provider 的具体形态 | 只验证到"adapter 有 Files 引用与内联 base64 两档预算"（`llm-deepseek/src/images.ts:1,13-21`）。**未逐行验证**何时选 Files、何时内联 |
| JSON 示例 | 字段名来自类型定义与测试夹具（§3.2 已逐条给行号），但**没有在运行中抓包**；`seq/time` 的具体数值是示意 |
| 手机端 RPC 可用性 | 已确认 `workspaceFiles.*` / `session/uploadFileBinary` **不在**网关拒绝名单（`本仓库 …/bridge.mjs:32-62`），但**未实测**手机经网关调用这两条的真实往返（未跑构建/真机） |
| 桌面版真实界面 | 只读代码，未运行桌面应用；"回形针在命令菜单里"由 `apply.ts:298-307` 的注册项 + `InputBar.tsx:441-454` 的 `+` 语义推出 |
| Deliverables（顺带结论） | `tool-present` 是**反方向**（host → 用户）：把**已存在的 host 文件按路径**声明为交付物，事件 `deliverables/presented{files:PresentedFile{path,description}[]}`，内容不复制、上限默认 8 个（`deliverables/tool-present/src/types.ts:4-16`、`src/index.ts:22-24,39-53`）。它与"用户上传附件"不是同一条链，**不要混用** |