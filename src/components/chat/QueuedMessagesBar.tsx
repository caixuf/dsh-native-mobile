import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, ListOrdered, RefreshCw, X } from 'lucide-react';
import type { QueuedMessage } from '../../lib/message-queue';
import { resequence } from '../../lib/message-queue';

interface Props {
  /** 队列投影（由 App 维护；只有 id/text/createdAt 时也能正常工作）。 */
  queued: QueuedMessage[];
  /** 任务是否在执行中：决定"等待发送 / 队列就绪"的提示文案。 */
  running?: boolean;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}

/**
 * 待发消息条（紧凑，位于输入框上方）。
 *
 * 验收要点：
 * - 序号由 `resequence()` 现算 —— **出队后自动重排**，不留空洞；
 * - 失败项醒目但不刺眼：rose 描边 + 一行错误原因 + "重试"；
 * - 原文可展开看全（默认 1 行截断，长文本不挤压输入区）；
 * - 所有按钮 ≥44px 且 aria-label 齐备（触控 / 读屏）。
 */
export const QueuedMessagesBar: React.FC<Props> = ({ queued, running = false, onRemove, onRetry }) => {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const items = resequence(queued);
  if (items.length === 0) return null;

  const failed = items.filter((i) => i.status === 'failed').length;
  const toggle = (id: string) => setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <section
      aria-label="待发消息队列"
      className="mb-2 rounded-2xl border border-black/[0.08] bg-[#0d1017]/95 backdrop-blur-sm overflow-hidden shadow-lg"
    >
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-black/[0.06]">
        <ListOrdered size={13} className="text-[#38bdf8] shrink-0" />
        <span className="text-[11.5px] font-semibold text-[#3f3f46]">待发队列</span>
        <span className="text-[11px] text-[#52525b]">{items.length} 条</span>
        {failed > 0 && (
          <span className="text-[11px] font-medium text-[#fb7185]">
            {failed} 条失败（原文已保留）
          </span>
        )}
        <span className="ml-auto text-[11px] text-[#52525b]">
          {failed > 0 ? '请重试或删除' : running ? '任务结束后依次发送' : '等待发送'}
        </span>
      </header>

      <ul className="max-h-44 overflow-y-auto divide-y divide-black/[0.06]">
        {items.map((item) => {
          const isFailed = item.status === 'failed';
          const isOpen = Boolean(expandedIds[item.id]);
          return (
            <li key={item.id} role="listitem" className="flex items-start gap-2 px-2.5 py-2">
              <span
                aria-hidden="true"
                className={`mt-1 w-6 h-6 shrink-0 rounded-full text-[11px] font-bold flex items-center justify-center border ${
                  isFailed
                    ? 'bg-[#f43f5e]/15 border-[#f43f5e]/35 text-[#fb7185]'
                    : 'bg-[#3b82f6]/15 border-[#3b82f6]/35 text-[#60a5fa]'
                }`}
              >
                {item.seq}
              </span>

              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => toggle(item.id)}
                  aria-expanded={isOpen}
                  aria-label={isOpen ? `收起第 ${item.seq} 条待发消息` : `展开第 ${item.seq} 条待发消息`}
                  className="w-full min-h-[44px] py-1 text-left text-[13px] leading-snug text-[#3f3f46] hover:text-[#18181b] cursor-pointer studio-tap"
                >
                  <span className={isOpen ? 'whitespace-pre-wrap break-words' : 'block truncate'}>
                    {item.text}
                  </span>
                </button>

                {isOpen && (
                  <div className="flex items-center justify-end mt-1">
                    <span className="text-[10.5px] text-[#52525b]">
                      {item.text.length} 字符
                      {item.attempts ? ` · 已尝试 ${item.attempts} 次` : ''}
                    </span>
                  </div>
                )}

                {isFailed && (
                  <p className="flex items-center gap-1 mt-1 text-[11px] text-[#fb7185]" role="status">
                    <AlertCircle size={11} className="shrink-0" />
                    <span className="truncate">{item.error || '发送失败'}</span>
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {isFailed && onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(item.id)}
                    aria-label={`重试第 ${item.seq} 条待发消息`}
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-[#fb7185] bg-[#f43f5e]/10 hover:bg-[#f43f5e]/20 border border-[#f43f5e]/30 cursor-pointer studio-tap"
                  >
                    <RefreshCw size={15} />
                  </button>
                )}
                {!isFailed && (
                  <span className="w-11 h-11 flex items-center justify-center text-[#10b981]/70" aria-hidden="true">
                    <CheckCircle2 size={14} />
                  </span>
                )}
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    aria-label={`删除第 ${item.seq} 条待发消息`}
                    className="w-11 h-11 rounded-xl flex items-center justify-center text-[#52525b] hover:text-[#18181b] bg-black/[0.04] hover:bg-black/[0.06] border border-black/[0.08] cursor-pointer studio-tap"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-1 px-3 py-1 border-t border-black/[0.06] text-[10.5px] text-[#52525b]">
        <ChevronUp size={11} aria-hidden="true" />
        <span>点标题可展开原文；</span>
        <ChevronDown size={11} aria-hidden="true" />
        <span>收起以保持输入区紧凑</span>
      </div>
    </section>
  );
};