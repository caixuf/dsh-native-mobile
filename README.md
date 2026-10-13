# DSH 移动端遥控应用 (React Web Client)

给 [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/) 打造的**原生体验移动端 Web 遥控应用**，提供手机端发起、电脑端执行的完整遥控伴侣体验。

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
```