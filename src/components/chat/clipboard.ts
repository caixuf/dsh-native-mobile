/**
 * 剪贴板工具（零依赖，可在 Node 里 import —— 只在实际调用时探测 DOM）。
 *
 * 为什么不直接用 `navigator.clipboard`：
 *  - 非安全上下文（http://192.168.x.x 调试、Android WebView 老版本）里
 *    `navigator.clipboard` 可能是 undefined，直接调用会抛 TypeError；
 *  - 权限被拒时 Promise 会 reject —— 两者都不能让"复制"把界面搞崩。
 *
 * 因此：优先 async clipboard → 回退 `document.execCommand('copy')` → 都不可用就
 * 如实返回 false（调用方显示"复制失败"，而不是假装成功）。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string') return false;

  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // 非安全上下文 / 权限被拒 —— 落回 execCommand
  }

  try {
    if (typeof document === 'undefined' || !document.body) return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand('copy');
    document.body.removeChild(area);
    return done;
  } catch {
    return false;
  }
}