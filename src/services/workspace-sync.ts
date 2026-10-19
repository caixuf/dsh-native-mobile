/**
 * 官方归档 / 置顶状态（与电脑端双向同步）。
 *
 * ## 为什么替换掉原来的「本机归档」
 *
 * 原实现把归档 id 存在**手机 localStorage**（`dsh.sessions.archived.v1`），
 * UI 上如实标注「仅本机归档 · 主机无 archive 接口」。那句注释在写的时候是对的
 * （`session/*` 命名空间里确实没有 archive），但它**漏看了另一端**：
 * DSH 的归档能力在 **`workspace` 命名空间**里 ——
 *
 *   workspace/archiveSession     { request: { sessionId, stopActivity? } }
 *   workspace/unarchiveSession   { request: { sessionId } }
 *   workspace/pinSession         { request: { sessionId } }
 *   workspace/unpinSession      { request: { sessionId } }
 *   workspace/follow             （**流式**，无参数）→ baseline{ items, archivedSessionIds, pinnedSessionIds }
 *
 * 2026-10-19 实测确认这条链路是通的：
 *   archiveSession → workspace/follow 立刻在 archivedSessionIds 里读到它 →
 *   unarchiveSession → 又从集合里消失。
 *
 * 所以现在两边共用**同一份**归档集合（持久化在电脑的
 * `<DSH_HOME>/storages/workspace.json`），电脑上归档的手机上立刻消失，反之亦然。
 *
 * ## 三个必须遵守的边界
 *
 * 1. **`workspace/follow` 是流，不是 RPC**
 *    它走 mux 的 `open` 帧，第一帧是 `baseline`，之后是 `replace`/`upsert` 增量。
 *    当普通 RPC 调用只会拿到 `gateway/arguments-invalid`（实测）。
 *
 * 2. **不能用外部工具改 `workspace.json`**
 *    DSH 进程持有内存状态并会写回磁盘 —— 外部写入会被下一次写入覆盖
 *    （2026-10-19 实测：写了 19 个归档，进程一操作就变回 0）。
 *    必须走 API。
 *
 * 3. **流断开要重连**
 *    手机切后台/断网时 baseline 会停更；重连后才能拿到电脑端最新归档状态。
 */

import type { DshConnection } from './connection';

/** 从 baseline 帧解析出来的状态。 */
export interface WorkspaceState {
  /** 已归档的会话 id（电脑端权威集合）。 */
  archivedSessionIds: string[];
  /** 已置顶的会话 id。 */
  pinnedSessionIds: string[];
}

export const EMPTY_WORKSPACE_STATE: WorkspaceState = {
  archivedSessionIds: [],
  pinnedSessionIds: [],
};

/**
 * 订阅官方 workspace 状态。
 *
 * @param conn 已连接的网关连接
 * @param onState 每次 baseline/增量到达时回调（完整状态，不是补丁）
 * @returns 取消订阅函数
 */
export function subscribeWorkspaceState(
  conn: DshConnection,
  onState: (state: WorkspaceState) => void,
  onError?: (err: unknown) => void,
): () => void {
  let closed = false;
  let stream: { streamId: string; close: () => void } | null = null;

  const handleValue = (value: Record<string, unknown>) => {
    if (closed) return;
    const frame = value as { type?: string; value?: Record<string, unknown> };
    if (!frame || typeof frame.type !== 'string') return;

    // baseline 与 replace 都是**完整状态**；upsert 是单个工作区变化，
    // 不影响归档/置顶集合，直接忽略即可。
    if (frame.type === 'baseline' || frame.type === 'replace') {
      const v = (frame.value || {}) as {
        archivedSessionIds?: unknown;
        pinnedSessionIds?: unknown;
      };
      const asIds = (x: unknown): string[] =>
        Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
      onState({
        archivedSessionIds: asIds(v.archivedSessionIds),
        pinnedSessionIds: asIds(v.pinnedSessionIds),
      });
    }
  };

  try {
    // workspace/follow 是**流**：open 帧 + baseline/item 帧，不能当 RPC 调。
    // ⚠️ openStream 内部已经会包成 `payload:{args}`，这里必须传**扁平**的 args；
    //    再包一层会变成 `{args:{args:{}}}`，主机会回 gateway/arguments-invalid。
    const handle: { streamId: string; close: () => void } = conn.openStream(
      'workspace/follow',
      {},
      {
        onItem: (value) => handleValue(value),
        onError: (err) => {
          if (!closed) onError?.(err);
        },
      },
    );
    stream = handle;
  } catch (err) {
    onError?.(err);
  }

  return () => {
    closed = true;
    try {
      stream?.close();
    } catch {
      /* 关闭失败不影响取消语义 */
    }
  };
}

/** 归档一个会话（写回电脑，双向同步）。 */
export async function archiveSession(conn: DshConnection, sessionId: string, stopActivity = false): Promise<boolean> {
  try {
    const res = await conn.call('workspace/archiveSession', {
      request: stopActivity ? { sessionId, stopActivity: true } : { sessionId },
    });
    return Boolean((res as { ok?: boolean })?.ok);
  } catch {
    return false;
  }
}

/** 取消归档。 */
export async function unarchiveSession(conn: DshConnection, sessionId: string): Promise<boolean> {
  try {
    const res = await conn.call('workspace/unarchiveSession', { request: { sessionId } });
    return Boolean((res as { ok?: boolean })?.ok);
  } catch {
    return false;
  }
}

/** 置顶（电脑端同源）。 */
export async function pinSession(conn: DshConnection, sessionId: string): Promise<boolean> {
  try {
    const res = await conn.call('workspace/pinSession', { request: { sessionId } });
    return Boolean((res as { ok?: boolean })?.ok);
  } catch {
    return false;
  }
}

/** 取消置顶。 */
export async function unpinSession(conn: DshConnection, sessionId: string): Promise<boolean> {
  try {
    const res = await conn.call('workspace/unpinSession', { request: { sessionId } });
    return Boolean((res as { ok?: boolean })?.ok);
  } catch {
    return false;
  }
}
