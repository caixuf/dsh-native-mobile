/**
 * 演示模式开关。
 *
 * ## 为什么这是一个独立模块
 *
 * 这个开关被**三处**需要：`connection.ts`（决定是否走模拟连接）、
 * `store.ts`（决定是否注入假主机）、`pairing.ts`（决定是否伪造凭据）。
 *
 * 放在 `connection.ts` 里会让 `store` / `pairing` 反向依赖「连接」这个语义，
 * 那是错的耦合 —— 它们要的只是一个**构建期配置**。
 *
 * ## 为什么必须显式
 *
 * 2026-10-14 修正前，这三处都是靠**字符串猜测**：
 *
 * ```ts
 * if (baseUrl.includes('demo') || token.includes('demo')) { /* 走模拟 *\/ }
 * if (username === 'demo') { /* 伪造 token *\/ }
 * if (code === '123456') { /* 伪造配对 *\/ }
 * ```
 *
 * 它们共同造成一类最难查的 bug：**假成功**。
 * 界面一切正常（有会话、有消息、显示"配对成功"），
 * 但实际上**从未与真实电脑通信**，也没有任何鉴权发生。
 *
 * 更糟的是 `store.ts` 会在**全新安装**时主动写入一台假的
 * 「MacBook Pro (Demo 实例)」，于是**默认开局就是假的**。
 *
 * 现在默认关闭：连不上就**如实报错**。
 * 需要做 UI 开发时，显式设 `VITE_DEMO_MODE=true` 再启动。
 */
export const DEMO_MODE = (() => {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return env?.VITE_DEMO_MODE === 'true';
  } catch {
    // 非 Vite 环境（如 Node 测试脚本）导入本模块时不应崩
    return false;
  }
})();