import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Database, Layers } from 'lucide-react';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  activity: string | null;
  usage: string | null;
  context: string | null;
  detail: Array<{ label: string; value: string }>;
}

const LABEL_TEXT = 'text-[#52525b]';

export const SessionStatsBar: React.FC<Props> = ({ activity, usage, context, detail }) => {
  const [open, setOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const hasAny = Boolean(activity || usage || context);

  /** 右侧还有没被看到的读数？滑到底就收起渐隐提示。 */
  const syncOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 2);
  }, []);

  useEffect(() => {
    syncOverflow();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(syncOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncOverflow, activity, usage, context]);

  if (!hasAny) return null;

  const handleToggle = () => {
    triggerHaptic('selection');
    setOpen((v) => !v);
  };

  const seg = (label: string, value: string | null, icon?: React.ReactNode) =>
    value ? (
      <span className="inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap text-[11px]">
        {icon}
        {label && <span className={`${LABEL_TEXT} shrink-0 font-medium`}>{label}</span>}
        <span className="text-[#18181b] font-mono font-medium">{value}</span>
      </span>
    ) : null;

  return (
    <div
      className="w-full bg-white/95 border-b border-gray-100 backdrop-blur-md px-4 py-1.5 transition-all select-none"
      data-testid="session-stats"
    >
      <div className="max-w-2xl mx-auto">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-label={open ? '收起会话性能统计' : '展开会话性能统计明细'}
          className="w-full flex items-center justify-between gap-3 text-left py-1 px-2.5 rounded-lg bg-[#f4f4f6] hover:bg-gray-200 border border-gray-200/60 transition-colors cursor-pointer"
        >
          <div className="relative flex-1 min-w-0">
            <div
              ref={scrollerRef}
              onScroll={syncOverflow}
              className="flex items-center gap-3 overflow-x-auto no-scrollbar py-0.5"
            >
              {seg('', activity, <Gauge size={12} className="text-blue-600 shrink-0" />)}
              {activity && (usage || context) && <span className="text-[#52525b] shrink-0">·</span>}
              {seg('', usage, <Database size={12} className="text-indigo-600 shrink-0" />)}
              {usage && context && <span className="text-[#52525b] shrink-0">·</span>}
              {seg('上下文', context, <Layers size={11} className="text-purple-600 shrink-0" />)}
            </div>
            {more && (
              <span
                aria-hidden="true"
                data-testid="session-stats-fade"
                className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[#f4f4f6] to-transparent"
              />
            )}
          </div>
          {detail.length > 0 && (
            <span className={`flex items-center gap-1 text-[10.5px] ${LABEL_TEXT} hover:text-gray-900 shrink-0 pl-1`}>
              <span>{open ? '收起' : '明细'}</span>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>

        {open && detail.length > 0 && (
          <dl
            data-testid="session-stats-detail"
            className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-xl bg-white border border-gray-200 shadow-xs animate-in fade-in-50 duration-150"
          >
            {detail.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-2 min-w-0">
                <dt className="text-[11px] text-[#52525b] truncate">{d.label}</dt>
                <dd className="text-[11px] text-[#18181b] font-mono shrink-0 font-medium">{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
};

export default SessionStatsBar;