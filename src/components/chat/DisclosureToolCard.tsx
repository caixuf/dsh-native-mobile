import React, { useEffect, useId, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Globe,
  Terminal,
  Wrench,
} from 'lucide-react';
import { copyToClipboard } from './clipboard';
import { toolActionLabel, toolKind } from '../../lib/tool-labels';
import { formatDuration } from '../../lib/session-activity';

interface Props {
  toolName?: string | null;
  toolArgs?: string | null;
  toolResult?: string | null;
  isError?: boolean;
  /** `tool/call` 与 `tool/result` 必须视觉可区分（缺省按有无结果推断）。 */
  kind?: string | null;
  /** 默认是否展开；缺省时"错误态自动展开"，其余折叠。 */
  defaultExpanded?: boolean;
  /** 这次调用实际耗时（毫秒）；有值才显示"用时 1.7秒"。 */
  toolMs?: number | null;
}

/** 超过这个长度就折叠（参数/结果的"长尾"不再挤爆时间线）。 */
const COLLAPSE_AT = 600;

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 不是 JSON（例如一段命令行文本）—— 走原始文本展示
  }
  return null;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 复制按钮（共用 `./clipboard` 的实现：async clipboard → execCommand 回退）。
 * 这里再包一层"已复制/失败"的视觉反馈。
 */

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      aria-label={copied ? `${label}（已复制）` : failed ? `${label}（复制失败）` : label}
      onClick={async () => {
        const done = await copyToClipboard(text);
        setCopied(done);
        setFailed(!done);
        setTimeout(() => {
          setCopied(false);
          setFailed(false);
        }, 1600);
      }}
      className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center border transition-colors cursor-pointer studio-tap ${
        copied
          ? 'text-[#34d399] bg-[#10b981]/15 border-[#10b981]/30'
          : failed
            ? 'text-[#fb7185] bg-[#f43f5e]/10 border-[#f43f5e]/30'
            : 'text-[#94a3b8] hover:text-white bg-white/[0.04] hover:bg-white/[0.1] border-white/[0.08]'
      }`}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
};

/** 长文本块：超长折叠 + 展开/收起（键盘可达）。 */
const TextBlock: React.FC<{ text: string; tone: 'args' | 'result' | 'error' }> = ({ text, tone }) => {
  const [showAll, setShowAll] = useState(false);
  const collapsible = text.length > COLLAPSE_AT;
  const shown = collapsible && !showAll ? `${text.slice(0, COLLAPSE_AT)}…` : text;

  const palette =
    tone === 'error'
      ? 'bg-[#1f0d14] border-[#f43f5e]/40 text-[#fda4af]'
      : tone === 'args'
        ? 'bg-[#07090e] border-white/10 text-[#38bdf8]'
        : 'bg-[#07090e] border-white/10 text-[#e2e8f0]';

  return (
    <div>
      <pre
        className={`p-2.5 rounded-xl border ${palette} overflow-x-auto max-h-64 whitespace-pre-wrap break-all text-[11.5px] leading-relaxed shadow-inner`}
      >
        {shown}
      </pre>
      {collapsible && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          aria-label={showAll ? '收起完整内容' : `展开全部内容，共 ${text.length} 字符`}
          className="mt-1 min-h-[44px] px-3 rounded-xl text-[11.5px] font-medium text-[#93c5fd] bg-[#3b82f6]/10 hover:bg-[#3b82f6]/20 border border-[#3b82f6]/25 cursor-pointer studio-tap"
        >
          {showAll ? '收起' : `展开全部（${text.length} 字符）`}
        </button>
      )}
    </div>
  );
};

/** 结构化入参：把 JSON 对象渲染成键值行（值太长仍可折叠）。 */
const StructuredArgs: React.FC<{ entries: Array<[string, unknown]> }> = ({ entries }) => (
  <dl className="space-y-1.5">
    {entries.map(([key, value]) => {
      const text = stringifyValue(value);
      return (
        <div key={key} className="rounded-xl bg-[#07090e] border border-white/10 p-2.5">
          <dt className="text-[11px] font-sans font-semibold text-[#94a3b8] mb-1 break-all">{key}</dt>
          <dd>
            <TextBlock text={text} tone="args" />
          </dd>
        </div>
      );
    })}
  </dl>
);

/**
 * 工具卡片：`tool/call`（调用中/参数）与 `tool/result`（结果/错误）在视觉上必须分得清。
 *
 * - 错误态：rose 描边 + 顶部一行错误摘要（折叠时也可见），**默认自动展开**，
 *   但只用一条描边和一枚徽标，不铺满红色（"醒目但克制"）。
 * - 长参数 / 长结果：>600 字符折叠，附"展开全部（N 字符）"。
 * - 参数是 JSON 对象时按结构化键值展示，另附"原始 JSON"复制。
 * - 头部整体是 `<button>`：Enter/Space 可展开，`aria-expanded`/`aria-controls` 齐备；
 *   所有操作按钮 44×44px。
 */
export const DisclosureToolCard: React.FC<Props> = ({
  toolName = '工具',
  toolArgs,
  toolResult,
  isError = false,
  kind,
  defaultExpanded,
  toolMs,
}) => {
  const bodyId = useId();
  const [expanded, setExpanded] = useState<boolean>(() => defaultExpanded ?? isError);
  const [touched, setTouched] = useState(false);
  const [showRawArgs, setShowRawArgs] = useState(false);

  // 流式过程中才转为失败的调用卡片自动展开（用户手动收过后不再打扰）
  useEffect(() => {
    if (isError && !touched) setExpanded(true);
  }, [isError, touched]);

  const isResult = kind === 'tool/result' || (!kind && Boolean(toolResult));
  const kindLabel = isResult ? '结果' : '调用';
  const hasResult = Boolean(toolResult);
  const errorText = isError ? toolResult || toolArgs || '执行失败' : '';
  const errorSummary = errorText.split('\n').find((line) => line.trim() !== '') || '执行失败';

  const argEntries = parseObject(toolArgs) ? Object.entries(parseObject(toolArgs) as Record<string, unknown>) : null;

  const getToolIcon = () => {
    // 以前这里只认旧 Kotlin App 的 run_command/bash/…，DSH 现在的 pwsh/read/web_search
    // 全部落到 default —— 现在按工具语义类别选图标。
    switch (toolKind(toolName)) {
      case 'shell':
        return <Terminal size={14} className="text-[#c084fc]" />;
      case 'file':
      case 'search':
        return <FileText size={14} className="text-[#38bdf8]" />;
      case 'web':
        return <Globe size={14} className="text-[#34d399]" />;
      default:
        return <Wrench size={14} className="text-[#a78bfa]" />;
    }
  };

  const getFriendlyName = () => {
    // 有结果 = 已完成，没结果 = 正在做（对齐 GUI 的「执行了命令」/「深度搜索中」）
    const mode = hasResult ? 'done' : 'running';
    return toolActionLabel(toolName, mode);
  };

  // 头部一行摘要：优先结构化字段，其次截断原始文本
  const getArgSnippet = () => {
    if (!toolArgs) return '';
    const parsed = parseObject(toolArgs);
    if (parsed) {
      const first = parsed.command ?? parsed.path ?? parsed.query ?? parsed.file_path;
      if (typeof first === 'string') return first;
      return JSON.stringify(parsed);
    }
    return toolArgs;
  };

  const snippet = getArgSnippet();

  return (
    <div
      className={`my-2 rounded-2xl specular-card overflow-hidden text-xs transition-all shadow-lg border ${
        isError ? 'border-[#f43f5e]/45' : 'border-white/10'
      }`}
    >
      <button
        type="button"
        onClick={() => {
          setTouched(true);
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={`${getFriendlyName()}（${kindLabel}）${isError ? '，失败' : hasResult ? '，已完成' : '，执行中'}，${expanded ? '收起详情' : '展开详情'}`}
        className="w-full min-h-[44px] flex items-center justify-between gap-2 px-3.5 py-2.5 text-left cursor-pointer bg-[#131724]/80 hover:bg-[#1a2030] transition-colors"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span className="p-1.5 rounded-lg bg-[#a855f7]/15 border border-[#a855f7]/25 flex items-center justify-center shrink-0">
            {getToolIcon()}
          </span>
          <span className="font-semibold text-white tracking-wide shrink-0">{getFriendlyName()}</span>
          <span
            className={`shrink-0 text-[10.5px] font-medium px-1.5 py-0.5 rounded-md border ${
              isResult
                ? 'text-[#c4b5fd] bg-[#a855f7]/10 border-[#a855f7]/30'
                : 'text-[#7dd3fc] bg-[#0ea5e9]/10 border-[#0ea5e9]/30'
            }`}
          >
            {kindLabel}
          </span>
          {snippet && (
            <span className="text-[#94a3b8] font-mono truncate bg-white/[0.04] px-2 py-0.5 rounded border border-white/[0.06] hidden sm:inline">
              {snippet.length > 60 ? `${snippet.slice(0, 60)}…` : snippet}
            </span>
          )}
        </span>

        <span className="flex items-center gap-2 shrink-0 ml-2">
          {hasResult ? (
            isError ? (
              <span className="flex items-center gap-1 text-[#fb7185] text-[11px] font-medium bg-[#f43f5e]/15 px-2 py-0.5 rounded-full border border-[#f43f5e]/30">
                <AlertCircle size={12} />
                失败
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[#34d399] text-[11px] font-medium bg-[#10b981]/15 px-2 py-0.5 rounded-full border border-[#10b981]/30">
                <CheckCircle2 size={12} />
                完成
              </span>
            )
          ) : (
            <span className="text-[#38bdf8] text-[11px] font-medium bg-[#38bdf8]/15 px-2 py-0.5 rounded-full border border-[#38bdf8]/30 animate-pulse">
              执行中…
            </span>
          )}
          {typeof toolMs === 'number' && toolMs >= 0 && (
            <span
              data-testid="tool-duration"
              className="text-[11px] font-mono text-[#64748b] bg-white/[0.05] px-1.5 py-0.5 rounded border border-white/10 shrink-0"
            >
              用时 {formatDuration(toolMs)}
            </span>
          )}
          <span className="text-[#64748b]">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
      </button>

      {/* 错误摘要：折叠时也看得见一行（醒目但克制） */}
      {isError && !expanded && (
        <p
          role="status"
          className="px-3.5 py-1.5 text-[11.5px] text-[#fda4af] bg-[#f43f5e]/10 border-t border-[#f43f5e]/25 truncate"
        >
          {errorSummary}
        </p>
      )}

      {expanded && (
        <div id={bodyId} className="px-3.5 pb-3.5 pt-2.5 border-t border-white/[0.06] bg-[#0c0f17] space-y-3">
          {toolArgs && (
            <section>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <h4 className="text-[11px] font-sans font-medium text-[#94a3b8]">
                  入参 (Arguments){argEntries ? ` · ${argEntries.length} 个字段` : ''}
                </h4>
                <div className="flex items-center gap-1.5">
                  {argEntries && (
                    <button
                      type="button"
                      onClick={() => setShowRawArgs((v) => !v)}
                      aria-pressed={showRawArgs}
                      aria-label={showRawArgs ? '切换到结构化入参视图' : '切换到原始 JSON 视图'}
                      className="min-h-[44px] px-3 rounded-xl text-[11.5px] font-medium text-[#94a3b8] hover:text-white bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] cursor-pointer studio-tap"
                    >
                      {showRawArgs ? '结构化' : '原始 JSON'}
                    </button>
                  )}
                  <CopyButton text={prettyJson(toolArgs)} label="复制工具入参" />
                </div>
              </div>
              {argEntries && !showRawArgs ? (
                <StructuredArgs entries={argEntries} />
              ) : (
                <TextBlock text={prettyJson(toolArgs)} tone="args" />
              )}
            </section>
          )}

          {toolResult && (
            <section>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <h4 className="text-[11px] font-sans font-medium text-[#94a3b8]">
                  {isError ? '错误输出 (Error)' : '结果 (Output)'} · {toolResult.length} 字符
                </h4>
                <CopyButton text={toolResult} label={isError ? '复制错误输出' : '复制工具结果'} />
              </div>
              <TextBlock text={prettyJson(toolResult)} tone={isError ? 'error' : 'result'} />
            </section>
          )}

          {!toolArgs && !toolResult && (
            <p className="text-[11.5px] text-[#64748b]">暂无参数与结果（等待远端返回）…</p>
          )}
        </div>
      )}
    </div>
  );
};