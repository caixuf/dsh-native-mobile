/**
 * 生产级 Markdown 解析器（Web 版）。
 *
 * 与 Android 端 `render/Markdown.kt` **同构**：同一套节点类型、同一套降级规则，
 * 保证「同一段模型输出，两个端渲染结果一致」。
 *
 * ## 为什么自己写，不引第三方库
 *
 * 场景是**流式增量渲染**：模型输出一边来 UI 一边显示，每次只多几个 token。
 * 第三方 markdown 库（marked / markdown-it）假设「输入是完整文档」，
 * 流式半截语法会渲染成「先错后对」的闪烁排版 —— 比不渲染更糟。
 *
 * 所以这里的唯一铁律：
 *
 *   **找不到闭合标记，就当普通字符显示。**
 *
 * 随着 token 补齐，渲染只会「从纯文本变成正确排版」，不会出现闪烁。
 *
 * ## 支持的语法
 *
 * | 语法 | 处理 |
 * |---|---|
 * | ` ```lang ` 围栏 | 代码块，等宽 + 深色底 + 语法高亮，不解析内部 |
 * | `**粗**` `__粗__` | 粗体 |
 * | `*斜*` `_斜_` | 斜体（CommonMark：词内下划线不触发） |
 * | `` `行内代码` `` | 等宽 + 微底色 |
 * | `~~删除线~~` | 删除线 |
 * | `- ` `* ` `1. ` | 无序/有序列表，缩进最多 3 级 |
 * | `- [ ]` `- [x]` | 任务列表（勾选态） |
 * | `> ` | 引用块 |
 * | `> [!NOTE]` 等 | GitHub Callout 五种类型 |
 * | `# ` `## ` `### ` | 标题（更深的当正文） |
 * | `---` `***` `___` | 分隔线 |
 * | `\| a \| b \|` | 表格（需下一行是 `\|---\|` 分隔行） |
 * | `[文字](链接)` | 链接（可点击，新窗口打开） |
 * | `![alt](url)` | 图片占位卡（默认不加载远程图） |
 * | `\` 转义 | `\*` `\_` `` \` `` `\[` `\]` `\~` 输出字面字符 |
 */

// ── 节点类型 ────────────────────────────────────────────────────────────────

export type Align = 'left' | 'center' | 'right';

export interface MdStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
}

export interface MdText {
  type: 'text';
  value: string;
  style: MdStyle;
}

export interface MdParagraph {
  type: 'paragraph';
  children: MdInline[];
}

export interface MdHeading {
  type: 'heading';
  level: number;
  children: MdInline[];
}

export interface MdCodeBlock {
  type: 'code';
  lang: string | null;
  code: string;
}

/** 列表块：`items` 与 `indents` 平行数组，index 对齐。 */
export interface MdListBlock {
  type: 'list';
  ordered: boolean;
  startNumber: number;
  items: MdInline[][];
  indents: number[];
}

export interface MdQuote {
  type: 'quote';
  children: MdInline[];
}

export interface MdTaskItem {
  type: 'task';
  checked: boolean;
  children: MdInline[];
}

export interface MdDivider {
  type: 'divider';
}

export interface MdTable {
  type: 'table';
  header: MdInline[][];
  rows: MdInline[][][];
  aligns: Align[];
}

export interface MdImage {
  type: 'image';
  alt: string;
  url: string;
}

export type CalloutType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export interface MdCallout {
  type: 'callout';
  callout: CalloutType;
  title: string | null;
  children: MdInline[];
}

export type MdInline = MdText | MdImage;
export type MdBlock =
  | MdParagraph
  | MdHeading
  | MdCodeBlock
  | MdListBlock
  | MdQuote
  | MdTaskItem
  | MdDivider
  | MdTable
  | MdCallout;

export const CALLOUT_META: Record<CalloutType, { label: string; icon: string; color: string }> = {
  NOTE: { label: '说明', icon: 'info', color: '#2563eb' },
  TIP: { label: '提示', icon: 'lightbulb', color: '#059669' },
  IMPORTANT: { label: '重要', icon: 'bookmark', color: '#7c3aed' },
  WARNING: { label: '注意', icon: 'alert-triangle', color: '#d97706' },
  CAUTION: { label: '危险', icon: 'shield-alert', color: '#dc2626' },
};

// ── 解析器 ──────────────────────────────────────────────────────────────────

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIVIDER_RE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const TABLE_SEP_RE = /^\|?[\s:|-]+\|[\s:|-]*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const UNORDERED_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

export function parseMarkdown(source: string): MdBlock[] {
  try {
    return parseUnsafe(source);
  } catch {
    // 渲染路径上抛异常等于整个界面崩掉，这是不可接受的降级。
    return [{ type: 'paragraph', children: [{ type: 'text', value: source, style: {} }] }];
  }
}

function parseUnsafe(src: string): MdBlock[] {
  const lines = src.split('\n');
  const out: MdBlock[] = [];

  const para: MdInline[] = [];
  let listOrdered = false;
  let listStart = 1;
  let listItems: MdInline[][] = [];
  let listIndents: number[] = [];
  let quoteLines: string[] = [];

  const flushPara = () => {
    if (para.length > 0) {
      out.push({ type: 'paragraph', children: [...para] });
      para.length = 0;
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      out.push({
        type: 'list',
        ordered: listOrdered,
        startNumber: listStart,
        items: listItems,
        indents: listIndents,
      });
      listItems = [];
      listIndents = [];
      listStart = 1;
    }
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;

    const first = quoteLines[0].trim();
    const callout = CALLOUT_RE.exec(first);
    if (callout) {
      const kind = callout[1].toUpperCase() as CalloutType;
      const titleSuffix = callout[2]?.trim() || null;
      const bodyLines = quoteLines.slice(1);
      const children: MdInline[] = [];

      if (bodyLines.length === 0 && titleSuffix) {
        children.push(...inlineParse(titleSuffix));
      } else {
        bodyLines.forEach((line, idx) => {
          if (idx > 0) children.push({ type: 'text', value: '\n', style: {} });
          children.push(...inlineParse(line));
        });
      }

      out.push({ type: 'callout', callout: kind, title: titleSuffix, children });
    } else {
      const children: MdInline[] = [];
      quoteLines.forEach((line, idx) => {
        if (idx > 0) children.push({ type: 'text', value: '\n', style: {} });
        children.push(...inlineParse(line));
      });
      out.push({ type: 'quote', children });
    }
    quoteLines = [];
  };

  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── 代码块围栏 ──
    const fence = line.trimStart();
    if (fence.startsWith('```')) {
      flushAll();
      const lang = fence.slice(3).trim() || null;
      const buf: string[] = [];
      i += 1;
      // 流式常见「只有开围栏没有闭围栏」，照样渲染成代码块。
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏（没有也无所谓）
      out.push({ type: 'code', lang, code: buf.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      i += 1;
      continue;
    }

    // ── 标题 ──
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      out.push({
        type: 'heading',
        level: Math.min(heading[1].length, 3),
        children: inlineParse(heading[2]),
      });
      i += 1;
      continue;
    }

    // ── 分隔线（必须先于列表判断，否则 `- - -` 会被当成列表项）──
    if (DIVIDER_RE.test(line)) {
      flushAll();
      out.push({ type: 'divider' });
      i += 1;
      continue;
    }

    // ── 表格：`|a|b|` + 下一行必须是 `|---|---|` ──
    // 要求「下一行是分隔行」是必须的，否则正文里的竖线会被误判成表格。
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1].trim()) &&
      lines[i + 1].includes('-')
    ) {
      flushAll();
      const header = splitRow(line).map(inlineParse);
      const aligns = parseAligns(lines[i + 1]);
      i += 2;

      const rows: MdInline[][][] = [];
      while (i < lines.length) {
        const row = lines[i];
        if (!row.includes('|') || row.trim() === '') break;
        const cells = splitRow(row);
        // 列数不一致时按表头补齐/截断，避免渲染错位。
        const padded = [...cells, ...Array(Math.max(0, header.length - cells.length)).fill('')];
        rows.push(padded.slice(0, header.length).map(inlineParse));
        i += 1;
      }

      out.push({ type: 'table', header, rows, aligns });
      continue;
    }

    // ── 引用 / Callout ──
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushPara();
      flushList();
      quoteLines.push(quote[1]);
      i += 1;
      continue;
    }

    // ── 列表（含任务列表）──
    const unordered = UNORDERED_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (unordered || ordered) {
      flushPara();
      flushQuote();

      const isOrdered = ordered !== null;
      const indentSpaces = ordered ? ordered[1].length : unordered![1].length;
      const indentLevel = Math.min(Math.floor(indentSpaces / 2), 3);
      const body = ordered ? ordered[3] : unordered![2];
      const itemNum = ordered ? Number.parseInt(ordered[2], 10) || 1 : 1;

      const task = TASK_RE.exec(body);
      if (task) {
        listOrdered = false;
        listItems.push([
          {
            type: 'task',
            checked: task[1].toLowerCase() === 'x',
            children: inlineParse(task[2]),
          },
        ]);
        listIndents.push(indentLevel);
        i += 1;
        continue;
      }

      if (listItems.length > 0 && listOrdered !== isOrdered) flushList();
      if (listItems.length === 0 && isOrdered) listStart = itemNum;

      listOrdered = isOrdered;
      listItems.push(inlineParse(body));
      listIndents.push(indentLevel);
      i += 1;
      continue;
    }

    // ── 普通正文 ──
    flushList();
    flushQuote();
    // 保留行内软换行。
    if (para.length > 0) para.push({ type: 'text', value: '\n', style: {} });
    para.push(...inlineParse(line));
    i += 1;
  }

  flushAll();
  return out;
}

/** 表格行拆分：去首尾竖线，支持转义竖线 `\|`，逐格 trim。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let buf = '';

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      buf += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function parseAligns(line: string): Align[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => {
      const c = cell.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center' as const;
      if (c.endsWith(':')) return 'right' as const;
      return 'left' as const;
    });
}

/**
 * 行内解析：支持嵌套样式组合、转义符保护与流式降级。
 *
 * - `**加粗中含 `代码`**` 或 `**[链接](url)**` 能复合继承外层样式；
 * - `\` 转义字符不被误判为标记语法；
 * - 行内代码内保持纯字面量，不二次解析；
 * - 未闭合语法统一当纯文本。
 */
function inlineParse(text: string, base: MdStyle = {}): MdInline[] {
  const out: MdInline[] = [];
  let buf = '';

  const flush = () => {
    if (buf.length > 0) {
      out.push({ type: 'text', value: buf, style: base });
      buf = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    // 反斜杠转义：\* \_ ` \[ \] \~ \\ → 字面字符
    if (c === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if ('*_`[]~\\'.includes(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    // 行内代码优先：内部不嵌套解析，但继承外层样式
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ type: 'text', value: text.slice(i + 1, end), style: { ...base, code: true } });
        i = end + 1;
        continue;
      }
      buf += c; // 未闭合 → 当普通字符（流式常见）
      i += 1;
      continue;
    }

    // 图片 ![alt](url)
    if (c === '!' && text[i + 1] === '[') {
      const closeText = text.indexOf(']', i + 2);
      if (closeText > i && text[closeText + 1] === '(') {
        const closeUrl = text.indexOf(')', closeText);
        if (closeUrl > closeText) {
          flush();
          out.push({
            type: 'image',
            alt: text.slice(i + 2, closeText),
            url: text.slice(closeText + 2, closeUrl),
          });
          i = closeUrl + 1;
          continue;
        }
      }
    }

    // 链接 [text](url)
    if (c === '[') {
      const closeText = text.indexOf(']', i);
      if (closeText > i && text[closeText + 1] === '(') {
        const closeUrl = text.indexOf(')', closeText);
        if (closeUrl > closeText) {
          flush();
          out.push(
            ...inlineParse(text.slice(i + 1, closeText), { ...base, link: text.slice(closeText + 2, closeUrl) }),
          );
          i = closeUrl + 1;
          continue;
        }
      }
    }

    // 删除线 ~~text~~
    if (c === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i) {
        flush();
        out.push(...inlineParse(text.slice(i + 2, end), { ...base, strike: true }));
        i = end + 2;
        continue;
      }
    }

    // 粗斜体 *** / ___ ，粗体 ** / __
    if (c === '*' || c === '_') {
      const run3 = c === '*' ? '***' : '___';
      const run2 = c === '*' ? '**' : '__';

      if (text.startsWith(run3, i)) {
        const end = text.indexOf(run3, i + 3);
        if (end > i) {
          flush();
          out.push(...inlineParse(text.slice(i + 3, end), { ...base, bold: true, italic: true }));
          i = end + 3;
          continue;
        }
      }

      if (text.startsWith(run2, i)) {
        const end = text.indexOf(run2, i + 2);
        if (end > i) {
          flush();
          out.push(...inlineParse(text.slice(i + 2, end), { ...base, bold: true }));
          i = end + 2;
          continue;
        }
      }

      // 单字符斜体：CommonMark 规则，词内的 * / _ 不触发斜体
      const endSingle = text.indexOf(c, i + 1);
      const isIntraWord =
        endSingle > i &&
        endSingle < text.length - 1 &&
        /\w/.test(text[i - 1] ?? '') &&
        /\w/.test(text[endSingle + 1] ?? '');
      if (
        !isIntraWord &&
        endSingle > i + 1 &&
        !/\s/.test(text[i + 1]) &&
        !/\s/.test(text[endSingle - 1])
      ) {
        flush();
        out.push(...inlineParse(text.slice(i + 1, endSingle), { ...base, italic: true }));
        i = endSingle + 1;
        continue;
      }
    }

    buf += c;
    i += 1;
  }

  flush();
  return out;
}

/** 取节点纯文本（表格列宽估算、任务列表过滤用）。 */
export function inlinePlain(nodes: MdInline[]): string {
  let s = '';
  for (const n of nodes) s += n.type === 'text' ? n.value : n.alt;
  return s;
}

/** 取列表项纯文本（过滤空项用）。 */
export function listItemPlain(nodes: MdInline[]): string {
  for (const n of nodes) {
    if (n.type === 'text') return n.value.trim();
    if (n.type === 'image') return n.alt;
  }
  return '';
}
