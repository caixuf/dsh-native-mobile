import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  CircleStop,
  Copy,
  GitFork,
  LoaderCircle,
  Pencil,
  X,
} from 'lucide-react';
import type { SessionRow } from '../../types';
import type { SessionActionId, SessionActionItem } from '../../lib/session-groups';
import { SESSION_ACTION_LABELS } from '../../lib/session-groups';

/**
 * 会话操作菜单（T6）：长按 / 右键 / 「⋯」打开。
 *
 * 为什么是**底部弹层 + portal**而不是卡片内的绝对定位下拉：
 *  1. 卡片用的是 `.specular-card-interactive`，它带 `backdrop-filter: blur(16px)`
 *     且 hover 时有 `transform` —— 两者都会成为 fixed/absolute 后代的**包含块**，
 *     卡片自身的 `overflow-hidden` 还会把下拉裁掉半截（真机上是"点开了一半的菜单"）；
 *  2. 手机端底部弹层的点击目标更大，拇指够得着。
 * 因此这里用 `react-dom` 的 `createPortal`（**已有依赖**，main.tsx 早就在用，
 * 不是新增运行时依赖）把菜单挂到 body 上。
 *
 * 职责边界：菜单只负责「呈现 + 重命名输入」，具体动作交给调用方；
 * `rename` 由菜单自己切成输入态，其余 id 一律回调 `onAction`。
 */

interface Props {
  session: SessionRow;
  items: SessionActionItem[];
  /** 非 rename 的动作回调（菜单会把 rename 自己消化掉）。 */
  onAction: (id: SessionActionId) => void;
  onClose: () => void;
  /**
   * 提交重命名（返回 promise 时显示 pending / 失败信息）。
   * 缺省 = 重命名不可用（此时 rename 条目应为 disabled）。
   */
  onSubmitRename?: (title: string) => void | Promise<unknown>;
}

const ICON_CLASS = 'shrink-0';

function ActionIcon({ id }: { id: SessionActionId }) {
  switch (id) {
    case 'rename':
      return <Pencil size={16} className={ICON_CLASS} />;
    case 'copyId':
      return <Copy size={16} className={ICON_CLASS} />;
    case 'fork':
      return <GitFork size={16} className={ICON_CLASS} />;
    case 'cancel':
      return <CircleStop size={16} className={ICON_CLASS} />;
    case 'archive':
      return <Archive size={16} className={ICON_CLASS} />;
    case 'unarchive':
      return <ArchiveRestore size={16} className={ICON_CLASS} />;
    default:
      return null;
  }
}

export const SessionActionMenu: React.FC<Props> = ({
  session,
  items,
  onAction,
  onClose,
  onSubmitRename,
}) => {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title || '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const submitRename = async () => {
    if (!onSubmitRename) return;
    const next = draft.trim();
    if (!next) {
      setError('标题不能为空');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmitRename(next);
      onClose();
    } catch (err: unknown) {
      setError((err as Error)?.message || '重命名失败');
      setPending(false);
    }
  };

  const handleItem = (item: SessionActionItem) => {
    if (item.disabled) return;
    if (item.id === 'rename') {
      setRenaming(true);
      setError(null);
      return;
    }
    onAction(item.id);
  };

  const shell = (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation">
      <button
        type="button"
        aria-label="关闭会话操作菜单"
        onClick={onClose}
        className="absolute inset-0 bg-black/65 backdrop-blur-md cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`会话操作：${session.title || session.sessionId}`}
        data-testid="session-action-menu"
        className="relative w-full max-w-md mx-auto rounded-t-3xl specular-card p-4 pb-[calc(1.5rem+var(--sab))] shadow-2xl border-t border-black/[0.08] animate-in slide-in-from-bottom-4 duration-200"
      >
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-black/[0.08]">
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-[#18181b] truncate">
              {session.title || '未命名会话'}
            </p>
            <p className="text-[11px] font-mono text-[#52525b] truncate">{session.sessionId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 w-8 h-8 rounded-lg bg-black/[0.05] hover:bg-black/[0.06] border border-black/[0.08] flex items-center justify-center text-[#52525b] hover:text-[#18181b] transition-colors cursor-pointer studio-tap"
          >
            <X size={15} />
          </button>
        </div>

        {renaming ? (
          <div className="pt-3">
            <label className="block text-[12px] font-medium text-[#52525b] mb-1.5" htmlFor="dsh-rename-input">
              会话标题
            </label>
            <input
              id="dsh-rename-input"
              type="text"
              autoFocus
              value={draft}
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitRename();
                }
              }}
              className="w-full px-3.5 py-2.5 text-[13.5px] bg-[#141824] border border-black/[0.08] rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#52525b] disabled:opacity-60"
            />
            {error && <p className="mt-2 text-[12px] text-[#f87171]">{error}</p>}
            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setRenaming(false);
                  setDraft(session.title || '');
                  setError(null);
                }}
                className="px-4 py-2 text-[13px] font-medium text-[#52525b] hover:text-[#18181b] rounded-xl transition-colors cursor-pointer disabled:opacity-60"
              >
                取消
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void submitRename()}
                className="flex items-center gap-1.5 px-5 py-2 text-[13px] font-semibold text-white bg-gradient-to-r from-[#3b82f6] to-[#2563eb] rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.35)] transition-transform cursor-pointer studio-tap disabled:opacity-60"
              >
                {pending && <LoaderCircle size={14} className="animate-spin" />}
                保存
              </button>
            </div>
          </div>
        ) : (
          <div role="menu" aria-label="会话操作" className="pt-2">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.reason || SESSION_ACTION_LABELS[item.id]}
                data-action={item.id}
                onClick={() => handleItem(item)}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-[14px] transition-colors ${
                  item.disabled
                    ? 'text-[#475569] cursor-not-allowed'
                    : item.danger
                      ? 'text-[#fca5a5] hover:bg-[#ef4444]/12 cursor-pointer studio-tap'
                      : 'text-[#3f3f46] hover:bg-black/[0.05] cursor-pointer studio-tap'
                }`}
              >
                <ActionIcon id={item.id} />
                <span className="flex-1 min-w-0 truncate">{item.label}</span>
                {item.disabled && <span className="shrink-0 text-[11px] text-[#475569]">未接线</span>}
                {item.id === 'copyId' && !item.disabled && <Copy size={13} className="shrink-0 text-[#475569]" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const canPortal = typeof document !== 'undefined' && !!document.body;
  return canPortal ? createPortal(shell, document.body) : shell;
};