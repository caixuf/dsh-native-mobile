# DSH 宿主插件可复用的接缝（host-seams）

> **来源**：本机已安装且正在运行的真实插件 `dsh-bot-gateway@0.3.9-beta`
> （`C:\Users\me\.dsh\node_modules\dsh-bot-gateway\`），以及本机 DSH 实例的
> Cordis 运行时实时自省结果（`cordis_inspect` Provider `Service` / `Event` / `Config`）。
> 文中每条结论都带 `file:line` 引用；`live:` 前缀的引用表示来自 DSH 运行时自省而非文件。
>
> **路径缩写**：`BG` = `C:\Users\me\.dsh\node_modules\dsh-bot-gateway\`，
> `PATCH` = `C:\Users\me\.dsh\cordis.patch.yml`（机器级组合补丁）。

---

## 0. 一页速览：五个核心接缝

| # | 接缝 | 服务 / API | 位置 |
|---|---|---|---|
| 1 | 挂 HTTP 路由 | `ctx.inject(['webServer'])` → `webServer.register({kind:'prefix', path, handler})` | `BG\index.mjs:482` / `:473` |
| 2 | 建/恢复会话 | `agents.get` → `sessionPersistence.list` → `agents.resume` → `agents.create` | `BG\lib\core.js:877-945` |
| 3 | 发消息 + 等回合 | `agent.followup(msg)` + `agent.whenIdle()` + `sessions.flush(session)` | `BG\lib\core.js:1129` / `:1150` / `:1157` |
| 4 | 收流式事件 | `ctx.on('session/event', (session, event) => …)` | `BG\lib\core.js:106` |
| 5 | 落盘状态 | `resolveBotGatewayPath()` → `$DSH_HOME/<pkg>/…`，原子 tmp+rename | `BG\lib\util.js:82` / `BG\lib\settings.js:90` |

**最重要的三条负面结论（源码中不存在的能力）：**

- **插件完全没有使用 WebSocket 承载。** 全仓库 grep `registerUpgrade` 零命中。插件要 WS 时是**自己起一个 `node:http` 服务器**并手写 RFC6455（`BG\lib\util.js:272-487`），绑在 `127.0.0.1:3002`（`BG\lib\adapters\onebot11.js:369-394`）。宿主其实提供了正确的接缝 `webServer.registerUpgrade(WebUpgradeRoute)`（live: `WebUpgradeRoute = { path, handler(req, socket: Duplex, head: Buffer) }`），但插件没用 —— **移动网关应该用它，而不是抄这个插件的私有 WS 服务器。**
- **插件完全不经过 `/api`。** grep `'/api'`、`api/events`、`authenticatedUrl`、`ctx.get('connection')` 全部零命中。它对 DSH 的每一次调用都是**进程内 `ctx.get(...)` 直调**，不是 HTTP。
- **插件没有声明 Cordis Config schema。** `live:` Config 自省显示 Loader 条目 `include:bot-gateway`（`name: dsh-bot-gateway`）的 `status` 为 **`absent`** —— 即 DSH 拿不到它的配置表单。GUI 面板是「自绘 iframe」，不是 DSH 的 schema 投影表单。

---

## 1. 插件包解剖（package.json / cordis.patch.yml）

### 1.1 `package.json` 里真正起作用的字段

`BG\package.json` 全文只有 76 行，**没有任何 `dependencies`、没有任何 `peerDependencies`**（这很关键，见 §6）：

| 字段 | 行 | 值 | 为什么必须 |
|---|---|---|---|
| `name` | `BG\package.json:2` | `"dsh-bot-gateway"` | 组合行 `name:` 用的**裸包名**；也是浏览器半边花名册 id（`BG\README.md:346`） |
| `type` | `:4` | `"module"` | 入口是 `.mjs`，但 `lib/*.js` 全是 ESM，必须声明 |
| `main` | `:6` | `"./index.mjs"` | **宿主半边入口**。Cordis Loader 只读这一个 |
| `exports["."]` | `:7-11` | `"./index.mjs"` | 与 `main` 一致；`"./client"` 供浏览器半边分发 |
| `files` | `:12-20` | `["index.mjs","client.js","lib/","README.md","CHANGELOG.md","LICENSE","SPEC.md"]` | 打包白名单 |
| `dsh.client.platform` | `:35-38` | `"web"` | **声明浏览器半边存在**。宿主 `clientModules` 扫到它才把 `exports["./client"]` 纳入花名册（`BG\client.js:7-11`） |
| `dsh.compat.minDshVersion` | `:40` | `"0.1.2-alpha.4"` | 最低宿主版本 |
| `dsh.compat.testedDshVersion` | `:41` | `"0.2.1-alpha.1"` | 实测版本 |
| `engines.node` | `:44-46` | `">=20"` | |

宿主半边还必须导出 `name`，Cordis 靠它认领 fiber：

```js
// BG\index.mjs:34
export const name = 'bot-gateway';
```

```js
// BG\index.mjs:308
export function apply(ctx, rawConfig) { … }
```

### 1.2 `cordis.patch.yml` 注册行

**只有两行**，且必须写在**机器级** `<dsh-home>\cordis.patch.yml`，不是 profile 级：

```yaml
# PATCH:16-19（本机真实内容）
- insert:
    - id: bot-gateway
      name: dsh-bot-gateway
      # Runtime data defaults to $DSH_HOME/bot-gateway/; no config needed.
```

为什么必须是机器级 —— `PATCH:3-6` 自己写了原因：

```yaml
# PATCH:3-6
# This layer is separate from profiles/desktop/cordis.patch.yml on purpose:
# DSH Desktop isolates the whole profiles/ directory into profiles.broken-<ts>
# and recreates it when the backend fails to start, which drops profile-level
# patches. This file survives that and keeps applying after a restart.
```

顶层必须是 YAML 数组（`PATCH:15`）。`id:` 只是补丁标识（补丁引用它），`name:` 才是模块解析键。注册后运行时条目 id 变成 `include:bot-gateway`（live: Config 自省返回值），补丁侧的引用名仍是 `bot-gateway`。

### 1.3 一行注册同时挂起宿主半边 + 浏览器半边

`BG\README.md:338-353` 讲得很明确：同一个裸包名行，**宿主半边 = 包 `main`，浏览器半边 = `package.json` 的 `dsh.client` 声明经 `exports["./client"]`**。不需要第二行，不需要 `client-entry.mjs` 占位（旧 0.1.1 时代的东西，已废弃）。

分发 URL 由宿主组合，不是你能预测的（`BG\README.md:351-353`）：

```
/plugins/??<id>/client.js&rev=<rev>
```

所以浏览器半边无法靠探测 URL 自证注册，插件为此专门开了个诊断端点 `/bot-gateway/api/client`，读 `clientModules.graph()`（`BG\lib\webui.js:239-261`）。

### 1.4 **纯宿主插件（无浏览器半边）怎么注册**

**答案：完全一样的一行，只是 `package.json` 里不写 `dsh.client`、不写 `exports["./client"]`、不放 `client.js`。**

依据链：

1. 浏览器半边的**唯一**产生条件是 `package.json` 的 `dsh.client` 声明 —— `BG\client.js:7-11`：「宿主侧 client-modules 扫描到 package.json 的 `dsh.client` 声明后，经 `/plugins/<id>/client.js` 以经典脚本分发本文件」。没有这个声明，宿主没有任何机制去找 `client.js`。
2. 本机已有**纯宿主、无 `dsh.client` 声明**的对照样本：`dsh-wsl-workspace`、`dsh-terminal-panel`、`dsh-theme-studio`、`dsh-wallpaper-bg` 等（live: `list_bundles`），它们全部只有 `rows:[{moduleName:"<bare-name>"}]`，无 client 产物。
3. 宿主半边不受影响：`main` / `exports["."]` 照常，`apply(ctx, config)` 照常。

所以最小宿主包骨架：

```json
{
  "name": "dsh-native-mobile",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.mjs",
  "exports": { ".": "./index.mjs", "./package.json": "./package.json" },
  "dsh": { "compat": { "minDshVersion": "0.2.0-rc.2", "testedDshVersion": "0.2.0-rc.2" } },
  "engines": { "node": ">=20" }
}
```

```yaml
# <dsh-home>\cordis.patch.yml
- insert:
    - id: native-mobile
      name: dsh-native-mobile
```

### 1.5 node_modules 解析怪癖：Loader 实际从哪个目录读

**本机实测布局**：`C:\Users\me\.dsh\node_modules\dsh-bot-gateway\`
—— 即装在 **`$DSH_HOME/node_modules`**，不是 `profiles/desktop/node_modules`。

`BG\README.md:344-347`：

> client-modules 从 Loader 条目定位 `package.json`（**裸包名行直指 `<dsh-home>\node_modules\dsh-bot-gateway\package.json`**），按清单名 `dsh-bot-gateway` 注册浏览器半边 —— 无需单独的 client 行

`BG\README.md:358-359` 补了一条坑：

> 解析路径：`<dsh-home>\node_modules\dsh-bot-gateway\`（npm 标准包布局；`profiles\<name>\node_modules` 可放 **junction 镜像**保证 profile 解析稳定）

**怪癖一：裸包名的解析基准是 `<dsh-home>`，不是 profile。** 装在 profile 下裸名可能解析不到，所以出现了 `file://` 绝对 URL 行的写法 —— live: `list_bundles` 里 `dsh-wsl-tool` 的行就是：

```json
{ "rowId": "tool-wsl",
  "moduleName": "file:///C:/Users/me/.dsh/profiles/desktop/node_modules/dsh-wsl-tool/index.js",
  "entryId": "include:tool-wsl" }
```

对比同页的 `dsh-wsl-workspace`（正常裸名）：

```json
{ "rowId": "wsl-workspace", "moduleName": "dsh-wsl-workspace", "entryId": "include:wsl-workspace" }
```

**这是可选的退路**：裸名解析失败时，用 `file://` 绝对 URL 行可以在 profile 下稳定解析（代价：profile 迁移/换机器要改路径）。

**怪癖二：插件自己推 `dsh-home` 时必须先信 `DSH_HOME` 环境变量。** `BG\lib\util.js:32-74`：

```js
// BG\lib\util.js:36-42  —— 权威来源
const envHome = process.env.DSH_HOME;
if (envHome && envHome.trim()) {
  const candidate = resolve(envHome.trim());
  if (existsSync(join(candidate, 'settings.yaml')) || existsSync(join(candidate, 'sessions'))) {
    baseDir = candidate;
  }
}
// BG\lib\util.js:47 —— 退路：从 node_modules/dsh-bot-gateway/lib 上溯三级
const try1 = resolve(moduleDir(), '../../../');
```

「上溯三级」只在包恰好装在 `<dsh-home>/node_modules/<pkg>/lib` 时才等于 dsh-home。装到 `profiles/x/node_modules` 就只到 `profiles/`，必须靠 `DSH_HOME` 救。且注意 `DSH_HOME` 也要**验真**（存在 `settings.yaml` 或 `sessions` 才认），否则退到模块位置。

---

## 2. 从宿主半边拿 Cordis 服务

### 2.1 `ctx.inject` —— 等异步就绪服务的唯一正确姿势

`webServer` 是**异步就绪**的（listen 绑定 + 注入 `webStartup` 依赖链），可能在插件 `apply` 之后才出现。插件为此踩过坑，注释就是教科书：

```js
// BG\index.mjs:410-414
// 4. webui 路由注册（服务就绪驱动）
// webServer 是异步就绪的服务（listen 绑定 + 注入 webStartup 依赖链）：启动竞态下
// 可能晚于本插件 apply —— 一次性 ctx.get 会永远错过并静默禁用看板（表现为
// /bot-gateway/ 404 空白页、重启后偶发不挂载）。改用 ctx.inject 子纤维：
// 服务出现即挂路由；适配器装配不受影响（无 webServer 的 profile 仅看板降级）。
```

```js
// BG\index.mjs:482-487  —— 实际调用
if (typeof ctx.inject === 'function') {
  ctx.inject(['webServer'], mountWebuiRoutes);
} else {
  // 宿主过旧或测试 mock 无 inject 能力：一次性探测兜底（无法等晚就绪的服务）
  mountWebuiRoutes(ctx);
}
```

回调签名是 **`(webCtx) => …`**，注意拿到的是**子 fiber 的 ctx**：

```js
// BG\index.mjs:415-422
const mountWebuiRoutes = (webCtx) => {
  const webServer = webCtx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    log.warn('webServer 服务缺少 register 方法，跳过看板路由');
    return;
  }
  log.info('webServer 服务就绪，挂载 /bot-gateway/ 路由看板');
```

> **`await ctx.inject([...])` 在本插件中并未出现。** 插件用的是**不 await 的 fire-and-forget**（`index.mjs:483`），靠子 fiber 自己管理生命周期。对移动网关而言，如果你希望 `apply` 返回时路由已就绪，可以 `await`，但那会让插件挂载阻塞到 webServer 就绪 —— 插件作者明确选择了不阻塞。

### 2.2 `ctx.get` —— 核心业务服务都在回合驱动时按需取

插件对 DSH 业务服务的取用全部是 `this.ctx.get('...')` + 空值降级：

```js
// BG\lib\core.js:809-810
const agents = this.ctx.get('agents');
if (!agents) return null;
```

```js
// BG\lib\core.js:816-821
const defaultModelService = this.ctx.get('agentDefaultModel');
const selection = (hasOverride && !opts.ignoreConfigModel)
  ? { provider: override.provider, model: override.model }
  : (!opts.ignoreConfigModel && this.config.model?.provider
    ? this.config.model
    : (defaultModelService?.currentSelection?.() || {}));
```

```js
// BG\lib\core.js:1110
const sessions = this.ctx.get('sessions');
```

可选的第三方服务取法（防御式，因为该插件可能不存在）：

```js
// BG\index.mjs:470
getClientModules: () => webCtx.get('clientModules'),
```
```js
// BG\lib\core.js:1991
const mc = this.ctx?.get ? this.ctx.get('mobileCompanion') : null;
```

### 2.3 全部被注入 / `ctx.get` 过的服务名

| 服务名 | 取用位置 | 一句话含义 |
|---|---|---|
| `webServer` | `index.mjs:416`、`:483` | **HTTP 承载**。挂具名 route / upgrade route / fallback；异步就绪，必须 inject |
| `agents` | `core.js:809` | Agent 注册表 + 驱动链。`create`/`resume`/`get`/`list`，返回 `{agent, dispose}` 句柄 |
| `sessions` | `core.js:1110` | 内存会话 store。`flush(session)` 把日志落盘 |
| `sessionPersistence` | `core.js:888` | 持久化会话清单。`list()` 用来判断某 sessionId 是否还能 resume |
| `sessionTitle` | `core.js:786` | 会话标题折叠。`rename(session, title)` 可钉死标题、压制 LLM 自动命名 |
| `agentDefaultModel` | `core.js:816` | 默认模型选择。`currentSelection()` → `{provider, model}` |
| `agentPresets` | `core.js:828` | 预设注册表。`resolve(id)` + `mount(agentCtx, id)` **挂载工具集** |
| `clientModules` | `index.mjs:470` | Web 插件花名册。`graph()` 诊断浏览器半边是否注册成功（可选服务） |
| `mobileCompanion` | `core.js:1991` | 第三方可选服务，本插件防御式探测后使用 |

`live:` 服务契约（DSH 0.2.0-rc.2 自省）确认了 `agents` 的两种调用形式：

```ts
// live: agents service contract
async create(options: CreateAgentOptions): Promise<AgentHandle>
async resume(options: ResumeAgentOptions): Promise<AgentHandle>
get(id: SessionId): Agent | undefined

// live: CreateAgentOptions
{ sessionId, parentAgent?, meta?: {cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset},
  inheritedEventCount?, seed?, agentOptions?: {provider, model, reasoningEffort, maxTokens},
  signal?, setup?: (agentCtx, agent) => AgentSetupCommit | Promise<...> | void }

// live: AgentHandle
{ agent: Agent, dispose(): Promise<void> }
```

### 2.4 事件与清理

```js
// BG\lib\core.js:106-108  —— ctx.on 返回反注册函数
this.unsubEvents = this.ctx.on('session/event', (session, event) => {
  this.handleSessionEvent(session, event);
});
```

```js
// BG\lib\core.js:131-144  —— agent/error：单对象参数，不是 (agent, payload) 双参
this.ctx.on('agent/error', (evt) => {
  const sid = evt?.agent?.session?.id ?? evt?.agent?.id;
  if (!sid || !ourSessionIds().has(sid)) return;
  this._diag?.(`agent/error session=${sid} …`);
});
```

```js
// BG\index.mjs:526-537  —— 对称清理：一切注册都必须在 ctx.effect 里
ctx.effect(() => async () => {
  log.info('清理 bot-gateway 插件句柄、适配器与 NapCat 托管进程...');
  try {
    if (controller) { await controller.dispose(); }
    napcatProc.dispose();
  } catch (e) { log.error('清理过程报错:', e); }
}, 'bot-gateway: disposer');
```

> **注意 `this.ctx.on(...)` 在 `core.js:131` / `:145` 的返回值被丢弃了**（没有存进 `unsubEvents`），只在 dispose 时靠进程退出兜底。这是插件的一个瑕疵，不是推荐做法。`SPEC.md:24` 明确要求「插件的 `apply` 必须幂等、可清理（ctx.effect 反注册一切）」。

`live:` `session/event` 契约（注意是 **post-commit、fire-and-forget**，监听器抛错被吞、不会让 append 失败）：

```ts
// live: session/event
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

`live:` `SessionEventMap` 的完整形状（流式网关必须认全这些 type）：

```ts
'turn/start'   { turn }
'turn/end'     { turn, reason }
'step/start'   { turn, step }
'step/end'     { turn, step }
'user/message'      UserMessage
'assistant/message' { turn, step, message, stream, usage?, interrupted? }
'assistant/attempt' { turn, step, stream }
'tool/call'    { turn, step, callId, name, arguments }
'tool/result'  { turn, step, message, error?, meta? }
'request/header' { header, reason, startsSeries? }
'request/context' RequestContext
```

---

## 3. 提供 HTTP 服务

### 3.1 注册：唯一一次 `webServer.register`

```js
// BG\index.mjs:473-479
webCtx.effect(() => {
  return webServer.register({
    kind: 'prefix',
    path: '/bot-gateway',
    handler,
  });
}, 'bot-gateway: webui route');
```

`live:` 契约：

```ts
// live: WebRoute
{ kind: 'exact' | 'prefix', path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
```

要点：
- `kind:'prefix'` 时，**handler 收到的 `req.url` 是完整路径**，插件自己再判别（`webui.js:292-293`）。所以 `path` 不要带尾斜杠，路径判别全在 handler 里。
- `register` 返回 disposer；插件把它 `return` 给 `ctx.effect`，卸载自动反注册。
- live 契约明确：**同表内重复 `(kind, path)` 会 throw**，「route 模式是组合层约定，冲突即配置错误」。

### 3.2 handler 骨架：解析 URL → 校验 → 分派 → 写响应

```js
// BG\lib\webui.js:291-322（节选，删去中间 API 分支）
return async function handleWebuiRequest(req, res) {
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  const pathname = urlObj.pathname;

  // 安全防护校验
  const secCheck = validateRequestSecurity(req);
  if (!secCheck.ok) {
    log.warn(`安全拦截 (${pathname}): ${secCheck.message}`);
    res.writeHead(secCheck.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(secCheck.message);
    return;
  }

  try {
    if (pathname === '/bot-gateway' || pathname === '/bot-gateway/') {
      const html = renderStatusPageHtml(pluginVersion);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    …
```

**响应写法就是朴素 Node `ServerResponse`**：`res.writeHead(status, headers)` + `res.end(body)`，没有 DSH 包装层。

### 3.3 请求体解析（带 1MB 限流 + 15s 超时）

```js
// BG\lib\webui.js:153-199
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const JSON_BODY_TIMEOUT_MS = 15000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;
    let timer = null;
    const done = (err, value) => {
      if (settled) return;              // 统一出口，防止二次 settle
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    timer = setTimeout(() => {
      done(new Error(`读取请求体超时（${JSON_BODY_TIMEOUT_MS / 1000}s）`));
      req.destroy?.();
    }, JSON_BODY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    req.on('data', (chunk) => {
      size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (size > MAX_JSON_BODY_BYTES) {
        done(new Error(`请求体过大（上限 ${MAX_JSON_BODY_BYTES / 1024 / 1024}MB）`));
        req.destroy?.();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return done(null, {});
      try { done(null, JSON.parse(body)); }
      catch (e) { done(new Error(`JSON 格式非法: ${e.message}`)); }
    });
    req.on('aborted', () => done(new Error('请求被客户端中断')));
    req.on('error', (e) => done(e));
  });
}
```

> **移动网关必须比这更严。** 这套只挡体积和慢速，不做认证。`res.end()` 前要自己加鉴权（见 §7）。

### 3.4 三层来源校验 —— 直接抄

```js
// BG\lib\webui.js:85-138（节选）
function validateRequestSecurity(req) {
  // 1. Loopback 地址校验
  const remoteAddr = req.socket.remoteAddress || '';
  const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
  if (!isLoopback) {
    return { ok: false, status: 403, message: 'Forbidden: Direct access denied (loopback only)' };
  }

  // 2. Host 主机名校验（关键：只比端口挡不住 DNS rebinding）
  const hostHeader = req.headers.host || '';
  const hostName = String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(hostName)) {
    return { ok: false, status: 403, message: 'Forbidden: Host not loopback' };
  }

  // 3. Host 端口校验
  const localPort = req.socket.localPort;
  if (localPort) {
    const hostPortMatch = hostHeader.match(/:(\d+)$/);
    const hostPort = hostPortMatch ? Number(hostPortMatch[1]) : (req.socket.encrypted ? 443 : 80);
    if (hostPort !== localPort) {
      return { ok: false, status: 403, message: `Forbidden: Host port mismatch (expected ${localPort})` };
    }
  }

  // 4. CSRF 防护（仅 POST …）
  if (req.method === 'POST') {
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite) {
      if (secFetchSite !== 'same-origin') {
        return { ok: false, status: 403, message: 'Forbidden: CSRF blocked (sec-fetch-site)' };
      }
    } else {
      const origin = req.headers.origin;
      if (origin) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.host !== hostHeader) {
            return { ok: false, status: 403, message: 'Forbidden: CSRF origin mismatch' };
          }
        } catch {
          return { ok: false, status: 403, message: 'Forbidden: Invalid Origin header' };
        }
      }
    }
  }
  return { ok: true };
}
```

对副作用 GET 路由另设名单（`webui.js:147-151`, `:307-313`）—— 顶层导航 `Sec-Fetch-Site: none`，一刀切 same-origin 会把正常打开看板也挡掉。

> ⚠️ **这套校验对本机当前配置会全量拒绝**：`PATCH` 的 profile 层把 webserver 绑成了 `host: '0.0.0.0', port: 19387`（见 §7）。移动网关不能照抄 loopback-only 那一条，得改成「token 鉴权 + Host 白名单 + trustedHosts」。

### 3.5 WebSocket：**本插件没有用宿主接缝**（重要负面结论）

- 全仓库 `registerUpgrade` **零命中**。
- 插件要 WS 时自建服务器：`BG\lib\util.js:272` `createWsServer({port, host, onConnection, onMessage, onClose, onError})`，`server.on('upgrade', ...)` 手算 `Sec-WebSocket-Accept`（`util.js:281-302`），自己解帧/掩码/分片（`util.js:338-430`），自己写帧（`util.js:495-523`）。
- 使用点（OneBot 反向 WS 模式）：

```js
// BG\lib\adapters\onebot11.js:369-394
function startReverseWs() {
  const port = adapterConfig.listenPort || 3002;
  const host = adapterConfig.listenHost || '127.0.0.1';
  wsServerObj = createWsServer({
    port, host,
    onConnection(conn) {
      if (adapterConfig.accessToken) {
        const reqUrl = conn.req.url || '';
        const tokenMatch = reqUrl.match(/access_token=([^&]+)/);
        const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : '';
        if (token !== adapterConfig.accessToken) {
          log.warn('反向 WS 鉴权失败，拒绝连接');
          conn.close(4001, 'Unauthorized token');
          return;
        }
      }
      …
```

**这正好演示了移动 WS 网关该抄哪一段**：握手期 token 校验（`conn.close(4001)`）的思路是对的，但**端口/服务器应该交给 `webServer.registerUpgrade`**：

```ts
// live: WebUpgradeRoute —— 宿主提供的正确接缝
{ path: string,
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void> }
```

live 契约补充：upgrade **只做精确 pathname 匹配**，未命中直接关连接；重复 path 会 throw。

---

## 4. 功能性调用 DSH（最重要的一节）

**结论先行：全部进程内 `ctx.get(...)` 直调，一条 HTTP 都不走。** 这既是性能优势也是硬约束（见 §7）。

### 4.1 编排入口：三步「确保 agent 句柄」

这是整个插件最核心的 90 行，`BG\lib\core.js:844-966`。注释本身就是从 `dsh-host-apiproxy` 抄来的契约：

```js
// BG\lib\core.js:844-854
/**
 * 确保 Task 拥有可用的 DSH Agent 句柄。
 * 严格对齐 dsh-host-apiproxy 的 ensureSession 模式：
 *   1) agents.get(sessionId) 活跃句柄直接复用；
 *   2) 持久化里已存在该会话（重启恢复）→ agents.resume；
 *   3) 全新会话 → agents.create（其内部 prepare+enter 会自行建会话，
 *      绝不能提前 sessions.create，否则 enter 抛 "already exists"）；
 *   4) create 撞 "already exists"（sessions store 残留条目…）→ 换新 sessionId 自愈重试。
 */
```

**步骤 1 — 活跃复用：**

```js
// BG\lib\core.js:876-885
const live = agents.get(task.sessionId);
if (live && live.agent) {
  task.agent = live.agent;
  // 粘性会话下多个 Task 共享同一 agent：dispose 只归创建它的 Task 管
  task.dispose = null;
  this.applySessionTitle(task);
  return true;
}
```

**步骤 2 — 持久化命中则 resume：**

```js
// BG\lib\core.js:887-908
const persistence = this.ctx.get('sessionPersistence');
if (persistence && typeof persistence.list === 'function') {
  try {
    const stored = (await persistence.list()).find((h) => h && h.id === task.sessionId);
    if (stored) {
      this.log.info(`Task [${task.id}] 命中持久化会话，resume 恢复`);
      const resumed = await agents.resume({
        resumeSessionId: task.sessionId,
        ...(agentOptions ? { agentOptions } : {}),
        setup: composeSetup,
      });
      task.agent = resumed.agent;
      task.dispose = resumed.dispose;
      this.applySessionTitle(task);
      return true;
    }
  } catch (e) {
    this.log.warn(`Task [${task.id}] resume 失败，退回 create 路径重新开轮: ${e.message}`);
  }
}
```

**步骤 3 — 全新会话 create（工作区目录必须先存在）：**

```js
// BG\lib\core.js:910-921
await mkdir(task.workspaceDir, { recursive: true });

const createAgent = (sid) => agents.create({
  sessionId: sid,
  ...(agentOptions ? { agentOptions } : {}),
  meta: {
    cwd: task.workspaceDir,
    ...(presetId !== undefined ? { agentPreset: presetId } : {})
  },
  setup: composeSetup,
});
```

**步骤 4 — "already exists" 自愈（残渣条目）：**

```js
// BG\lib\core.js:923-945
let created;
try {
  created = await createAgent(task.sessionId);
} catch (e) {
  if (!/already exists/i.test(String(e?.message || ''))) throw e;
  const oldId = task.sessionId;
  this.tasksBySession.delete(oldId);
  task.sessionId = randomUUID();
  this.tasksBySession.set(task.sessionId, task);
  const chat = this.chats.get(task.chatKey);
  if (chat && chat.sessionId === oldId) { chat.sessionId = task.sessionId; }
  this.log.warn(`Task [${task.id}] 会话 ${oldId} 撞上 store 残留条目（already exists），已换新会话 ${task.sessionId} 自愈重试`);
  this.saveStateThrottled();
  created = await createAgent(task.sessionId);
}

task.agent = created.agent;
task.dispose = created.dispose;
```

### 4.2 模型选择链 + **必须挂工具集**

```js
// BG\lib\core.js:800-842（核心）
async buildAgentContext(opts = {}) {
  const agents = this.ctx.get('agents');
  if (!agents) return null;

  // 模型选择链：用户专属 > config.model > 系统默认
  const override = opts.modelOverride;
  const hasOverride = Boolean(override?.provider && override?.model);
  const defaultModelService = this.ctx.get('agentDefaultModel');
  const selection = (hasOverride && !opts.ignoreConfigModel)
    ? { provider: override.provider, model: override.model }
    : (!opts.ignoreConfigModel && this.config.model?.provider
      ? this.config.model
      : (defaultModelService?.currentSelection?.() || {}));
  const agentOptions = (selection.provider && selection.model)
    ? { provider: selection.provider, model: selection.model }
    : undefined;

  // Agent Preset 组装（对齐 apiproxy composeAgent）：preset 挂载工具集与能力，
  // 不挂载则模型没有任何工具可用，只会空谈而无法执行任务。
  const presets = this.ctx.get('agentPresets');
  let presetId = undefined;
  if (presets && typeof presets.resolve === 'function') {
    try {
      presetId = (await presets.resolve(this.config.agentPreset || undefined)).id;
    } catch (e) {
      this.log.warn(`解析 agent preset 失败（将退化为无工具 agent）: ${e.message}`);
    }
  }
  const composeSetup = async (agentCtx) => {
    if (!presets || presetId === undefined) return;
    await presets.mount(agentCtx, presetId);      // ← 必须 undefined 返回
  };
  return { agents, agentOptions, presetId, composeSetup };
}
```

> 🔴 **`setup` 必须返回 `undefined`**（`BG\lib\core.js:803-804`）：
> 「注意：setup 的返回值会被 agent 工厂调 `.commit()`，必须返回 undefined（不能把 presets.mount 的返回值透传出去）」。
> live 契约 `AgentSetup = (agentCtx, agent) => AgentSetupCommit | Promise<AgentSetupCommit|void> | void`，`AgentSetupCommit = { commit(): void }` —— 传错类型会在运行期炸。

### 4.3 发消息 + 跑一轮回合

```js
// BG\lib\core.js:1127-1130
const userMsg = makeUserMessage(`${timeAnchor}${pendingBrief}${promptText}`);
this._diag?.(`[turn] task=${task.id} followup 前事件数=…, phase=${task.agent.phase?.kind ?? '?'}`);
task.agent.followup(userMsg);
this._diag?.(`[turn] task=${task.id} followup 已提交, inbox pending=${task.agent.inbox?.hasPending ?? '?'}`);
```

**用户消息必须字面构造，不能 import `@deepseek-ai/*`：**

```js
// BG\lib\util.js:198-215
export function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [
      { type: 'text', text: typeof text === 'string' ? text : String(text ?? '') }
    ],
    source: { kind: 'user' }
  };
}
```

> 原因写在 `BG\SPEC.md:20-21`：「插件**不能** import `@deepseek-ai/*` 包（不在模块解析路径上），只能用 `ctx.get(...)` 拿服务、node: 内建与全局。用户消息对象需要按源码形状**字面构造**」。

其它 agent 控制：

```js
// BG\lib\core.js:461-467  —— steer（运行中插话）
if (activeTask.agent && typeof activeTask.agent.steer === 'function') {
  …
  activeTask.agent.steer(makeUserMessage(steerText));
}
// BG\lib\core.js:1146     —— 超时取消
task.agent.cancel('timeout');
// BG\lib\core.js:1899     —— /stop
task.agent.cancel('用户远程停止');
```

### 4.4 等回合结束（`whenIdle` 加固版）

```js
// BG\lib\core.js:968-975
/**
 * whenIdle 安全等待：agent/error 后驱动可能不发 turn/end，whenIdle 永不
 * resolve（2026-09-05 事故：LLM 502 后封卷摘要链挂死 3 小时+）。监听
 * agent/status 的 idle 迁移，变 idle 后再等 graceMs 宽限仍未 resolve 就
 * 强制放行…
 */
awaitIdleSafe(agent, sessionId, graceMs = 10000, hardMs = 30 * 60 * 1000) {
  const idlePromise = agent?.whenIdle ? agent.whenIdle() : Promise.resolve();
  if (!sessionId || typeof this.ctx?.on !== 'function') return idlePromise;
  …
```

调用点：

```js
// BG\lib\core.js:1150-1158
await this.awaitIdleSafe(task.agent, task.sessionId);
…
if (sessions && task.agent.session) {
  await sessions.flush(task.agent.session);
}
```

### 4.5 收流式事件 + 提取最终文本

```js
// BG\lib\core.js:2245-2302（节选）
handleSessionEvent(session, event) {
  if (!session || !event) return;
  const task = this.tasksBySession.get(session.id);   // 高效索引
  if (!task) return;

  if (this.isModelActivityEvent(event)) { task._turnModelActivity = true; }

  if (event.type === 'tool/call' && event.data) {
    const name = event.data.name || '';
    const args = event.data.arguments || {};
    const argsSummary = typeof args === 'object' ? JSON.stringify(args).slice(0, 40) : String(args).slice(0, 40);
    task.currentTool = `${name}(${argsSummary})`;
    task.toolCalls = (task.toolCalls || 0) + 1;
    if (name === 'todo_write' && args.todos && Array.isArray(args.todos)) { … }
  } else if (event.type === 'assistant/message' && event.data?.message?.content) {
    const content = event.data.message.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    } else if (typeof content === 'string') { text = content; }
    task.lastAssistantText = text;
    if (task.status !== 'running' && text) {
      this.deliverOffTurnOutput(task, text).catch((e) => { … });
    }
  }
}
```

读历史事件的兼容层（新版是 `snapshotEvents()`，旧版是 `.events` / `.log`）：

```js
// BG\lib\core.js:1379-1392
sessionEvents(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
    if (Array.isArray(session.events)) return session.events;
    if (Array.isArray(session.log)) return session.log;
  } catch { /* ignore */ }
  return [];
}
```

最终回复提取（**只看本回合窗口**，避免捞到上一轮旧回复）：

```js
// BG\lib\core.js:1426-1449（节选）
extractFinalText(session, startEventsCount = 0) {
  const events = this.sessionEvents(session);
  if (!events.length) return '';
  let text = '';
  const floor = Math.max(0, startEventsCount);
  for (let i = events.length - 1; i >= floor; i--) {
    const ev = events[i];
    if (ev.type === 'assistant/message' && ev.data?.message?.content) {
      const content = ev.data.message.content;
      if (Array.isArray(content)) {
        text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      } else if (typeof content === 'string') { text = content; }
      if (text) break;
    }
  }
  text = text.replace(/<｜｜DSML｜｜[^>]*>[^<]*<\/｜｜DSML｜｜[^>]*>/g, '');
  return text.trim();
}
```

窗口起点在 followup 前记录：

```js
// BG\lib\core.js:1090
const startEventsCount = this.sessionEvents(task.agent?.session).length;
```

### 4.6 钉住会话标题（让本地 GUI 侧边栏可读）

```js
// BG\lib\core.js:784-798（节选）
applySessionTitle(task) {
  try {
    const sessionTitle = this.ctx.get('sessionTitle');
    if (!sessionTitle || typeof sessionTitle.rename !== 'function') return;
    const session = task.agent?.session;
    if (!session) return;
    const desired = this.sessionDisplayName(task);
    const current = typeof sessionTitle.get === 'function' ? sessionTitle.get(session) : undefined;
    if (current?.title === desired && current?.source?.kind === 'user') return; // 已钉住
    sessionTitle.rename(session, desired);
```

### 4.7 agent 作用域的内部错误钩子

```js
// BG\lib\core.js:949-954
try {
  created.agent.ctx?.on?.('agent/error', (payload) => {
    this._diag?.(`[agent/error] session=${task.sessionId} ${JSON.stringify(payload)?.slice(0, 900)}`);
  });
} catch {}
```

> live 提示：`session/event` 是 **scope-filtered**（agent-scoped 监听器只收到经该 agent ctx 进入的会话的事件）。挂在 `agent.ctx` 上监听 `session/event` 比挂在插件 ctx 上更精准。

### 4.8 in-process vs over-HTTP —— 明确结论

| 维度 | 结论 | 证据 |
|---|---|---|
| 传输 | **100% 进程内**，无 HTTP | grep `'/api'`、`authenticatedUrl`、`ctx.get('connection')` 全零命中 |
| 会话创建 | `agents.create` 直调 | `core.js:913` |
| 恢复 | `agents.resume` 直调 | `core.js:894` |
| 发消息 | `agent.followup(msg)` | `core.js:1129` |
| 流式 | `ctx.on('session/event')` | `core.js:106` |
| 落盘 | `sessions.flush(session)` | `core.js:1157` |

---

## 5. 设置与配置

### 5.1 声明：纯 JS `DEFAULTS`，**没有 Cordis Config schema**

```js
// BG\index.mjs:36-146（节选）
/** 默认配置定义 */
const DEFAULTS = {
  settingsPath: '',
  tasksRoot: '',
  statePath: '',
  replyChunkChars: 1800,
  progressIntervalMs: 180000,
  turnStartNotify: true,
  turnTimeoutMs: 0,
  model: {},
  agentPreset: '',
  globalRules: '',
  users: { defaultPersona: 'allround', defaultModel: {provider:'',model:''}, sessionRotateTurns: 64, dataRoot: '' },
  desktopWatch: { … },
  media: { enabled: true, maxBytes: 20971520, … },
  napcat: { … },
  adapters: { onebot11: {…}, qqofficial: {…}, telegram: {…}, feishu: {…}, dingtalk: {…} }
};
```

合并 + 校验（**mount 失败优于静默错配**，`SPEC.md:79`）：

```js
// BG\index.mjs:151-155, 190-204
function validateAndMergeConfig(userConfig) {
  const cfg = deepMerge(DEFAULTS, userConfig || {});
  const ob11 = cfg.adapters?.onebot11;
  if (ob11?.enabled) {
    if (ob11.mode === 'forward-ws' && ob11.url) {
      try { new URL(ob11.url); }
      catch { throw new Error(`[bot-gateway] onebot11.url 非法: "${ob11.url}"`); }
    }
    …
  }
  …
}
```

两层合并顺序（**patch.yml 的 config 是底，settings.json 覆盖**）：

```js
// BG\index.mjs:493
currentConfig = validateAndMergeConfig(deepMerge(deepMerge(DEFAULTS, rawConfig || {}), settingsJson));
```

> **negative finding（live）**：Config 自省显示条目 `include:bot-gateway` 的 schema `status: "absent"`。也就是说 DSH 的「设置」页拿不到这份配置的 schema，插件因此改用「自绘 iframe 面板 + 自己实现的 `/api/settings`」（`webui.js:356-381`）。**如果你想要 DSH 原生的配置表单，必须另外声明 Cordis `Config`（含 `.volatile()` 等字段）——这个插件没有做，也不构成必须。**

### 5.2 落盘：路径模式 + 原子写

```js
// BG\lib\util.js:82-89  —— 所有路径的唯一权威
export function resolveBotGatewayPath(customPath, defaultSubPath) {
  if (customPath) return resolve(customPath);
  const dshHome = getDshHomeDir();
  if (dshHome.endsWith('runtime-data')) { return join(dshHome, defaultSubPath); }
  return join(dshHome, 'bot-gateway', defaultSubPath);
}
```

```js
// BG\lib\settings.js:45-48
constructor(options = {}) {
  this.log = createLogger('settings');
  this.settingsPath = resolveBotGatewayPath(options.settingsPath, 'settings.json');
  this.currentSettings = {};
}
```

```js
// BG\lib\settings.js:78-103（节选）—— 原子 tmp + rename
async save(partial) {
  if (!isPlainObject(partial)) return this.currentSettings;
  const next = deepMerge(this.currentSettings, partial);
  try {
    const dir = dirname(this.settingsPath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.settingsPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmpPath, this.settingsPath);
    this.currentSettings = next;
  } catch (e) { this.log.error(`保存 settings.json 失败:`, e); throw e; }
  return this.currentSettings;
}
```

> ⚠️ 注意顺序注释（`settings.js:81-83`）：**先算新值、落盘成功后才提交内存**。反过来做会出现「保存成功但重启回退」。

### 5.3 `$DSH_HOME` 下的实际产物

| 路径 | 定义处 |
|---|---|
| `$DSH_HOME/bot-gateway/settings.json` | `settings.js:47` |
| `$DSH_HOME/bot-gateway/state.json` | `core.js:195` |
| `$DSH_HOME/bot-gateway/tasks/` | `core.js:194` |
| `$DSH_HOME/bot-gateway/users.json` | `core.js:67` |
| `$DSH_HOME/bot-gateway/users/` | `core.js:68` |
| `$DSH_HOME/bot-gateway/debug.log` | `core.js:116` |
| `$DSH_HOME/bot-gateway/pending-replay.json` | `core.js:1042` / `:2570` |
| `$DSH_HOME/bot-gateway/boot.log` | `index.mjs:316` |
| `$DSH_HOME/bot-gateway/screen-shots/` | `index.mjs:78` |

**boot.log 是给桌面用户的诊断通道**，因为「后端 stderr 对桌面用户不可见」（`index.mjs:312-313`），超过 256KB 自动重写（`index.mjs:327-329`）。移动网关建议照抄。

### 5.4 热生效（reconfigure）

```js
// BG\index.mjs:369-408（节选）
const reconfigure = async (patchSettings) => {
  …
  if (patchSettings) { await settingsStore.save(patchSettings); }
  const settingsJson = settingsStore.getSettings();
  const mergedConfig = validateAndMergeConfig(deepMerge(deepMerge(DEFAULTS, rawConfig || {}), settingsJson));
  currentConfig = mergedConfig;

  if (controller) { await controller.dispose(); controller = null; }
  …
  controller = await mountAdapters(ctx, currentConfig, log, napcatProc);
  log.info('🎉 运行时热生效 (reconfigure) 已成功完成！');
};
```

**模式是「全拆重建」**，不是增量改。webui 侧还要串行化以防两次保存交错（`webui.js:286-289`）。移动网关若要支持「配 token → 立即生效」，同样需要注意保存串行化。

---

## 6. 打包 / 发布清单

### 6.1 一个社区插件要能被 `dsh plugin add` / `install_bundle` 装上，必须有

| # | 要求 | 依据 |
|---|---|---|
| 1 | 标准 npm 包：唯一 `name`、`version` | `package.json:2-3` |
| 2 | `"type": "module"`（入口是 `.mjs` 时） | `package.json:4` |
| 3 | `main` 指向宿主半边入口 | `package.json:6` |
| 4 | `exports["."]` 与 `main` 一致 | `package.json:7-11` |
| 5 | `dsh.compat.minDshVersion` | `package.json:40` |
| 6 | `engines.node` | `package.json:44-46` |
| 7 | **`files[]` 白名单覆盖全部运行时文件** | `package.json:12-20` |
| 8 | 导出 `name` + `apply(ctx, config)` | `index.mjs:34`, `:308` |
| 9 | **零运行时依赖**（或至少零 `@deepseek-ai/*` 依赖） | `SPEC.md:11-12` |

> 🔴 **第 9 条是硬约束。** `BG\SPEC.md:11-12`：「DSH 后端…全局有 `WebSocket`、`fetch`、`TextEncoder/Decoder`、`crypto.randomUUID`、`Buffer`。**无 `ws` npm 包，不允许 npm install** —— 全部协议手写，只用 node: 内建 + 全局。」所以插件自己手写了 RFC6455 WS 服务器（`util.js:272`）、QR 编码器（`lib\qrcode.js`）、protobuf（`lib\pb.js`）。**移动网关同理：不要引入 `ws`、`ws-rx-stream`、`undici` 之类的依赖。**

### 6.2 `peerDependencies` —— 这是安装成败的分水岭

本机 `PATCH:8-13` 记录了一次真实事故：

```yaml
# PATCH:8-13
# 2026-10-12 变更史：
#   · 曾装 dsh-bot-gateway（宿主插件）→ 卸载 → 改装 deepseek-harness-weixin
#   · weixin 因依赖 dsh-credentials-local@0.1.0-rc.7，与宿主 0.2.0-rc.2
#     跨大代不兼容，导入失败导致启动中止 → 已卸载
#   · 重新装回 dsh-bot-gateway：它**无 peer 约束**，
#     testedDshVersion=0.2.1-alpha.1，不存在代差问题
```

**结论：不要声明 `peerDependencies` 指向 `@deepseek-ai/*`。** 跨大代 peer 约束会让组合导入失败、**整个 DSH 启动中止**（不是插件降级）。要约束版本就用 `dsh.compat`（纯元数据，不参与解析）。

### 6.3 `not-bundle` 情况：dsh-bot-gateway 就是这个 case

live: `list_bundles`（total 24）里**没有** `dsh-bot-gateway`；live: `list_plugins` 里它的条目是 `include:bot-gateway`，`patchId: "bot-gateway"`。也就是说——

> **dsh-bot-gateway 不是 bundle，它是一条手写在 `cordis.patch.yml` 里的裸行。** 它不经过 `plugin_manager` 的 install/removable 生命周期，`list_bundles` 看不到它，只能靠机器级 patch 行存在。

这带来三个实际约束（对移动网关同样适用）：

1. **不会出现在插件管理器的可视化列表里。** 用户没法用 GUI 装/卸它。
2. **`profiles/` 隔离会丢它。** 所以必须写机器级 `cordis.patch.yml`（§1.2）。
3. **升级 = 装新包 + 重启 DSH。** `BG\README.md:30-31`：「版本升级：发布新版 → `dsh plugin --profile <name> add dsh-bot-gateway@<新版本>` → 重启 DSH。改源码 = 改仓库发布新版（npm 标准流），**不再有 junction / `?v=` 热重载**」。

**如果要做成正规 bundle**（live: `list_bundles` 的 `rows` 形状）：

```json
{ "name": "dsh-native-mobile", "version": "0.1.0",
  "description": "…", "optional": false,
  "rows": [ { "rowId": "native-mobile",
              "moduleName": "dsh-native-mobile",
              "entryId": "include:native-mobile" } ],
  "overrides": [] }
```

`overrides` 用于**复用组合里已有行**（官方 bundle 大量这么干，如 `dsh-web-app` 的 `overrides: ["system-prompt","session-query-sqlite","tools",…]`）。社区插件的 `overrides` 都是 `[]`（live 实测）。

### 6.4 安装命令（`BG\README.md:5-31`）

```bash
# 方式 A（官方 channels，推荐）
dsh plugin --profile <profile名> add dsh-bot-gateway

# 方式 B（本地 tgz，发布前验证）
dsh plugin --profile <profile名> add ./dsh-bot-gateway-<版本>.tgz

# 方式 C（手工，任意 DSH 版本）
npm i dsh-bot-gateway        # 在 <dsh-home> 或 profiles/<name> 下执行
```

然后机器级 patch 加裸包名行，重启 DSH。

---

## 7. 做「已鉴权的移动网关」的硬约束与阻塞项

### 7.1 本机现状（可能已经解决了一半问题）

live: `list_bundles` 里**已经装了** `@linxin666/dsh-remote-web-ui@0.4.6`（`rows:[{rowId:"remote-web-ui", moduleName:"@linxin666/dsh-remote-web-ui"}]`），其描述自述为：

> Scan-to-pair remote access for the dsh web GUI that shares one official interface: a QR beside the settings button pairs phones and PCs into the same Web GUI … through one-time tokens and revocable device sessions, with a LAN bind toggle, optional Cloudflare tunnel…

profile 级 `cordis.patch.yml` 里它被开了 LAN 绑定，并把 webserver 改成对外监听：

```yaml
- id: remote-web-ui
  name: "@linxin666/dsh-remote-web-ui"
  config:
    lanBind: true

# --- remote-web-ui lan-bind block (managed - do not edit) ---
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '0.0.0.0'
    port: 19387
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

`C:\Users\me\.dsh\mobile-access\` 则是这个插件的遗留状态（`components/cpolar/3.3.18/cpolar.exe`、`tls/{ca.pem,ca-key.pem,server-cert.pem,server-key.pem,dsh-mobile-ca.cer}`、`setup.json`、`installation-id`、`remote/`、`staging/`、`logs/dsh-mobile.log`）。

> **决策提示**：在做原生移动网关之前，先确认 `@linxin666/dsh-remote-web-ui` 是否已满足需求。它已经把「扫码配对 + 一次性 token + 可撤销设备会话 + LAN 绑定 + 隧道」全套做完了，而且是走 DSH 官方 Web GUI（共享同一界面）。原生插件的价值应该定位在**它做不到的部分**（例如 IM 式推送、非 GUI 的结构化 API、原生 App）。

### 7.2 硬阻塞（按严重度）

| # | 阻塞 | 详情 | 绕法 |
|---|---|---|---|
| **B1** | **`webServer` 只接受 `127.0.0.1` 和 `0.0.0.0`，且不提供 TLS / 认证 / 来源策略** | `dsh-host-webserver` README.zh.md:7「`host` 只接受 `127.0.0.1`（默认值）和 `0.0.0.0`（有意向网络开放）」；:21「**不提供 TLS、认证或来源策略**：绑定非回环地址会向对应网络公开服务器」 | 自建 TLS 终结（cpolar / Cloudflare Tunnel / 自签 CA），或在 handler 内做 token 校验 |
| **B2** | **`/api` 只是可达性策略，不是认证** | `.probe\sdk\...\dsh-client-connection...\README.zh.md:9`：「这道栅栏是**可达性策略，而不是认证**；Web 载体**不提供认证层**」 | 移动网关不要复用 `/api`；自己在 `webServer.register` 的 handler 里做 token/配对 |
| **B3** | **Bot Gateway 的三层校验（loopback/Host/CSRF）在 `0.0.0.0:19387` 下会全量拒绝** | `webui.js:85-100` 要求 remoteAddress 是 loopback、Host 主机名在 `127.0.0.1/localhost/::1/0.0.0.0` 内 | **不能照抄**；必须改成「token + Host 白名单 + trustedHosts」 |
| **B4** | **`webServer.registerUpgrade` 只做精确 pathname 匹配，未命中直接关连接；重复 path 会 throw** | live `webServer` 契约 | 选一个绝不与 `/api/events.mux`、`/api/events.host`、`/hmr` 等冲突的路径 |
| **B5** | **插件无法 import `@deepseek-ai/*`** | `SPEC.md:20` | 所有 DSH 能力走 `ctx.get(...)` |
| **B6** | **不允许 `npm install`；无 `ws` 包** | `SPEC.md:11-12` | 手写协议，或用全局 `WebSocket`（仅客户端）/ `node:http` + `registerUpgrade` |
| **B7** | **`agents.create` 在 session 残留时会抛 "already exists"** | `core.js:926-944` | 复制插件的自愈逻辑：catch → 换新 `sessionId` 重试 |
| **B8** | **profile 级 patch 会在 DSH Desktop 启动失败时被隔离丢弃** | `PATCH:3-6` | 写机器级 `cordis.patch.yml` |
| **B9** | **`session/event` 是 post-commit fire-and-forget，监听器抛错被吞** | live 事件契约 | 不要在监听器里做重逻辑；耗时的用 `ctx.effect` / 后台任务 |
| **B10** | **`whenIdle` 可能永不 resolve（LLM 502 后）** | `core.js:968-973`（2026-09-05 事故：挂死 3 小时+） | 复制 `awaitIdleSafe`：监听 `agent/status` 的 idle + graceMs 宽限 + 硬超时 |
| **B11** | **`peerDependencies` 指向 `@deepseek-ai/*` 会导致整个 DSH 启动中止** | `PATCH:9-11` | 一律不声明 peer 依赖；只用 `dsh.compat` 元数据 |
| **B12** | **改 `.mjs` 不热重载** | `SPEC.md:22-23`；`README.md:30-31` | 开发期靠改 patch.yml 的 config 触发该插件重载；发布走新版本包 |

### 7.3 推荐的移动网关骨架（综合以上所有接缝）

```js
// index.mjs  —— 宿主半边，纯 in-process 驱动 + webServer 承载
export const name = 'native-mobile';

export function apply(ctx, rawConfig) {
  const log = createLogger('native-mobile');

  // 1) 路由：必须 inject 等异步就绪的 webServer，且必须在 ctx.effect 里注册
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.get('webServer');
      if (!webServer?.register) return;

      webCtx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/mobile',                    // 别和 /api、/plugins 撞
        handler: async (req, res) => { /* 自写鉴权 + SSE/WS 升级 */ },
      }), 'native-mobile: http route');

      // WS 承载：用宿主接缝，不要抄 bot-gateway 的私有 WS server
      webCtx.effect(() => webServer.registerUpgrade({
        path: '/mobile/ws',                 // 精确匹配，勿与 /api/events.* 冲突
        handler: (req, socket, head) => { /* 握手期校验 token → send/close */ },
      }), 'native-mobile: ws route');
    });
  }

  // 2) 一切清理都进 ctx.effect
  ctx.effect(() => async () => { /* dispose agents / 关 timers / 反注册 */ },
             'native-mobile: disposer');
}
```

- 会话：`agents.get` → `sessionPersistence.list` → `agents.resume` → `agents.create`（`core.js:877-945`）
- 发送：`makeUserMessage(text)` → `agent.followup(msg)`（`util.js:203`, `core.js:1129`）
- 等待：`awaitIdleSafe(agent, sessionId)` → `sessions.flush(agent.session)`（`core.js:1150-1157`）
- 流式：`ctx.on('session/event', (session, event) => …)` + `session.snapshotEvents()` 回溯（`core.js:106`, `:1384`）
- 落盘：`resolveBotGatewayPath(customPath, 'x.json')` + tmp+rename（`util.js:82`, `settings.js:90`）
- 诊断：`$DSH_HOME/native-mobile/boot.log`（`index.mjs:316`）

---

## 附录 A：本机核对清单（可复现）

```powershell
# 插件包
Get-ChildItem -Recurse "C:\Users\me\.dsh\node_modules\dsh-bot-gateway\"

# 机器级 patch（19 行，含注释史）
Get-Content "C:\Users\me\.dsh\cordis.patch.yml" -Encoding UTF8

# profile 级 patch（含 webserver 0.0.0.0:19387 的 lan-bind 托管块）
Get-Content "C:\Users\me\.dsh\profiles\desktop\cordis.patch.yml" -Encoding UTF8

# 遗留移动状态（目录清单即可，勿读密钥）
Get-ChildItem -Recurse "C:\Users\me\.dsh\mobile-access\"

# 官方包 README（/api 信任栅栏、webserver 契约）
#   .probe\sdk\_deepseek-ai_dsh-client-connection-0.0.1-rc.1\package\README.zh.md
#   .probe\sdk\_deepseek-ai_dsh-host-webserver-0.0.1-rc.1\package\README.zh.md
```

> 注：任务里给的路径是 `...dsh-client-connection-0.2.0-rc.2`，本机实际只有 **`0.0.1-rc.1`** 版本（`.probe\sdk\` 下无 0.2.0-rc.2）。已按实际路径取证。
> 另：DSH 实现 checkout 路径 `C:\Users\me\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\` 在本机**不存在**（`resources\` 下只有 `app.asar` / `app.asar.unpacked` / `runtime`），因此本文中所有宿主契约均改用**运行时 `cordis_inspect` 自省**取证，而非读源码。

## 附录 B：本文引用的 live 自省调用

| 目的 | 调用 |
|---|---|
| 全服务目录 | `cordis_inspect_query(platform=host, provider=Service, method=listService)` |
| webServer 契约 | `…method=listService, input={service:"webServer"}` |
| agents 契约 | `…input={service:"agents"}` |
| agentLoop 契约 | `…input={service:"agentLoop"}` |
| session/event 契约 | `cordis_inspect_query(platform=host, provider=Event, method=listEvents, input={event:"session/event"})` |
| bot-gateway 的 Config 状态 | `cordis_inspect_query(platform=host, provider=Config, method=listConfigs, input={name:"dsh-bot-gateway"})` → `status:"absent"` |
| Loader 条目 / bundle 清单 | `plugin_manager(action=list_plugins)` / `plugin_manager(action=list_bundles)` |
