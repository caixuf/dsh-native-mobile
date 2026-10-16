import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { collapsePreview, expandLabel, type CollapsePreview } from '../../lib/message-queue';
import { copyToClipboard } from './clipboard';

interface Props {
  /** 稳定标识（ChatLine.key）；展开状态按它记忆。 */
  messageKey: string;
  /** 原文（复制、折叠统计都用它）。 */
  text: string;
  expanded: boolean;
  onToggleExpand: (key: string) => void;
  /** `plain`：用户原文（字符级预览 + line-clamp 6 行）；`markdown`：富文本（高度裁剪，保住代码块/表格）。 */
  mode?: 'plain' | 'markdown';
  /** 气泡/卡片的对齐方向。 */
  align?: 'start' | 'end';
  /** 正文容器的样式（气泡底色、圆角、内边距等由调用方决定）。 */
  bodyClassName?: string;
  /** 正文容器内部、裁剪区**之上**的内容（例如助手卡片的标题行）。 */
  header?: React.ReactNode;
  /** 富文本正文（mode === 'markdown' 时传入）。 */
  children?: React.ReactNode;
  /** 流式光标：仅最后一条 + running + liveConnected 时开。 */
  showCursor?: boolean;
  /** 长按/点按激活（操作条高亮）。 */
  active?: boolean;
  onActivate?: (key: string | null) => void;
  /** 折叠态最大高度（≈6 行，正文行高 22–23px；markdown 用）。 */
  collapsedMaxHeightPx?: number;
  /** 稳定 DOM 契约：渲染成 data-message-role，e2e 按它选（别再绑样式类）。 */
  messageRole?: 'user' | 'assistant' | 'system';
}

/** ≈6 行正文（14.5px / leading-[22px]）；仅供 markdown 高度裁剪使用。 */
const COLLAPSED_MAX_HEIGHT_PX = 138;

/**
 * 超长消息折叠 + 消息级复制。
 *
 * 真机事故：一条 1.2 万字 runtime context 整块渲染把屏幕淹没。
 * 这里做三件事：
 *  1. 纯函数判定（`shouldCollapse` / `collapsePreview`）→ 折叠为 6 行 + 「展开全部（共 N 字）」；
 *  2. `plain` 模式用 `-webkit-line-clamp: 6` **精确 6 行**（不会出现半行被切），
 *     且只渲染 ≤600 字的预览文本（1.2 万字不必进 DOM）；
 *     `markdown` 模式用 maxHeight 裁剪，保证代码块/表格内部布局不被 `-webkit-box` 破坏；
 *  3. 复制按钮：桌面 hover/键盘 focus 出现，触屏常显（淡）；长按（contextmenu）
 *     让操作条变亮并保持 —— 移动端没有 hover，不能只靠 hover。
 */
export const CollapsibleMessage: React.FC<Props> = ({
  messageKey,
  text,
  expanded,
  onToggleExpand,
  mode = 'plain',
  align = 'start',
  bodyClassName = '',
  header,
  children,
  showCursor = false,
  active = false,
  onActivate,
  collapsedMaxHeightPx = COLLAPSED_MAX_HEIGHT_PX,
  messageRole,
}) => {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // 折叠统计只跟 text 有关：流式期间父组件每次重渲染都别重算上万字的 O(n)
  const result: CollapsePreview = useMemo(() => collapsePreview(text), [text]);
  const clamped = result.collapsed && !expanded;

  const handleCopy = async () => {
    const done = await copyToClipboard(text);
    setCopied(done);
    setCopyFailed(!done);
    setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 1600);
  };

  const body = (
    <div
      className={bodyClassName}
      style={
        clamped && mode === 'plain'
          ? {
              display: '-webkit-box',
              WebkitLineClamp: 6,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }
          : undefined
      }
    >
      {header}
      {mode === 'plain' ? (
        <span
          className="whitespace-pre-wrap break-words"
          // E2E 量"正文到底占多高"用（真机断言：折叠时正文 ≈6 行）
          data-collapsed-body={clamped && !expanded ? 'true' : undefined}
          // 稳定契约：e2e 取"正文"靠它，不要绑样式类
          data-message-body
        >
          {expanded ? text : result.preview}
        </span>
      ) : (
        <div
          className={clamped ? 'overflow-hidden' : undefined}
          style={clamped ? { maxHeight: collapsedMaxHeightPx } : undefined}
          data-collapsed-body={clamped && !expanded ? 'true' : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );

  const showActions = active;
  const actionOpacity = showActions
    ? 'opacity-100'
    : 'opacity-100 sm:opacity-0 sm:group-hover/message:opacity-100 focus-within:opacity-100';

  return (
    <div
      role="group"
      aria-label={`消息 ${messageKey}`}
      data-message-key={messageKey}
      data-message-role={messageRole}
      data-collapsed={result.collapsed ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      data-full-chars={result.totalChars}
      data-full-lines={result.totalLines}
      onContextMenu={(event) => {
        // 移动端长按会触发 contextmenu —— 用它唤出操作条
        event.preventDefault();
        onActivate?.(active ? null : messageKey);
      }}
      className={`group/message flex flex-col ${align === 'end' ? 'items-end' : 'items-start'}`}
    >
      {body}

      <div className="flex items-center gap-1 mt-1">
        {result.collapsed && (
          <button
            type="button"
            onClick={() => onToggleExpand(messageKey)}
            aria-expanded={expanded}
            aria-label={expanded ? '收起这条消息' : expandLabel(result)}
            className="min-h-[44px] px-3 rounded-xl text-[11.5px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 cursor-pointer"
          >
            {expanded ? '收起' : expandLabel(result)}
          </button>
        )}

        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? '已复制这条消息' : copyFailed ? '复制失败' : '复制这条消息'}
          className={`min-h-[44px] px-3 rounded-xl flex items-center gap-1.5 text-[11.5px] font-medium border transition-all cursor-pointer ${
            copied
              ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
              : copyFailed
                ? 'text-rose-700 bg-rose-50 border-rose-200'
                : 'text-gray-600 hover:text-black bg-gray-100 hover:bg-gray-200 border-gray-200/60'
          } ${actionOpacity}`}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? '已复制' : copyFailed ? '复制失败' : '复制'}</span>
        </button>

        <span
          className={`text-[10.5px] text-[#52525b] px-1 select-none ${
            result.collapsed ? 'opacity-100' : actionOpacity
          }`}
        >
          {result.collapsed && !expanded
            ? `${result.totalChars} 字 · 显示前 ${result.previewLines} 行`
            : `${result.totalChars} 字`}
        </span>

        {showCursor && (
          <span className="flex items-center gap-1 px-1" aria-hidden="true">
            <span className="inline-block w-[7px] h-[15px] rounded-[2px] bg-[#38bdf8] animate-pulse" />
          </span>
        )}
        {showCursor && <span className="sr-only">正在输出…</span>}
      </div>
    </div>
  );
};