# DSH 移动端遥控应用 (React Web Client)

给 [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/) 打造的**原生体验移动端 Web 遥控应用**，提供手机端发起、电脑端执行的完整遥控伴侣体验。

## 下载安装

| 版本 | APK | 说明 |
|---|---|---|
| **v1.0.7**（最新） | [dsh-mobile-v1.0.7.apk](https://github.com/caixuf/dsh-native-mobile/releases/download/v1.0.7/dsh-mobile-v1.0.7.apk) | 顶栏会话统计 + 双层输入坞；构建可复现 |

全部版本见 [Releases](https://github.com/caixuf/dsh-native-mobile/releases)。APK 用 debug 密钥签名（可直接覆盖安装，**不适合上架分发**）；`minSdk 26（Android 8.0）`。

## 架构与核心功能

手机端与 DSH 移动网关通过双向协议实时交互：

1. **电脑设备管理 (HostsScreen)**
   - 多台远程工作电脑管理、在线状态检测与平滑切换
   - 本地持久化凭据管理（安全保存主机地址与设备令牌）

2. **配对与登录 (PairScreen)**
   - **账号密码登录**：直接向网关验证并签发设备令牌
   - **一次性配对码**：支持 6 位 PIN 码或完整配对码绑定，支持二维码 URL 解析
   - **内置 Demo 模拟模式**：即刻上手体验远程遥控交互

3. **会话管理 (SessionsScreen)**
   - 浏览工作电脑上的所有会话记录
   - 过滤与折叠子代理会话（`origin === "subagent"`），杜绝 durable parent 误伤
   - 会话搜索与按需新建会话（可自定义工作区目录 CWD）

4. **远程遥控与终端工具流 (ChatScreen)**
   - **桌面执行上下文条**：实时查看目标电脑主机名、绿色在线呼吸灯、工作区路径及运行状态
   - **任务步骤规划卡片 (TaskProgressCard)**：自动解析 `- [x]` / `- [ ]` 步骤清单与工具调用链
   - **工具调用卡片 (DisclosureToolCard)**：紫色语义色 (`#a78bfa`)，支持终端命令与文件读写参数折叠/展开
   - **随身语音遥控 (VoiceRecordingOverlay)**：支持语音输入指令遥控电脑
   - **人机协同审批与提问**：工具安全审批（`allowed-once` / `rejected`）与选项式问答

5. **后台审批中继（核心能力，Android 原生前台服务）**
   - **锁屏/切后台也能收到审批**：原生前台服务持有 WebSocket，不受 WebView 被挂起影响
   - **通知栏直接作答**：通知自带「允许一次 / 拒绝」按钮（提问则是选项按钮），
     点一下即回执电脑，**不需要先解锁、打开 App、等 WebView 启动**
   - **令牌走 `Authorization` 头**，不进 URL（网页端受浏览器规范限制只能用查询参数）
   - **已应答账本落盘**：重启后不会重复弹已处理过的审批
   - **令牌失效不无限重试**：401/403 立即停止并提示重新配对

## 技术栈

- React 19 + TypeScript
- Vite 6 + Tailwind CSS v4
- Lucide React 图标体系
- DSH Mux WebSocket 与 Remote RPC 桥接协议

## 启动与构建

```bash
# 开发环境启动 (端口 3000)
npm run dev

# 生产环境构建
npm run build

# 桌面壳（Electron）：关窗不退出，常驻托盘接收审批
npm run electron

# Android APK（WebView 壳 + 原生审批中继）
npm run build:apk      # 产物：dist-apk/dsh-mobile-v<版本>.apk
```

## 测试与验证

```bash
node --run test          # 客户端 394 条（markdown / 增量流式 / 审批契约 / 会话翻页 / 会话统计 /
                         #   二维码解码 / 会话分组折叠归档 / 发送队列与草稿 / 连接策略 / 桌面通知降级）
node --run test:gateway  # 网关 96 条（e2e 85 + 存储往返 11）
node --run test:android  # Android 原生 94 条（审批契约 / JSON / 帧解码 / 分类与账本）
node --run verify        # 以上全部 + tsc + vite build（合计 584 条断言）
```

`node --run` 不依赖 npm/pnpm 在 PATH 上。CI 或手动验收直接跑 `verify` 即可。

### 整 app 端到端（CDP 驱动，不靠截图比对）

debug 构建开了 WebView 远程调试，于是可以**精确驱动 SPA 的 DOM** 而不是猜坐标
（WebView 的 DOM 不对 `uiautomator` 暴露，dump 出来是空树）：

```bash
adb shell pidof io.github.dshmobile.app
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
node scripts/e2e-app-ui.mjs     # 配对 → 分组会话列表 → 打开会话 → 历史非空 → 发送 → 收到回复
```

### 审批链路端到端验证（两层，缺一不可）

**第一层 · 真主机**（证明真网关认这条连接）：把手机直接指向真网关，走真配对拿真令牌。

```bash
node scripts/pair-and-point-android.mjs          # 铸码 → 真配对 → adb reverse → 启动 App
adb logcat -s DshRelay                            # 应出现 ready 带回的**真 clientId**
node scripts/pair-and-point-android.mjs --revoke-device <deviceId>   # 验完吊销令牌
```

**第二层 · 假主机**（证明触发可控 + 回执形状逐字正确）：真主机不会因为你想测就发一条审批出来。

```bash
node packages/dsh-mobile-gateway/scripts/fake-host.mjs &   # 监听 19400
adb reverse tcp:19400 tcp:19400
adb shell am force-stop io.github.dshmobile.app
adb shell am start -n io.github.dshmobile.app/.MainActivity \
  --es dsh_relay_base_url http://127.0.0.1:19400 --es dsh_relay_token e2e-token-1
adb logcat -s DshRelay
```

假主机**逐字校验**回执形状：`method=$events/result`、`args={clientId,eventId,outcome}`、
`value` 必须是词表内的裸字符串 —— 词表外的值会被真实主机**静默当成拒绝**，
这是本项目最贵的一类 bug，所以校验写得比"收到请求"严格得多。

> `--es` 预置凭据与假主机都**只在 debug 构建生效**（release 忽略 extra），
> 否则任何应用都能改写中继目标。
>
> Android 13+ 需要 `POST_NOTIFICATIONS` 权限。没授权时通知**不报错、直接不显示** ——
> App 顶部会明确提示，`adb logcat -s DshRelay` 也会打印 `通知是否可用=false`。