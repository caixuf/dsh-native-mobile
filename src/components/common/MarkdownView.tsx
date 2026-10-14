import React, { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Info,
  Lightbulb,
  Bookmark,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import {
  Align,
  CALLOUT_META,
  CalloutType,
  MdBlock,
  MdInline,
  inlinePlain,
  listItemPlain,
  parseMarkdown,
  parseMarkdownIncremental,
  safeUrl,
} from '../../lib/markdown';
import { TOKEN_STYLES, highlight, normalizeLang } from '../../lib/highlight';

interface Props {
  content: string;
}

const CALLOUT_ICONS: Record<
  CalloutType,
  React.FC<{ size?: number | string; className?: string; color?: string }>
> = {
  NOTE: Info,
  TIP: Lightbulb,
  IMPORTANT: Bookmark,
  WARNING: AlertTriangle,
  CAUTION: ShieldAlert,
};

/**
 * 生产级 Markdown 富文本渲染器（Web 版）。
 *
 * 与 Android 端 `render/MarkdownView.kt` 同构，并对齐 DSH 上游
 * `@deepseek-ai/dsh-client-ui-primitives` 的真实设计基线：
 * - **CodeCard 卡片**：深色终端底 + 语言徽标 + 一键复制 + 行号 + 语法高亮；
 * - **GitHub Callout**：五种语义色警告块（说明/提示/重要/注意/危险）；
 * - **表格分两类**：≤3 列自适应填充（不滚动），≥4 列横向滚动（上游同款阈值）；
 * - **流式增量解析**：冻结稳定前缀，每个 chunk 只重解析尾部（上游同款策略）；
 * - **流式鲁棒**：未闭合语法降级为纯文本，不闪烁、不抛异常。
 */
export const MarkdownView: React.FC<Props> = ({ content }) => {
  // 用增量解析：流式输出时避免每次全量重解析（累计 O(n²) → 接近 O(n)）。
  //
  // ⚠️ 缓存是模块级的，切换内容语义（换会话/编辑）时必须失效，
  // 否则会把上一个会话的块复用进来 —— 所以这里用 `content` 是否
  // 以缓存前缀开头做校验（见 parseMarkdownIncremental 内部），
  // 并在内容明显回退（变短）时重置。
  const blocks = useMemo(() => {
    const text = content ?? '';
    return parseMarkdownIncremental(text);
  }, [content]);

  return (
    <div className="space-y-2 text-[14.5px] leading-[22px] text-[#151517] break-words">
      {blocks.map((block, idx) => (
        <BlockView key={idx} block={block} isFirst={idx === 0} />
      ))}
    </div>
  );
};

// ── 块分发 ──────────────────────────────────────────────────────────────────

const BlockView: React.FC<{ block: MdBlock; isFirst: boolean }> = ({ block, isFirst }) => {
  switch (block.type) {
    case 'heading':
      return (
        <HeadingBlock level={block.level} isFirst={isFirst} children={block.children} />
      );
    case 'code':
      return <CodeCard lang={block.lang} code={block.code} />;
    case 'list':
      return <ListView block={block} />;
    case 'quote':
      return <QuoteView>{renderInline(block.children)}</QuoteView>;
    case 'callout':
      return (
        <CalloutView callout={block.callout} title={block.title} children={block.children} />
      );
    case 'divider':
      return <DividerView />;
    case 'table':
      return <TableView block={block} />;
    case 'paragraph':
      return <ParagraphView children={block.children} />;
    default:
      return null;
  }
};

// ── 行内渲染 ────────────────────────────────────────────────────────────────

/**
 * 行内渲染：粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片。
 *
 * `white-space: pre-wrap` 保证软换行（模型输出里很常见）与显式 `\n` 都被保留。
 */
const Inline: React.FC<{ nodes: MdInline[] }> = ({ nodes }) => <>{renderInline(nodes)}</>;

function renderInline(nodes: MdInline[]): React.ReactNode {
  return nodes.map((node, i) => {
    if (node.type === 'image') {
      return <ImageCard key={i} alt={node.alt} url={node.url} />;
    }

    const { value, style } = node;

    // 纯文本且无样式：直接输出，避免包一层无意义的 <span>
    if (!style.bold && !style.italic && !style.code && !style.strike && !style.link) {
      return <React.Fragment key={i}>{value}</React.Fragment>;
    }

    let el: React.ReactNode = value;

    if (style.code) {
      el = (
        <code className="px-[5px] py-[2px] mx-[1px] bg-[#f0f1f5] text-[#b8285f] rounded-[5px] font-mono text-[12.5px] border border-[#e4e6eb] whitespace-nowrap">
          {value}
        </code>
      );
    }
    if (style.strike) {
      el = <s className="text-[#8e8e93] decoration-[#c7c7cc] decoration-[1.5px]">{el}</s>;
    }
    if (style.italic) {
      el = <em className="italic">{el}</em>;
    }
    if (style.bold) {
      el = <strong className="font-semibold text-[#0b0b0d]">{el}</strong>;
    }
    if (style.link) {
      // 🔴 XSS 闸门：模型输出可以造出 `javascript:` / `data:` 链接，
      // 原样塞进 href 就是存储型 XSS（用户一点即执行）。
      // safeUrl 做协议白名单（http/https/mailto + 相对地址），
      // 不安全时降级成**纯文本** —— 宁可少一个链接，也绝不执行脚本。
      const href = safeUrl(style.link);
      el = href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#3964fe] underline decoration-[#3964fe]/35 underline-offset-2 hover:decoration-[#3964fe] transition-colors inline-flex items-baseline gap-[2px]"
        >
          {el}
        </a>
      ) : (
        <span className="text-[#8e8e93] line-through decoration-[#c7c7cc]">{el}</span>
      );
    }

    return <React.Fragment key={i}>{el}</React.Fragment>;
  });
}

// ── 段落 / 标题 ────────────────────────────────────────────────────────────

const ParagraphView: React.FC<{ children: MdInline[] }> = ({ children }) => {
  if (inlinePlain(children).trim() === '') return null;
  return (
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      <Inline nodes={children} />
    </div>
  );
};

const HeadingBlock: React.FC<{ level: number; isFirst: boolean; children: MdInline[] }> = ({
  level,
  isFirst,
  children,
}) => {
  const size = level === 1 ? 'text-[19px]' : level === 2 ? 'text-[17px]' : 'text-[15px]';
  const mt = isFirst ? '' : level === 1 ? 'mt-4' : 'mt-3';

  return (
    <div className={`${size} ${mt} mb-1.5`}>
      <div className="font-semibold text-[#0b0b0d] tracking-tight whitespace-pre-wrap [overflow-wrap:anywhere]">
        <Inline nodes={children} />
      </div>
      {level === 1 && (
        <div className="mt-1.5 mb-2 h-[1px] bg-gradient-to-r from-[#d8d8de] via-[#ececf1] to-transparent" />
      )}
      {level !== 1 && <div className="h-1.5" />}
    </div>
  );
};

const DividerView: React.FC = () => (
  <div className="my-3.5 h-[1px] bg-gradient-to-r from-transparent via-[#dcdce2] to-transparent" />
);

// ── 引用 / Callout ──────────────────────────────────────────────────────────

const QuoteView: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  // 对齐上游 `MarkdownText.module.css`：`border-left: 2px` + `padding-left: 14px`。
  // 上游用 2px 而不是更粗的装饰条 —— 引用块是"次要内容"，不该比正文更抢眼。
  <div className="my-3 pl-[14px] py-0.5 border-l-2 border-[#c7c7cc] text-[#4a4a52] whitespace-pre-wrap">
    {children}
  </div>
);

const CalloutView: React.FC<{
  callout: CalloutType;
  title: string | null;
  children: MdInline[];
}> = ({ callout, title, children }) => {
  const meta = CALLOUT_META[callout];
  const Icon = CALLOUT_ICONS[callout];

  return (
    <div
      className="my-2 rounded-xl overflow-hidden"
      style={{
        background: `${meta.color}0f`,
        border: `1px solid ${meta.color}2e`,
        borderLeft: `3.5px solid ${meta.color}`,
      }}
    >
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5 mb-1">
          <Icon size={14} className="shrink-0" color={meta.color} />
          <span className="text-[12.5px] font-bold tracking-wide" style={{ color: meta.color }}>
            {title || meta.label}
          </span>
        </div>
        <div className="text-[#3d3d44] text-[13.5px] leading-[20px] whitespace-pre-wrap">
          <Inline nodes={children} />
        </div>
      </div>
    </div>
  );
};

// ── 列表 / 任务列表 ─────────────────────────────────────────────────────────

const ListView: React.FC<{ block: Extract<MdBlock, { type: 'list' }> }> = ({ block }) => {
  const items = useMemo(
    () =>
      block.items
        .map((item, i) => ({ item, indent: block.indents[i] ?? 0, originalIndex: i }))
        .filter((it) => listItemPlain(it.item) !== ''),
    [block],
  );

  if (items.length === 0) return null;

  return (
    <div className="my-1.5 space-y-[3px]">
      {items.map(({ item, indent, originalIndex }) => {
        // 🔴 编号必须用**原始下标**，不能用过滤后的序号。
        // 否则 `1. 2. 3. 7. 8.` 中间若有空项被过滤，7 会显示成 4（实测踩到）。
        const number = originalIndex + block.startNumber;
        // 两位数以上编号要留更多宽度，否则「10.」会换行
        const markerW = block.ordered ? (number >= 100 ? 30 : number >= 10 ? 24 : 19) : 16;
        const padLeft = indent * 15;

        // 任务项自带勾选框，不再画 • 或 1. 标记
        if (item.kind === 'task') {
          return (
            <TaskView
              key={originalIndex}
              checked={item.checked}
              nodes={item.children}
              padLeft={padLeft}
            />
          );
        }

        return (
          <div key={originalIndex} className="flex items-start" style={{ paddingLeft: padLeft }}>
            <span
              className={`shrink-0 font-mono text-[#8e8e93] leading-[22px] ${
                block.ordered ? '' : 'text-[#3964fe] font-bold'
              }`}
              style={{ width: markerW }}
            >
              {block.ordered ? `${number}.` : '•'}
            </span>
            <div className="flex-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <Inline nodes={item.children} />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const TaskView: React.FC<{ checked: boolean; nodes: MdInline[]; padLeft: number }> = ({
  checked,
  nodes,
  padLeft,
}) => (
  <div className="flex items-start gap-2 py-[3px]" style={{ paddingLeft: padLeft }}>
    <span
      className={`shrink-0 mt-[4px] w-[15px] h-[15px] rounded-[4px] border-[1.5px] flex items-center justify-center ${
        checked ? 'bg-[#34c759] border-[#34c759]' : 'border-[#c7c7cc] bg-white'
      }`}
    >
      {checked && <Check size={11} strokeWidth={3.5} className="text-white" />}
    </span>
    <div
      className={`flex-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${
        checked ? 'text-[#a0a0a8] line-through' : ''
      }`}
    >
      <Inline nodes={nodes} />
    </div>
  </div>
);

// ── 图片 ────────────────────────────────────────────────────────────────────

/**
 * 图片占位卡。
 *
 * 🔴 只渲染卡片、**不加载**远程图（省流量 + 避免聊天流里的跟踪像素）。
 * href 同样走 safeUrl 白名单：`![x](javascript:alert(1))` 不允许变成可点链接。
 * URL 不安全时降级成**不可点的静态卡片**，alt 文字照常显示。
 */
const ImageCard: React.FC<{ alt: string; url: string }> = ({ alt, url }) => {
  const href = safeUrl(url);

  const body = (
    <>
      <ImageIcon size={15} className="shrink-0 text-[#8e8e93]" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[#1c1c1e] truncate">{alt || '图片'}</div>
        {/* 🔴 不安全 URL 不回显原文，否则攻击者可借此把恶意协议显示成可信文本 */}
        <div className="text-[11px] text-[#aeaeb2] font-mono truncate">
          {href ?? '（不安全的链接已被禁用）'}
        </div>
      </div>
      {href && <ExternalLink size={12} className="shrink-0 text-[#aeaeb2]" />}
    </>
  );

  const cls =
    'my-1.5 flex items-center gap-2 px-3 py-2 rounded-xl bg-[#f7f7fa] border border-[#e8e8ee] no-underline hover:bg-[#f0f2f8] transition-colors';

  if (!href) {
    return <div className={`${cls} cursor-default`}>{body}</div>;
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {body}
    </a>
  );
};

// ── 表格 ────────────────────────────────────────────────────────────────────

/**
 * 表格。
 *
 * 🔴 分两类渲染，对齐 DSH 上游 `MarkdownText.module.css` 的真实规则：
 *
 * - **≤3 列**：`width: 100%` 自适应拉伸，单元格换行、**不横向滚动**。
 *   手机屏幕窄，三列表格完全放得下；如果也做成滚动，用户会看到一条
 *   毫无必要的滚动条，而且表格只占屏幕一半宽度、右边留白 —— 很难看。
 * - **≥4 列**：保持自然宽度 `max-content`，整块横向滚动。
 *   （上游注释：`deepsuite chat parity`，四列是"是否撑爆手机"的经验分界线。）
 *
 * 列宽估算夹在 `100px ~ min(30vw, 320px)`，与上游 `th/td` 的
 * `min-width: 100px; max-width: min(30vw, 320px)` 对齐。
 */
const TableView: React.FC<{ block: Extract<MdBlock, { type: 'table' }> }> = ({ block }) => {
  const colCount = block.header.length || 1;
  // ≥4 列才需要横向滚动（上游同一阈值）
  const needsScroll = colCount >= 4;

  const colWidths = useMemo(() => {
    return Array.from({ length: colCount }, (_, col) => {
      const headerLen = visualLen(block.header[col] ?? []);
      const maxRowLen = block.rows.reduce((m, row) => Math.max(m, visualLen(row[col] ?? [])), 0);
      const longest = Math.max(headerLen, maxRowLen);
      return Math.max(100, Math.min(320, Math.round(32 + longest * 8.2)));
    });
  }, [block, colCount]);

  if (colCount === 0) return null;

  return (
    <div className="my-2.5 rounded-xl border border-[#e4e4ea] overflow-hidden bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className={needsScroll ? 'overflow-x-auto overscroll-x-contain' : 'overflow-hidden'}>
        <table className={`border-collapse ${needsScroll ? 'w-max min-w-full' : 'w-full'}`}>
          <thead className="sticky top-0 z-[1]">
            <tr>
              {block.header.map((cell, i) => (
                <th
                  key={i}
                  style={
                    needsScroll
                      ? { minWidth: colWidths[i], width: colWidths[i], textAlign: alignOf(block.aligns[i]) }
                      : { minWidth: 100, textAlign: alignOf(block.aligns[i]) }
                  }
                  className={`bg-[#f6f7f9] px-3 py-2 border-b border-[#e4e4ea] text-[12.5px] font-semibold text-[#1c1c1e] ${
                    needsScroll ? 'whitespace-nowrap' : '[overflow-wrap:anywhere]'
                  }`}
                >
                  <Inline nodes={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rIdx) => (
              <tr key={rIdx} className={rIdx % 2 === 1 ? 'bg-[#fbfbfd]' : 'bg-white'}>
                {Array.from({ length: colCount }, (_, c) => (
                  <td
                    key={c}
                    style={
                      needsScroll
                        ? { minWidth: colWidths[c], width: colWidths[c], textAlign: alignOf(block.aligns[c]) }
                        : { minWidth: 100, textAlign: alignOf(block.aligns[c]) }
                    }
                    className="px-3 py-2 border-b border-[#f0f0f4] text-[13px] text-[#3d3d44] align-middle [overflow-wrap:anywhere]"
                  >
                    <Inline nodes={row[c] ?? []} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function alignOf(a: Align | undefined): 'left' | 'center' | 'right' {
  return a ?? 'left';
}

/**
 * 视觉宽度（以半角字符为 1 个单位）：CJK 与 emoji 按 2 计。
 *
 * 不这样做的话，一列全是中文的表格会被估得和英文列一样窄，
 * 每个字都换行 —— 这是手机端表格最常见的排版事故。
 *
 * 🔴 emoji 必须单独处理：它们落在 **U+1F300–U+1FAFF**（星形平面），
 * 完全不在 CJK 区间的 `\u2E80-\uA4CF` 里。原实现只判 CJK，
 * 于是 `| 🚀 |` 这种列被算成 1 个单位宽，实际渲染要两倍空间 → 溢出/换行。
 * 实测：`"🐛 有 bug"` 当前实现算 8 单位，加入 emoji 后算 9，列宽 84 → 98px。
 *
 * 另外补两个真实存在的字符：
 * - 制表符 → 4（对齐到默认 tab stop）
 * - 组合附加符号（U+0300–U+036F，如 `é` 的重音符）→ 0（零宽，不占栅格）
 */
const WIDE_CHAR_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const WIDE_EXTRA_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const ZERO_WIDTH_RE = /[\u0300-\u036F\u200B-\u200F\uFEFF]/;

function visualLen(nodes: MdInline[]): number {
  const text = inlinePlain(nodes);
  let w = 0;
  for (const ch of text) {
    if (ch === '\t') w += 4;
    else if (ZERO_WIDTH_RE.test(ch)) w += 0;
    else if (WIDE_CHAR_RE.test(ch) || WIDE_EXTRA_RE.test(ch)) w += 2;
    else w += 1;
  }
  return w;
}

// ── 代码块 ──────────────────────────────────────────────────────────────────

/**
 * CodeCard：深色终端卡片。
 *
 * - 语言徽标（归一化后的大写，兼容 ```shell session 这类多词 language）
 * - 可选行号（超过 3 行才显示，避免小片段被行号挤窄）
 * - 一键复制，带「已复制」反馈态
 * - 语法高亮按行分词，未知语言走轻量规则
 */
const CodeCard: React.FC<{ lang: string | null; code: string }> = ({ lang, code }) => {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const normalized = normalizeLang(lang);
  const lines = useMemo(() => highlight(code, lang), [code, lang]);
  const showLineNumbers = lines.length > 3;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文 / 用户拒绝）时静默失败，不打断阅读
    }
  };

  // 长代码折叠：默认显示 18 行，展开后全部显示
  const COLLAPSE_AFTER = 18;
  const isLong = lines.length > COLLAPSE_AFTER;
  const visibleLines = isLong && !expanded ? lines.slice(0, COLLAPSE_AFTER) : lines;

  return (
    <div className="my-2.5 rounded-xl overflow-hidden border border-[#2c2c34] bg-[#1b1b22] shadow-[0_2px_8px_rgba(0,0,0,0.18)]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#23232b] border-b border-[#2c2c34]">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.8px] text-[#7f8490]">
          {normalized || 'code'}
        </span>
        <div className="flex items-center gap-1">
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-0.5 text-[11px] text-[#7f8490] hover:text-[#d4d4d4] transition-colors cursor-pointer px-1.5 py-0.5 rounded"
            >
              <ChevronDown
                size={12}
                className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
              <span>{expanded ? '收起' : `展开全部 ${lines.length} 行`}</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-[11px] text-[#7f8490] hover:text-[#d4d4d4] transition-colors cursor-pointer px-1.5 py-0.5 rounded"
          >
            {copied ? <Check size={12} className="text-[#4ade80]" /> : <Copy size={12} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>

      <div className="overflow-x-auto overscroll-x-contain">
        <pre className="m-0 py-2.5 text-[12.5px] leading-[19px] font-mono">
          <code>
            {visibleLines.map((tokens, i) => (
              <span
                key={i}
                className={`flex ${i % 2 === 1 ? 'bg-[#1e1e26]' : ''}`}
              >
                {showLineNumbers && (
                  <span
                    className="shrink-0 select-none text-right text-[#4a4d57] px-2.5"
                    style={{ minWidth: `${String(lines.length).length * 8 + 22}px` }}
                  >
                    {i + 1}
                  </span>
                )}
                <span className="flex-1 pr-3 whitespace-pre">
                  {tokens.length === 0 ? (
                    ' '
                  ) : (
                    tokens.map((tok, j) => {
                      const st = TOKEN_STYLES[tok.kind] ?? TOKEN_STYLES.plain;
                      return (
                        <span
                          key={j}
                          style={{
                            color: st.color,
                            fontStyle: st.fontStyle,
                            fontWeight: st.fontWeight,
                          }}
                        >
                          {tok.text}
                        </span>
                      );
                    })
                  )}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
};
