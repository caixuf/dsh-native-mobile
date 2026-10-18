import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronRight, EllipsisVertical, Folder, MessageSquare, Pin } from 'lucide-react';
import type { SessionRow } from '../../types';
import type { SessionActionId } from '../../lib/session-groups';
import { describeWorkspace, formatSessionTime, sessionActionItems } from '../../lib/session-groups';
import { SessionActionMenu } from './SessionActionMenu';

/**
 * 单条会话卡片。
 *
 * 结构上刻意拆成并列的按钮：
 *  - 主体按钮 = 打开会话（键盘 Enter/Space 可用，不再依赖 div onClick）；
 *  - 归档按钮 = 本机归档 / 恢复，`stopPropagation` 之外还避免了
 *    「按钮套按钮」这种读屏器会报错的嵌套；
 *  - 「⋯」/ 长按 / 右键 = 完整操作菜单（T6：重命名 / 复制 id / fork / 取消运行 / 归档）。
 *
 * 长按与"打开"的冲突：长按 500ms 后置 `longPressFired`，随后的 click 会被吞掉一次，
 * 否则用户长按弹出菜单的同时还会跳进会话。
 */

interface Props {
  session: SessionRow;
  onOpen: (session: SessionRow) => void;
  /** 已归档样式（灰一档）+ 按钮语义变为「恢复」。 */
  archived?: boolean;
  onArchive?: (session: SessionRow) => void;
  onUnarchive?: (session: SessionRow) => void;
  /** 是否星标置顶 */
  pinned?: boolean;
  onPin?: (session: SessionRow) => void;
  onUnpin?: (session: SessionRow) => void;
  /** 紧凑模式：子代理子节里用，省一点垂直空间。 */
  compact?: boolean;
  /** 是否在卡片底部显示工作区标签（跨工作区搜索时显示短名，平时由分组头说明）。默认 false */
  showWorkspace?: boolean;
  /**
   * 重命名（T6）。**可选**：不传则菜单里的「重命名」置灰。
   * 返回 promise 时组件会等结果，失败信息就地显示在菜单里。
   */
  onRename?: (session: SessionRow, title: string) => void | Promise<unknown>;
  /** 在电脑上分叉（session/fork）。不传则置灰。 */
  onFork?: (session: SessionRow) => void | Promise<unknown>;
  /** 取消运行（session/cancel）。仅 running 会话出现在菜单里。 */
  onCancel?: (session: SessionRow) => void | Promise<unknown>;
}

const LONG_PRESS_MS = 500;

/** 复制文本：优先 Clipboard API，退化到临时 textarea（http/旧 WebView 上仍可用）。 */
async function writeClipboard(text: string): Promise<void> {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    await nav.clipboard.writeText(text);
    return;
  }
  if (typeof document === 'undefined') throw new Error('当前环境没有剪贴板');
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
  document.body.removeChild(area);
  if (!copied) throw new Error('复制失败');
}

export const SessionCard: React.FC<Props> = ({
  session,
  onOpen,
  archived = false,
  onArchive,
  onUnarchive,
  pinned = false,
  onPin,
  onUnpin,
  compact = false,
  showWorkspace = false,
  onRename,
  onFork,
  onCancel,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // 先绑定成 const：TS 只在 const 上保留「已判空」的收窄，
  // 直接在闭包里用 props 会被还原成 `| undefined`。
  const renameHandler = onRename;
  const forkHandler = onFork;
  const cancelHandler = onCancel;
  const canToggleArchive = archived ? !!onUnarchive : !!onArchive;

  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const notify = (text: string, ok = true) => {
    setNotice({ ok, text });
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400);
  };

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const startLongPress = () => {
    clearLongPress();
    longPressFired.current = false;
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressFired.current = true;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  const handleOpen = () => {
    if (longPressFired.current) {
      // 长按刚弹过菜单：这一次 click 是长按的尾巴，不能顺带打开会话
      longPressFired.current = false;
      return;
    }
    onOpen(session);
  };

  const handleToggleArchive = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (archived) onUnarchive?.(session);
    else onArchive?.(session);
  };

  const copyId = async () => {
    try {
      await writeClipboard(session.sessionId);
      notify('已复制会话 id');
    } catch (err: unknown) {
      notify((err as Error)?.message || '复制失败', false);
    }
  };

  const runAction = async (fn: (() => void | Promise<unknown>) | undefined, okText: string) => {
    if (!fn) return;
    try {
      await fn();
      notify(okText);
    } catch (err: unknown) {
      notify((err as Error)?.message || '操作失败', false);
    }
  };

  const items = sessionActionItems(session, {
    archived,
    canRename: !!renameHandler,
    canFork: !!forkHandler,
    canCancel: !!cancelHandler,
    canCopyId: true,
    canArchive: !!onArchive,
    canUnarchive: !!onUnarchive,
    canPin: !!onPin || !!onUnpin,
    pinned,
  });

  const handleAction = (id: SessionActionId) => {
    setMenuOpen(false);
    if (id === 'copyId') {
      void copyId();
      return;
    }
    if (id === 'pin') {
      onPin?.(session);
      notify('已置顶会话');
      return;
    }
    if (id === 'unpin') {
      onUnpin?.(session);
      notify('已取消置顶');
      return;
    }
    if (id === 'fork') {
      void runAction(forkHandler ? () => forkHandler(session) : undefined, '已请求在电脑上分叉');
      return;
    }
    if (id === 'cancel') {
      void runAction(cancelHandler ? () => cancelHandler(session) : undefined, '已请求取消运行');
      return;
    }
    if (id === 'archive') {
      onArchive?.(session);
      return;
    }
    if (id === 'unarchive') {
      onUnarchive?.(session);
    }
  };

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl bg-white hover:bg-[#f9fafb] active:bg-[#f3f4f6] border border-gray-200/70 shadow-2xs transition-all ${
        compact ? 'p-2.5' : 'p-3'
      } ${archived ? 'opacity-60' : ''}`}
      data-session-id={session.sessionId}
      onTouchStart={startLongPress}
      onTouchEnd={clearLongPress}
      onTouchMove={clearLongPress}
      onTouchCancel={clearLongPress}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <div className="flex items-center gap-3">
        {/* 左侧：整洁的工作区/会话图标 */}
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
            session.running
              ? 'bg-blue-50 border-blue-200 text-blue-600'
              : session.isSubagent
                ? 'bg-purple-50 border-purple-200 text-purple-600'
                : 'bg-gray-50 border-gray-200/80 text-gray-600'
          }`}
        >
          {session.workspace ? <Folder size={17} /> : <MessageSquare size={17} />}
        </div>

        {/* 中间：标题与工作区/摘要 */}
        <button
          type="button"
          onClick={handleOpen}
          className="min-w-0 flex-1 text-left cursor-pointer"
          aria-label={`打开会话 ${session.title || session.sessionId}`}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {pinned && (
              <span className="shrink-0 flex items-center text-amber-500" title="已星标置顶" aria-label="已星标置顶">
                <Pin size={13} className="fill-amber-400/40 text-amber-500" />
              </span>
            )}

            <h3
              className={`min-w-0 truncate font-semibold tracking-tight text-gray-900 group-hover:text-black transition-colors ${
                compact ? 'text-[13.5px]' : 'text-[14.5px]'
              }`}
            >
              {session.title || '未命名会话'}
            </h3>

            {session.isSubagent && (
              <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.2 rounded-md bg-purple-50 text-purple-700 border border-purple-200/60">
                子代理
              </span>
            )}

            {session.running && (
              <span className="shrink-0 flex items-center gap-1 text-[10.5px] font-medium text-blue-600 bg-blue-50 px-2 py-0.2 rounded-full border border-blue-200/60">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping" />
                执行中
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-0.5 text-[12px] text-gray-500 truncate">
            {showWorkspace && session.workspace && (
              <>
                <span className="font-medium text-gray-700 truncate max-w-[140px]">
                  {describeWorkspace(session.workspace).label}
                </span>
                <span>·</span>
              </>
            )}
            <span className="truncate">
              {session.preview || describeWorkspace(session.workspace || '').label || '暂无内容'}
            </span>
          </div>
        </button>

        {/* 右侧：单行时间 + 单个操作菜单按钮，比例极简均衡 */}
        <div className="flex flex-col items-end justify-between shrink-0 self-stretch py-0.5">
          <span className="text-[11px] font-mono text-gray-400 whitespace-nowrap">
            {formatSessionTime(session.updatedAt)}
          </span>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(true);
            }}
            aria-label={`更多操作 ${session.title || session.sessionId}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="更多操作（重命名 / 复制 id / fork / 取消运行 / 归档）"
            data-testid="session-card-more"
            className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-gray-100 text-gray-400 hover:text-gray-800 transition-colors cursor-pointer studio-tap"
          >
            <EllipsisVertical size={14} />
          </button>
        </div>
      </div>

      {notice && (
        <p
          role="status"
          className={`mt-2 px-2 py-1 rounded-lg text-[11.5px] ${
            notice.ok
              ? 'text-[#34d399] bg-[#10b981]/10 border border-[#10b981]/20'
              : 'text-[#f87171] bg-[#ef4444]/10 border border-[#ef4444]/20'
          }`}
        >
          {notice.text}
        </p>
      )}

      {menuOpen && (
        <SessionActionMenu
          session={session}
          items={items}
          onAction={handleAction}
          onClose={() => setMenuOpen(false)}
          onSubmitRename={renameHandler ? (title) => renameHandler(session, title) : undefined}
        />
      )}
    </div>
  );
};