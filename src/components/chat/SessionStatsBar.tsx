import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Database, Layers } from 'lucide-react';
import { triggerHaptic } from '../../utils/haptics';

/**
 * 会话统计栏 —— 顶部紧凑诊断指示条（对齐桌面版 `StatsPills.tsx`）。
 *
 * 手机端优化：
 *  - 锚定在顶部 Header 下方，绝不常驻在底部输入栏遮挡审批/操作按钮；
 *  - 紧凑单行胶囊设计，极小纵向高度（32px），超窄屏自然横滑；
 *  - 点击平滑展开完整指标面板（模型耗时、工具耗时、首字延迟、各 token 桶、上下文构成）；
 *  - 🔴 铁律：任一读数为 null 就整段不渲染，绝不显示 0 冒充真实值。
 *
 * 🔴 2026-10-16 修复：读数**不许被视觉截断**。
 *    旧实现给每段加了 `min-w-0` + `truncate`，而外层是 `flex` —— 三段在 412px 视口下
 *    被 flex 一起压缩（实测值 span：clientW 79 / scrollW 154、84 / 163、**0 / 33**），
 *    于是屏幕上显示的是 `22 轮 392 …`、`99.7M tok · …`，第三段的数字**整段塌成 0 宽**
 *    只剩「上下文」两个字，而 `overflow-x-auto` 因为内容已被压扁，`scrollWidth` 恰好
 *    等于 `clientWidth`，**横滑从未真正发生**。
 *    更隐蔽的是：`text-overflow: ellipsis` 只做视觉裁剪，`innerText` 仍是全文 ——
 *    所以"断言文本包含 xxx"的测试全绿，用户看到的却是一片省略号。
 *    现在：分段 `shrink-0 + whitespace-nowrap` 保住固有宽度，容器 `flex-1 min-w-0`
 *    真正可横滑；溢出时右侧给一道渐隐提示"还有内容"，滑到底自动消失。
 *    回归测试在 `scripts/e2e-app-ui.mjs` 的 stats 场景第 3 步（查 ellipsis 元素的
 *    `scrollWidth > clientWidth`，旧的文本断言抓不到这一类）。
 *
 * 📐 对比度（按 WCAG 2.1 AA，11px 属正文级 → 需 ≥ 4.5:1；背景取实际叠加后的 #121420）：
 *    读数 `#94a3b8` = 7.8:1 ✓；标签与「明细」提示原为 `#64748b` = **4.26:1 ✗**，
 *    已改为 `#7a8ba0` = 5.7:1 ✓。明细面板里的标签不用改（底是 black/40，实测 4.6:1）。
 */
interface Props {
  activity: string | null;
  usage: string | null;
  context: string | null;
  detail: Array<{ label: string; value: string }>;
}

/** 标签/提示色：`#64748b` 在 `#121420` 上只有 4.26:1，不达 11px 的 4.5:1 门槛。 */
const LABEL_TEXT = 'text-[#7a8ba0]';

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
    // 读数一变宽度就变，必须重新量（否则新数字溢出时提示不出现）
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
        <span className="text-[#94a3b8] font-mono">{value}</span>
      </span>
    ) : null;

  return (
    <div
      className="w-full bg-[#0d111c]/90 border-b border-white/[0.06] backdrop-blur-md px-4 py-1.5 transition-all select-none"
      data-testid="session-stats"
    >
      <div className="max-w-2xl mx-auto">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-label={open ? '收起会话性能统计' : '展开会话性能统计明细'}
          className="w-full flex items-center justify-between gap-3 text-left py-1 px-2.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] transition-colors cursor-pointer studio-tap"
        >
          <div className="relative flex-1 min-w-0">
            <div
              ref={scrollerRef}
              onScroll={syncOverflow}
              className="flex items-center gap-3 overflow-x-auto no-scrollbar py-0.5"
            >
              {seg('', activity, <Gauge size={12} className="text-[#38bdf8] shrink-0" />)}
              {activity && (usage || context) && <span className="text-[#334155] shrink-0">·</span>}
              {seg('', usage, <Database size={12} className="text-[#818cf8] shrink-0" />)}
              {usage && context && <span className="text-[#334155] shrink-0">·</span>}
              {seg('上下文', context, <Layers size={11} className="text-[#a78bfa] shrink-0" />)}
            </div>
            {more && (
              <span
                aria-hidden="true"
                data-testid="session-stats-fade"
                className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[#121420] to-transparent"
              />
            )}
          </div>
          {detail.length > 0 && (
            <span className={`flex items-center gap-1 text-[10.5px] ${LABEL_TEXT} hover:text-[#94a3b8] shrink-0 pl-1`}>
              <span>{open ? '收起' : '明细'}</span>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>

        {open && detail.length > 0 && (
          <dl
            data-testid="session-stats-detail"
            className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 px-3 py-2.5 rounded-xl bg-black/40 border border-white/[0.08] animate-in fade-in-50 duration-150"
          >
            {detail.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-2 min-w-0">
                <dt className="text-[11px] text-[#64748b] truncate">{d.label}</dt>
                <dd className="text-[11px] text-[#cbd5e1] font-mono shrink-0">{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
};

export default SessionStatsBar;