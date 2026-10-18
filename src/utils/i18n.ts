/**
 * 多语言与文案本地化辅助函数。
 *
 * ## 为什么必须有这一层防护
 *
 * 真主机下发的事件文案字段（例如审批原因 `displayReason`、提问说明、模型描述等）
 * 可能是多语言对象 `{ zh, en }`，也可能是纯字符串。
 *
 * 若直接使用 `String(x)` 或拼接，会退化为字面量 `"[object Object]"`，导致关键提示信息乱码。
 * 本函数保证始终提取人类可读的字符串，并在缺失时优雅回退为空串，绝不抛出异常或输出 `[object Object]`。
 */
export function localizedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const zh = record.zh;
    const en = record.en;
    if (typeof zh === 'string' && zh.trim()) return zh.trim();
    if (typeof en === 'string' && en.trim()) return en.trim();
    // 其它语言的兜底：取第一个非空字符串值
    for (const candidate of Object.values(record)) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return '';
}
