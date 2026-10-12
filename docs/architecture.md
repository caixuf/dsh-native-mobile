# 设计取舍

记录几个当时真正影响形态的决定，以及被否掉的方案——免得后来的人重复推演。

## 1. 协议透明桥 vs. 自造移动 API

**决定：透明桥。** `ctx.connection.createSharedFetchHandler('/api')` 拿到的是
`ConnectionFetchHandler { fetch(request: Request): Promise<Response> }`，
于是网关可以把 `/api` 原样转发给手机，envelope 一个字节不改。

**否掉的：自己定义一套 `mobile.session.list` / `mobile.events.subscribe`。**
网关侧改用宿主服务直连（`agents.create/resume`、`agent.followup()`、`ctx.on('session/event')`）来造语义，
App 侧就只面对一套小而稳的负载。

否掉的理由不是工作量，是**正确性**：DSH 的会话投影、事件负载本来就是插件可扩展的
（`SessionEvent.data` 在官方 schema 里就是 `unknown()`，设计如此）。自造一层意味着
gateway 要自己把 DSH 的内部模型翻译一遍——这份翻译代码会随每个上游版本腐坏，
而且官方新增能力时我们永远滞后。透明桥则是**协议永远正确**，代价是 App 要多写一点
envelope 解析（`docs/protocol.md`）。

真实收益：官方 `host.describe` 一行代码就同时充当了握手与版本探测。

## 2. 进程内调用 vs. 反代到回环

**决定：进程内。** 直接用 `createSharedFetchHandler` 与 `typertGateway.wireStream.open()`。

反代 `http://127.0.0.1:19387/api/...` 看着更简单，但会撞上 DSH Desktop 额外那层
**浏览器认证 cookie**——它与 authority 绑定（为浏览器访问过的确切 `host:port` 签发），
没有任何回环豁免。于是反代要么拿不到凭据，要么得自己实现一次启动令牌兑换。
进程内调用完全绕开这一层，也不受绑���地址影响。

## 3. 特权方法：不能只依赖官方栅栏

这一条最容易踩。官方的做法是把特权方法用**空信任表**过栅栏，让它们表现为「仅回环」。
我们的桥构造的请求永远是 `http://127.0.0.1/api/…`，在栅栏眼里就是回环——
**于是那张名单自动失效**。

照抄官方的直觉实现，等于给每台配对手机发了一份凭据面与配置面。
所以必须自己复刻名单并在转发前拦截。测试里专门断言「拒绝时没有触达宿主」，
因为只回 403 但仍调用下去是最容易写出来的假安全。

## 4. 轮询 vs. 订阅流

**决定：v0.1 用 `session.history` 轮询（1.6s）。**

官方把 `session/follow` 定义成 `RemoteStreamHandle`：客户端用稳定 rpcId 发起，
主机经下行流以 `server-request` 帧逐帧回推，客户端逐帧回 `client-response`。
但这条链路的**帧形状在已公开的官方包里没有可验证的定义**——
`docs/api-contract.md` 的 Gaps 一节把它列为未验证项之一。

在这种情况下，猜一个可能错的帧格式换来的「实时」，代价是：错了还不报错，只是**静默不更新**。
轮询必然可用、可观测、零猜测。等流协议被验证（对着真实网关跑一次就能确认）再切换。

## 5. 不做隧道与 TLS

`dsh-mobile` 已经把 Tailscale Funnel / cpolar / cloudflared / FRP / 自建反代五种通道做完了，
还有独立 HTTPS、Keystore 里的 CA 固定、诊断页。做一遍是纯粹的重复劳动。

本项目假定你已经有一条能到达电脑的路径（局域网直连也算），把地址填进 App 即可。
代价是首次使用门槛高一点——这是明确的取舍，不是遗漏。

## 6. 为什么 gateway 不声明 `dsh.client`

声明了 `dsh.client` 才会产生浏览器半边，带来 `client.js`、peer 依赖、`@deepseek-ai/cordis` 版本约束。
本项目不送界面，因此完全不需要。

这条还有一层历史教训：机器级 patch 的注释里记着一次真实事故——
`deepseek-harness-weixin` 因为 peer 依赖 `dsh-credentials-local@0.1.0-rc.7` 与宿主 `0.2.0-rc.2`
跨代不兼容，**导致整个 DSH 启动中止**。`dsh-bot-gateway` 能活下来正因为它无 peer 约束，
版本信息只放在 `dsh.compat` 元数据里。本项目照抄这一纪律：`package.json` 里没有任何 `peerDependencies`。

## 7. host 插件不是 bundle

`install_bundle` 会返回 `application: "failed"` / `error.code: "not-bundle"`。
**这不是失败**，是形态差异：bundle 有 `dsh.bundle.patch`，host 插件没有。
真正的判据是 `packageResult.exitCode` 与 pnpm 输出。

同理，裸包名的解析基准是 `<dsh-home>\node_modules`，而不是 profile 的——
`plugin_manager` 只往 `profiles\desktop\node_modules` 装，所以 `scripts/install-gateway.ps1`
自己把包落到正确的位置。

## 8. 注册必须写机器级 patch

`<dsh-home>\cordis.patch.yml` 与 `<dsh-home>\profiles\desktop\cordis.patch.yml` **并存、不合并**。
必须用前者：DSH Desktop 启动失败时会把整个 `profiles/` 隔离成 `profiles.broken-<时间戳>` 并重建，
profile 级补丁会随之丢失。

顶层必须是**单一** YAML 数组，且 `insert` 只应出现一次——安装脚本因此要先把重复的
`- insert:` 合并再校验（见 `scripts/fix-patch.mjs` 的做法）。

## 9. 重启纪律

安装脚本**只写文件，不重启 DSH**。原因不在脚本里，在 DSH：设置写入走
`revision` 乐观锁，运行时用外部工具改 `cordis.patch.yml` 会让磁盘 revision 偏离内存值，
此后任何设置保存都被拒（表现是欢迎向导弹「暂时无法保存确认状态」）。

改完必须重启 DSH 重新读盘对齐。这是已知的、有意接受的摩擦。