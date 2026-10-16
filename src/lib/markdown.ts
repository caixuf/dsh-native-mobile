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

/**
 * 列表项。
 *
 * 🔴 必须与普通项区分成一个**联合类型**，而不是把任务项塞进 `children` 里。
 * 早期版本把任务项当成一个「伪行内节点」混进行内数组，结果行内渲染器
 * （只认 text/image）会把它**整个静默丢掉** —— 用户看到的是
 * 「- [x] 写完文档」这一行凭空消失，且不报任何错。
 */
export type MdListItem =
  | { kind: 'item'; children: MdInline[] }
  | { kind: 'task'; checked: boolean; children: MdInline[] };

/** 列表块：`items` 与 `indents` 平行数组，index 对齐。 */
export interface MdListBlock {
  type: 'list';
  ordered: boolean;
  startNumber: number;
  items: MdListItem[];
  indents: number[];
}

export interface MdQuote {
  type: 'quote';
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

/**
 * 🔴 链接 URL 协议白名单。
 *
 * 模型输出（以及被投毒的 prompt）可以轻松产出 `[点我](javascript:alert(1))`。
 * 渲染端如果把它原样塞进 `<a href>`，用户一点就执行脚本 —— 这是**存储型 XSS**。
 *
 * 白名单只放三种无脚本能力的协议：
 * - `http:` / `https:` —— 正常外链
 * - `mailto:` —— 邮件
 *
 * `javascript:` / `data:` / `vbscript:` / `file:` 一律拒绝。
 *
 * 净化要点（每一条都是绕过手法）：
 * 1. `trim()` —— ` javascript:alert(1)` 前导空格浏览器照样执行；
 * 2. 去掉控制字符 —— `java\tscript:` / `java\nscript:` 在 IE/旧引擎里是合法协议；
 * 3. `toLowerCase()` —— `JaVaScRiPt:`；
 * 4. 必须是「相对地址」时不能含冒号 —— `/a:b` 里 `a:b` 不是协议，别误杀；
 * 5. `//evil.com` 协议相对地址会继承当前页面协议，等价外链，放行。
 *
 * 放行的相对地址（`./x`、`/x`、`#a`、`?q=1`）不能被 `\evil.com` 这种
 * 反斜杠绕过，所以先按 WHATWG 规范把它们统一成 `/` 开头再判。
 */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/** 不含协议分隔符 → 一定是相对地址（`#a`、`/x`、`./x`、`?q`、裸路径）。 */
function hasSchemeLikePrefix(url: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url);
}

/**
 * 清洗 URL；不安全返回 `null`。
 *
 * 导出给渲染层做最后一道闸 —— 解析器保留原样 URL 是为了「文本不丢失」，
 * 渲染层则负责「不执行」。两层职责分开，改任何一层都不影响另一层。
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // WHATWG：反斜杠等价于斜杠，`\\evil.com` → `//evil.com`（协议相对，安全）
  const normalized = raw.replace(/\\/g, '/');

  // 去掉 ASCII 控制字符与制表/换行：`java\tscript:` 是经典绕过
  // eslint-disable-next-line no-control-regex
  const cleaned = normalized.replace(/[\u0000-\u001F\u007F]/g, '').trim();

  if (cleaned === '') return null;

  if (hasSchemeLikePrefix(cleaned)) {
    const lower = cleaned.toLowerCase();
    return SAFE_PROTOCOLS.some((p) => lower.startsWith(p)) ? cleaned : null;
  }

  // 没有协议前缀 → 纯相对地址，天然安全。
  // 但 `\n//evil.com` 之类已经被上面清洗掉了，这里不会漏。
  return cleaned;
}

/**
 * 清洗图片 URL；放行安全协议以及安全的 data:image/ base64 协议
 */
export function safeImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(cleaned)) {
    return cleaned;
  }
  return safeUrl(cleaned);
}

export type MdInline = MdText | MdImage;

/** 块级节点。任务项不属于块级 —— 它只能作为 `MdListBlock` 里的一项存在。 */
export type MdBlock =
  | MdParagraph
  | MdHeading
  | MdCodeBlock
  | MdListBlock
  | MdQuote
  | MdDivider
  | MdTable
  | MdCallout;

export const CALLOUT_META: Record<CalloutType, { label: string; color: string }> = {
  NOTE: { label: '说明', color: '#2563eb' },
  TIP: { label: '提示', color: '#059669' },
  IMPORTANT: { label: '重要', color: '#7c3aed' },
  WARNING: { label: '注意', color: '#d97706' },
  CAUTION: { label: '危险', color: '#dc2626' },
};

// ── 解析器 ──────────────────────────────────────────────────────────────────

const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s+(.*))?$/i;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIVIDER_RE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const TABLE_SEP_RE = /^\|?[\s:|-]+\|[\s:|-]*$/;
const TABLE_SEP_PREFIX_RE = /^\|?\s*:?-{1,}/;
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

// ── 流式增量解析 ────────────────────────────────────────────────────────────
//
// 对齐 DSH 上游 `ui-primitives` 的 Streaming markdown 策略（README 原文）：
//
//   "all but the trailing two blocks freeze as cached React elements and only
//    the source tail re-parses per chunk, so per-chunk work tracks the tail
//    instead of the whole reply."
//
// 即：**除尾部两个块之外，前面所有块冻结复用，每个 chunk 只重解析尾部**。
//
// 为什么必须这么做：模型流式输出时，每来一个 token 就重渲染一次。
// 若每次都全量解析整篇回复，成本随回复长度线性增长 ——
// 一条 5000 字的回复在第 5000 个 token 时要全量重解析 5000 字，
// 累计 O(n²)。手机上表现为**越到后面越卡、输入框都跟着掉帧**。
//
// 实现要点（与上游一致的稳定性判据）：
//  - 只有**空行**才可能成为「安全切点」：块级结构在空行处一定闭合，
//    所以在最后一个空行之前的内容不会因为后续 token 而改变解析结果；
//  - 尾部保留**两个块**（上游同款）作为"可能还在长"的缓冲带 ——
//    一个块正在流式增长，前一个块可能因它的语法（如未闭合围栏）被吞并；
//  - 切点之前的块直接复用缓存对象（React 侧靠 memo 跳过重渲染）。

interface IncrementalCache {
  /** 已冻结的稳定前缀（原文子串，便于校验复用前提）。 */
  prefix: string;
  /** 该前缀解析出的块。 */
  blocks: MdBlock[];
}

let incrementalCache: IncrementalCache | null = null;

/**
 * 计算安全切点：最后一个空行之后的位置。
 *
 * 返回 `cut` 表示 `source.slice(0, cut)` 可以被视为**已稳定**。
 * 没有空行时返回 0（整段都还不稳定）。
 *
 * ⚠️ 必须排除「空行落在未闭合代码围栏内部」的情况：
 * 围栏里的空行不闭合任何块，切在那里会把代码块劈成两半。
 * 这里的判据是**围栏配对为偶数**（未闭合则不能切）。
 */
function stableCut(source: string): number {
  const lastBlank = source.lastIndexOf('\n\n');
  if (lastBlank <= 0) return 0;

  const head = source.slice(0, lastBlank);
  // 统计未闭合围栏：奇数个 ``` 说明当前仍在代码块里，不能切。
  const fences = (head.match(/^```/gm) || []).length;
  if (fences % 2 !== 0) {
    // 围栏未闭合：退到该围栏之前再试一次
    const fenceStart = head.lastIndexOf('\n```');
    if (fenceStart <= 0) return 0;
    const beforeFence = head.slice(0, fenceStart);
    const innerBlank = beforeFence.lastIndexOf('\n\n');
    return innerBlank > 0 ? innerBlank : 0;
  }
  return lastBlank;
}

/**
 * 增量解析入口：流式场景应调用它而非 `parseMarkdown`。
 *
 * 返回的数组 = 冻结的前缀块（同一对象引用，React 可跳过） + 重新解析的尾部块。
 *
 * ⚠️ 正确性优先：任何不确定的情形都退回全量解析。
 * 宁可慢一点，也不能因为缓存给用户显示**过期的排版**。
 */
export function parseMarkdownIncremental(source: string): MdBlock[] {
  const cut = stableCut(source);

  if (cut === 0) {
    // 整段都不稳定（还没有空行，或空行在未闭合围栏里）→ 全量解析并作废缓存
    incrementalCache = null;
    return parseMarkdown(source);
  }

  const prefix = source.slice(0, cut);

  // 缓存命中校验：前缀必须**逐字相同**才敢复用。
  // 只看长度是不够的 —— 流式文本理论上可能被上游重写（重试、编辑）。
  const reusable =
    incrementalCache !== null &&
    incrementalCache.prefix === prefix;

  const headBlocks = reusable
    ? incrementalCache!.blocks
    : parseMarkdown(prefix);

  // 尾部（切点之后）始终重新解析，保证正在增长的那个块是新鲜的
  const tailSource = source.slice(cut);
  const tailBlocks = tailSource.trim() === '' ? [] : parseMarkdown(tailSource);

  const blocks = [...headBlocks, ...tailBlocks];

  // 只保留「尾部两块之前」的部分作为下次可复用的前缀。
  //
  // 🔴 这是上游那句 "trailing two blocks" 的落地：
  // 最后两块随时可能被新 token 改变形态（例如段落变成列表、围栏被吞），
  // 所以它们**不能进缓存**，下次必须重解析。
  // 我们把 tail 之前的 head 部分整体缓存即可 —— head 本身已经来自稳定切点，
  // 它内部的最后一块不会跨越切点变化（切点是空行，块必然闭合）。
  incrementalCache = { prefix, blocks: headBlocks };

  return blocks;
}

/** 清空增量缓存（切换会话、编辑历史时调用，防止串数据）。 */
export function resetIncrementalCache(): void {
  incrementalCache = null;
}

function parseUnsafe(src: string): MdBlock[] {
  const lines = src.split('\n');
  const out: MdBlock[] = [];

  const para: MdInline[] = [];
  let listOrdered = false;
  let listStart = 1;
  let listItems: MdListItem[] = [];
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
    //
    // 🔴 流式妥协：分隔行还没打完时（`| ---`），若严格要求完整分隔行，
    // 整张表会在「最后一格补齐」的瞬间从段落**整体跳变**成表格 —— 用户看到闪一下。
    // 所以这里放宽成「以 `-` 开头的前缀」也算数，让它从一开始就是表格，
    // 后续列只是逐格长出来，不存在形态突变。
    if (line.includes('|') && i + 1 < lines.length && isSeparatorPrefix(lines[i + 1].trim())) {
      flushAll();
      const header = splitRow(line).map((cell) => inlineParse(cell));
      const aligns = parseAligns(lines[i + 1]);
      i += 2;

      const rows: MdInline[][][] = [];
      while (i < lines.length) {
        const row = lines[i];
        if (!row.includes('|') || row.trim() === '') break;
        const cells = splitRow(row);
        // 列数不一致时按表头补齐/截断，避免渲染错位。
        const padded = [...cells, ...Array(Math.max(0, header.length - cells.length)).fill('')];
        rows.push(padded.slice(0, header.length).map((cell) => inlineParse(cell)));
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
        // 🔴 必须先切开已有列表：任务项会把列表强制改成无序。
        // 若当前已是**有序**列表，直接改 listOrdered 会得到
        // 「1. / 2. 标题旁边挂一个无编号勾选框」的错位渲染。
        // Kotlin 端 `Markdown.kt` 同一处有 flushList()，两端必须一致。
        if (listItems.length > 0 && listOrdered) flushList();
        listOrdered = false;
        listItems.push({
          kind: 'task',
          checked: task[1].toLowerCase() === 'x',
          children: inlineParse(task[2]),
        });
        listIndents.push(indentLevel);
        i += 1;
        continue;
      }

      if (listItems.length > 0 && listOrdered !== isOrdered) flushList();
      if (listItems.length === 0 && isOrdered) listStart = itemNum;

      listOrdered = isOrdered;
      listItems.push({ kind: 'item', children: inlineParse(body) });
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

/**
 * 找链接目标 `](` 之后的闭合 `)`，支持**括号配对**。
 *
 * 🔴 原实现用 `text.indexOf(')')`，遇到 URL 里的括号就截断：
 *   `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))`
 *   → href 变成 `https://en.wikipedia.org/wiki/Foo_(bar`，链接坏掉。
 * 而对 XSS 来说更糟：`[点](javascript:alert(document.cookie))` 会被截成
 * `javascript:alert(document.cookie` —— 反而变成了一个语法完整、可执行的 payload。
 *
 * 这里改成从 `(` 开始做括号深度计数，扫到深度归零的那个 `)`。
 * 转义的 `\(` / `\)` 不参与配对。
 *
 * 未配对（流式只打了一半）时返回 -1 → 走「未闭合当纯文本」铁律。
 */
function findCloseParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1; // 跳过被转义的下一个字符
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 表格行拆分：去首尾竖线，支持转义竖线 `\|`，逐格 trim。 */
function splitRow(line: string): string[] {
  // ⚠️ 必须剥掉**所有**首尾竖线，不能只剥一个：
  //   `||a||b||` → `["","a","","b",""]`（错位一整列）
  //            → `["a","","b"]`   （与 Kotlin `String.trim('|')` 一致）
  const trimmed = line.trim().replace(/^\|+/, '').replace(/\|+$/, '');
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

/**
 * 分隔行判定。
 *
 * 完整形态 `|---|---|` 直接匹配；流式中途的 `| ---` 这类前缀也放行，
 * 让表格从第一帧起就以表格形态存在，避免最后一格补齐时整体跳变。
 */
function isSeparatorPrefix(line: string): boolean {
  return TABLE_SEP_RE.test(line) || TABLE_SEP_PREFIX_RE.test(line);
}

/** 解析对齐行 `|---|:--:|---:|`。流式下未写完的列按左对齐兜底。 */
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
        const closeUrl = findCloseParen(text, closeText + 1);
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
        const closeUrl = findCloseParen(text, closeText + 1);
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
export function listItemPlain(item: MdListItem): string {
  const text = inlinePlain(item.children);
  return text.trim();
}
