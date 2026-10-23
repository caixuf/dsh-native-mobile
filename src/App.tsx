import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { HostRecord, LinkState, SessionRow, ChatLine, PendingPrompt, ModelCatalog, PromptQuestion } from './types';
import { HostStore } from './services/store';
import { ThemeStore } from './services/theme';
import { DshConnection } from './services/connection';
import type { HostRequestItem } from './services/connection';
import { PairingClient } from './services/pairing';
import { Envelopes } from './services/envelopes';
import { NativeBridge } from './services/native-bridge';
import type { NativeRelayStatus } from './services/native-bridge';
import {
  applyFollowLines,
  eventToLines,
  eventsToLines,
  fetchChatPage,
  mergePageLines,
  recordsToLines,
  sessionAddress,
} from './lib/session-page';
import type { RawSessionEvent } from './lib/session-page';
import { applyActivityEvent, buildActivity, emptyActivity } from './lib/session-activity';
import type { ActivityState } from './lib/session-activity';
import { buildReadouts, pickProjections } from './lib/session-stats';
import type { SessionProjections } from './lib/session-stats';
import {
  applySessionRename,
  buildForkedSession,
  inferDefaultCwd,
  readArchivedIds,
  readPinnedIds,
  setArchivedId,
  togglePinnedId,
  writeArchivedIds,
  writePinnedIds,
} from './lib/session-groups';
import { currentDeviceName, getOrCreateDeviceId, uniqueDeviceName } from './services/device';
import { archiveSession, pinSession, subscribeWorkspaceState, unarchiveSession, unpinSession } from './services/workspace-sync';
import { HostsScreen } from './components/screens/HostsScreen';
import { PairScreen } from './components/screens/PairScreen';
import { SessionsScreen } from './components/screens/SessionsScreen';
import { ChatScreen } from './components/screens/ChatScreen';
import { AppDrawer } from './components/drawer/AppDrawer';
import { UserCenterModal } from './components/common/UserCenterModal';

type Route = 'hosts' | 'pair' | 'sessions' | 'chat';

/** 排队等待发送的指令（任务运行中时用户仍可继续输入）。 */
interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: number;
  image?: { data: string; mediaType: string };
  status?: 'pending' | 'failed';
  error?: string;
  attempts?: number;
}

/** 连续失败到这个次数就停止自动重试，留在队列里等用户手动处理。 */
const MAX_QUEUE_ATTEMPTS = 5;

/**
 * 设备唯一名。
 *
 * 网关按 `platform + name` 合并设备记录 —— 如果每台手机都叫 "Web Remote Client"，
 * 两台手机会**互相顶下线**（用户实测过）。用一个持久化的短 id 做后缀，天然区分，
 * 且不需要改网关（改网关要重启 DSH，会杀掉当前会话）。
 */
const DEVICE_NAME = (() => {
  try {
    return currentDeviceName('Web Remote Client');
  } catch {
    // localStorage 不可用（隐私模式/SSR）时退回默认名，绝不让 App 起不来。
    return 'Web Remote Client';
  }
})();

/** 用户可能在输入框里改设备名；无论如何都补上唯一后缀，避免覆盖成同名。 */
const withDeviceSuffix = (name: string): string => {
  try {
    return uniqueDeviceName(name || 'Web Remote Client', getOrCreateDeviceId());
  } catch {
    return name || 'Web Remote Client';
  }
};

// `session.page` 的记录类型由 lib/session-page.ts 定义（那里也是构造请求的地方），
// 这里不再重复声明 —— 之前重复过一次，结果两边的字段漂移，类型检查才发现。

import { localizedText } from './utils/i18n';

export const App: React.FC = () => {
  const [route, setRoute] = useState<Route>('chat');
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [linkState, setLinkState] = useState<LinkState>({ type: 'disconnected' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sessions state
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [subagentSessions, setSubagentSessions] = useState<SessionRow[]>([]);
  /** 远端搜索结果：独立于 sessions，避免覆盖本地列表（见 handleSearchSessions）。 */
  const [searchResults, setSearchResults] = useState<SessionRow[]>([]);
  const [currentSession, setCurrentSession] = useState<SessionRow | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Chat state
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ provider?: string; model?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [sending, setSending] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [preparingStep, setPreparingStep] = useState(0);

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 原生后台审批通道的状态（Android 中继服务 / Electron 主进程）
  const [relayStatus, setRelayStatus] = useState<NativeRelayStatus | null>(null);

  /** 待处理审批所属的会话（真主机审批载荷里带 sessionId，用于"跳过去处理"）。 */
  const [promptSessionId, setPromptSessionId] = useState<string | null>(null);
  /**
   * 上面那个 id 的 ref 镜像。
   *
   * 为什么需要：onRequest 的回调只在连接建立时注册一次，闭包里的 state 是**首次渲染
   * 那一版**的。轮次结束的兜底判断要读最新的 promptSessionId，只能走 ref。
   */
  const promptSessionIdRef = useRef<string | null>(null);
  promptSessionIdRef.current = promptSessionId;

  /** 网页端的鉴权失效（401/403 分流后的状态，见 connection.ts）。 */
  const [authFailure, setAuthFailure] = useState<{ status: number; message: string } | null>(null);

  /** 连接相位（T8 新增，与既有 LinkState 并存）：offline 时发送会落进落盘待发队列。 */
  const [linkPhase, setLinkPhase] = useState<'online' | 'connecting' | 'offline' | 'auth-failed'>(
    'connecting',
  );
  /** 落盘待发队列的规模（离线也能发，重连后自动 flush）。 */
  const [outbox, setOutbox] = useState<{ pending: number; failed: number }>({ pending: 0, failed: 0 });

  /** 运行中排队的指令（发送失败会退回队首并计数）。 */
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);

  /** 一次性提示（离线入队等），比 error 轻，几秒后自动消失。 */
  const [notice, setNotice] = useState<string | null>(null);

  /** 聊天页的读取错误（子代理读不到、网络失败等）——必须让用户看见，不能只 console.warn。 */
  const [chatError, setChatError] = useState<string | null>(null);
  /** 新建会话后的一次性提示（告诉用户会话建在哪个工作区、什么时候电脑端才看得见）。 */
  const [createNotice, setCreateNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  /** 本机归档的会话 id（真主机没有 archive 端点，UI 已如实标注"仅本机归档"）。 */
  const [archivedIds, setArchivedIds] = useState<string[]>(() => {
    try {
      return readArchivedIds(localStorage);
    } catch {
      return [];
    }
  });

  /**
   * 官方归档状态订阅（电脑端权威集合）。
   *
   * 与电脑共用一份：电脑归档 → 手机上消失；手机归档 → 电脑上也归档。
   * 旧实现是手机 localStorage 的「本机归档」，两边永远对不上。
   */
  const workspaceUnsubRef = useRef<null | (() => void)>(null);

  /** 卸载/断连时关掉 workspace/follow 流，避免连接断开后还在攒回调。 */
  const closeWorkspaceSubscription = useCallback(() => {
    try {
      workspaceUnsubRef.current?.();
    } catch {
      /* 关闭失败不影响语义 */
    }
    workspaceUnsubRef.current = null;
  }, []);

  /**
   * 主动重新对齐归档/置顶集合。
   *
   * 🔴 2026-10-20 修正：这里原来是个**空函数**（只有 `void conn;`）。
   * 当时我假设"订阅是流式的，baseline 一到就同步"，但实际有两个漏洞：
   *   ① 订阅只在 `ready` 时建立一次；如果那次建立失败（流未就绪/主机忙），
   *      归档集合就**永远**是 localStorage 里的旧值 —— 表现为「手机点归档没反应」；
   *   ② 归档操作成功后没有任何"再对齐"，多端并发时本地状态会和电脑端漂移。
   *
   * 现在改为：**重新开一次 workspace/follow 订阅**，等 baseline 到达即完成对齐。
   * 用短超时兜底，避免主机不推 baseline 时把调用方挂死。
   */
  const refreshWorkspaceState = useCallback(async () => {
    const conn = connRef.current;
    if (!conn) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          unsub();
        } catch {
          /* ignore */
        }
        resolve();
      };
      const unsub = subscribeWorkspaceState(
        conn,
        (state) => {
          setArchivedIds(state.archivedSessionIds);
          setPinnedIds(state.pinnedSessionIds);
          try {
            writeArchivedIds(state.archivedSessionIds, localStorage);
            writePinnedIds(state.pinnedSessionIds, localStorage);
          } catch {
            /* 缓存写不下不影响界面 */
          }
          finish();
        },
        () => finish(),
      );
      // 主机没推 baseline 时不要把调用方挂死（4s 后放行）
      setTimeout(finish, 4000);
    });
  }, []);

  /** 订阅 workspace/follow（每次 ready 都要重新订阅）。 */
  const subscribeWorkspace = useCallback((conn: DshConnection) => {
    closeWorkspaceSubscription();
    workspaceUnsubRef.current = subscribeWorkspaceState(
      conn,
      (state) => {
        setArchivedIds(state.archivedSessionIds);
        setPinnedIds(state.pinnedSessionIds);
        try {
          writeArchivedIds(state.archivedSessionIds, localStorage);
          writePinnedIds(state.pinnedSessionIds, localStorage);
        } catch {
          /* 缓存写不下不影响界面 */
        }
      },
      (err) => {
        // 不刷错误条：workspace/follow 失败不该挡住主功能（会话列表仍可用）
        console.warn('[workspace/follow] 归档状态同步失败：', err);
      },
    );
  }, [closeWorkspaceSubscription]);

  /** 本机星标置顶的会话 id（置顶后在工作区组内排在最前）。 */
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return readPinnedIds(localStorage);
    } catch {
      return [];
    }
  });
  const [userCenterOpen, setUserCenterOpen] = useState(false);

  const connRef = useRef<DshConnection | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  /** 流事件防抖定时器（见 handleStreamTick）。 */
  const streamReloadRef = useRef<number | null>(null);
  /** 事件回调只在连接时注册一次，必须用 ref 读"当前"的会话与路由，避免闭包过期。 */
  const currentSessionRef = useRef<SessionRow | null>(null);
  const routeRef = useRef<Route>('sessions');

  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  // Mobile Soft Keyboard visualViewport dynamics
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const updateViewport = () => {
      // ⚠️ 不能用 `window.innerHeight - vv.height`：Android WebView 开 adjustResize 时
      // innerHeight 未必跟着缩，这个差值会把**整个键盘高度**算进来；而输入坞是
      // `fixed bottom-0`（位置已随视口上移），再加一次就把输入坞顶到屏幕中间
      // —— 真机实测就是那个悬浮在键盘上方、中间一大片空白的画面。
      // 改成量"布局视口底部"与"可视视口底部"的真实差值：视口缩过时≈0，
      // 键盘浮在视口上（没缩）时=键盘高度，两种形态都对。
      const layoutBottom = document.documentElement.clientHeight;
      const visualBottom = vv.height + vv.offsetTop;
      const keyboardHeight = Math.max(0, Math.round(layoutBottom - visualBottom));
      document.documentElement.style.setProperty('--keyboard-inset-bottom', `${keyboardHeight}px`);
    };
    vv.addEventListener('resize', updateViewport);
    vv.addEventListener('scroll', updateViewport);
    updateViewport();
    return () => {
      vv.removeEventListener('resize', updateViewport);
      vv.removeEventListener('scroll', updateViewport);
    };
  }, []);

  // Load hosts on initial mount
  useEffect(() => {
    ThemeStore.applyTheme();
    const loaded = HostStore.all();
    setHosts(loaded);
    const active = HostStore.getActiveId();
    setActiveHostId(active);

    setRelayStatus(NativeBridge.status());

    if (active) {
      startHostConnection(active);
    } else if (loaded.length === 0) {
      setRoute('pair');
    }
  }, []);

  const startHostConnection = (hostId: string) => {
    const record = HostStore.find(hostId);
    if (!record) return;

    if (connRef.current) {
      connRef.current.stop();
    }

    const conn = new DshConnection(record.baseUrl, record.token, record.label, {
      lanUrls: record.lanAddresses,
      preferredLanUrl: record.lanUrl,
      connectionMode: record.connectionMode ?? 'auto',
      onActiveUrlChange: (activeUrl) => {
        HostStore.updateActiveUrl(record.id, activeUrl);
        setHosts(HostStore.all());
        const published = NativeBridge.publishConnection(activeUrl, record.token, record.label);
        if (published) setRelayStatus(published);
      },
    });
    connRef.current = conn;

    // 换主机/重连：旧的实时流属于旧连接，必须显式关掉
    closeFollow();

    // 把凭据交给原生壳：Android 由前台服务在后台守着审批通道（WebView 一旦切后台
    // 就会被挂起，靠网页自己守不住）；普通浏览器里这是安全的空操作。
    const initialBaseUrl = conn.getEffectiveBaseUrl();
    const published = NativeBridge.publishConnection(initialBaseUrl, record.token, record.label);
    if (published) setRelayStatus(published);

    conn.onStateChange((state) => {
      setLinkState(state);
      if (state.type === 'ready') {
        loadSessions(conn);
        loadModelCatalog(conn);
        // 官方归档/置顶状态：连上就订阅一次（流式 baseline 推完整集合）。
        // 断线重连会再次触发 ready，所以这里每次都要重新订阅并关掉旧的。
        subscribeWorkspace(conn);
        const cands = conn.getLanCandidates();
        if (cands.length > 0) {
          HostStore.updateNetwork(record.id, {
            lanAddresses: cands,
            activeUrl: conn.getEffectiveBaseUrl(),
          });
          setHosts(HostStore.all());
        }
      }
    });

    conn.onRequest((req: HostRequestItem) => {
      // 🔴 cancel 必须在这里显式分流。
      // 它的 answerable=false（不是"待应答"，而是"这条待办作废了"），于是原来
      // 会落到下面的 handleStreamTick 分支 —— handleHostRequest 里那段 cancel 处理
      // 是**永远进不去的死代码**。实测症状：AI 明明结束了，手机上的提问一直挂着。
      // 判据用 method 而非 answerable，因为 cancel 恰好就是 answerable=false。
      if (req.method === 'cancel' || req.method.includes('cancel')) {
        handleHostRequest(req);
        return;
      }
      if (req.answerable) {
        handleHostRequest(req);
        return;
      }
      // 非应答事件 = 主机推来的 emit（运行态 / 活动时间戳）
      handleStreamTick(req);
    });

    // 401/403 与"网络抖动"必须分开：前者重试一万次也不会成功。
    // 这里把状态交给顶部横幅，并提示用户重新配对（不静默、不无限重试）。
    conn.onAuthFailure((info) => {
      setAuthFailure({ status: info.status, message: info.message });
    });

    // 应答没送达要能看见 —— 否则用户以为批了、主机还在等。
    conn.onRespondFailure((info) => {
      console.warn('应答未送达', info);
      setError(`审批应答未送达：${info.message}`);
    });

    // 连接相位 + 落盘待发队列规模（离线时发送不再直接失败）
    conn.onPhaseChange((phase) => setLinkPhase(phase));
    conn.onOutboxChange((snapshot) =>
      setOutbox({ pending: snapshot.pending, failed: snapshot.failed }),
    );

    conn.start();
  };

  const loadModelCatalog = async (conn = connRef.current) => {
    if (!conn) return;
    try {
      const res = (await conn.call('session/modelCatalog', {})) as ModelCatalog;
      if (res && res.groups) {
        setModelCatalog(res);
        if (res.default) {
          setSelectedModel(res.default);
        }
      }
    } catch (err) {
      console.warn('Failed to load model catalog', err);
    }
  };

  const handleSelectModel = async (provider: string, model: string) => {
    if (!currentSession || !connRef.current) return;
    try {
      await connRef.current.call('session/selectModel', {
        request: {
          sessionId: currentSession.sessionId,
          provider,
          model,
        },
      });
      setSelectedModel({ provider, model });
    } catch (err) {
      console.warn('Failed to select model', err);
      setError(`切换模型失败: ${(err as Error)?.message || '未知错误'}`);
    }
  };

  const handleHostRequest = (req: HostRequestItem) => {
    // 🔴 关键修复（Issue #2）：处理主机发来的 cancel 取消帧
    if (req.method === 'cancel' || req.method.includes('cancel') || (req.payload as Record<string, unknown>)?.type === 'cancel') {
      const cancelId = req.rpcId || ((req.payload as Record<string, unknown>)?.eventId as string | undefined);
      if (!cancelId || pendingPrompt?.rpcId === cancelId) {
        setPendingPrompt(null);
        setPromptSessionId(null);
      }
      return;
    }
    if (!req.answerable) return;
    const isApproval = req.method.includes('approval');
    const rawQuestions = req.payload.questions as Array<{
      id?: string;
      header?: string;
      question?: string;
      detail?: string;
      multiSelect?: boolean;
      options?: Array<{ label?: string; description?: string } | string>;
    }> | undefined;
    const questions: PromptQuestion[] | undefined = rawQuestions?.map((q, idx) => ({
      id: q.id || `q-${idx}`,
      question: q.question || '',
      header: q.header,
      detail: q.detail,
      multiSelect: q.multiSelect,
      options: (q.options || [])
        .map((o) =>
          typeof o === 'string' ? { label: o } : { label: o.label || '', description: o.description },
        )
        .filter((o) => Boolean(o.label)),
    }));
    const qFirst = questions?.[0];

    const title = isApproval
      ? '工具调用需要批准'
      : qFirst?.header || qFirst?.question || '需要你确认';

    // 🔴 displayReason 是多语言对象 {en, zh}（真主机实测），不是字符串。
    // 旧写法 String(...) 会渲染成 "[object Object]"。
    const reason = isApproval
      ? localizedText(req.payload.displayReason) || localizedText(req.payload.reason)
      : '';
    const body = isApproval
      ? reason || `工具调用: ${String(req.payload.toolName || '未知工具')}`
      : qFirst?.question || JSON.stringify(req.payload, null, 2);

    const options = qFirst?.options?.map((o) => o.label || '').filter(Boolean) || [];

    // 审批/提问载荷里找 sessionId（真主机字段可能在顶层、request、address、params 等多处），
    // 确保用户不在聊天页时点击"去处理"必定能跳到对应的会话。
    const p = (req.payload || {}) as Record<string, unknown>;
    const reqObj = ((p.request as Record<string, unknown> | undefined) || p) as Record<string, unknown>;
    const addrObj = ((p.address as Record<string, unknown> | undefined) ||
      (reqObj.address as Record<string, unknown> | undefined) ||
      {}) as Record<string, unknown>;
    const pParams = (p.params as Record<string, unknown> | undefined) || {};

    const sessionId =
      (typeof p.sessionId === 'string' && p.sessionId.trim()) ||
      (typeof reqObj.sessionId === 'string' && reqObj.sessionId.trim()) ||
      (typeof addrObj.sessionId === 'string' && addrObj.sessionId.trim()) ||
      (typeof p.session_id === 'string' && p.session_id.trim()) ||
      (typeof reqObj.session_id === 'string' && reqObj.session_id.trim()) ||
      (typeof p.targetSessionId === 'string' && p.targetSessionId.trim()) ||
      (typeof pParams.sessionId === 'string' && (pParams.sessionId as string).trim()) ||
      currentSessionRef.current?.sessionId ||
      sessions.find((s) => s.running)?.sessionId ||
      sessions[0]?.sessionId ||
      null;

    setPendingPrompt({
      rpcId: req.rpcId,
      method: req.method,
      title,
      body,
      options,
      questionId: qFirst?.id,
      approval: isApproval,
      questions,
      multiSelect: qFirst?.multiSelect,
    });
    setPromptSessionId(sessionId);

    // 桌面壳：窗口可能正藏在托盘里，网页根本不在看 —— 由主进程发系统通知。
    // （Android 由前台服务自己发带按钮的通知，不经这里。）
    NativeBridge.notifyApproval({
      eventId: req.rpcId,
      title,
      body,
      kind: isApproval ? 'approval' : 'question',
      // 桌面壳靠 sessionId 把窗口跳到出事的会话；Android 侧不需要（通知按钮直接回执）。
      sessionId,
    });
  };

  /**
   * `$events` 上的推送（emit）。
   *
   * 两条用途：
   *   1. **权威运行态**：`api-session/status` 的 args 是 `[sessionId, running]` ——
   *      真主机主动推的运行标记，比轮询 `session.list` 准也省。
   *   2. 没有实时流时（follow 失败/未订阅）退回**防抖重取会话**。
   */
  const handleStreamTick = (req?: HostRequestItem) => {
    const payload = req?.payload as { event?: string; args?: unknown[] } | undefined;
    const eventName = payload?.event || req?.method || '';

    if (eventName === 'api-session/status' && Array.isArray(payload?.args)) {
      const [sid, runningNow] = payload.args as [unknown, unknown];

      // 🔴 兜底：提问所属的会话**在后台**结束（用户可能停在会话列表，
      // currentSessionRef 对不上，下面那段只覆盖"正在看的那条会话"）→ 收起待办。
      // 主机发 cancel 是主路径；这条覆盖主机没发 cancel 的情况。
      if (typeof sid === 'string' && runningNow !== true && sid === promptSessionIdRef.current) {
        setPendingPrompt(null);
        setPromptSessionId(null);
      }

      if (typeof sid === 'string' && sid === currentSessionRef.current?.sessionId) {
        const next = runningNow === true;
        setRunning(next);
        // 轮次结束：统计数字这时才最终（decodeTokens/工具耗时都在收尾时结算）
        if (!next) {
          const current = currentSessionRef.current;
          if (current) void loadChatPage(current);
          void loadProjections(sid);
          // 🔴 关键修复（Issue #2）：会话结束时，自动清理挂住未清的 pendingPrompt
          setPendingPrompt(null);
          setPromptSessionId(null);
        }
      }
    }

    // 已经订阅了实时流就不必再轮询刷新（省 RPC，也避免和流抢渲染）
    if (followRef.current) return;

    if (streamReloadRef.current !== null) return; // 已在防抖窗口内
    streamReloadRef.current = window.setTimeout(() => {
      streamReloadRef.current = null;
      if (routeRef.current !== 'chat') return;
      const session = currentSessionRef.current;
      if (session) void loadChatPage(session);
    }, 800);
  };

  const loadSessions = async (conn = connRef.current) => {
    if (!conn) return;
    setSessionsLoading(true);
    try {
      const res = (await conn.call('session.list', { _request: {} })) as {
        items?: Array<{
          sessionId?: string;
          origin?: string;
          parentSessionId?: string | null;
          running?: boolean;
          updatedAt?: number;
          cwd?: string;
          projections?: {
            values?: {
              title?: string;
              preview?: string;
              cwd?: string;
            };
          };
        }>;
      };

      const items = res?.items || [];
      const regular: SessionRow[] = [];
      const subagents: SessionRow[] = [];

      for (const item of items) {
        if (!item.sessionId) continue;
        const vals = item.projections?.values;
        const isSub = item.origin === 'subagent';
        const row: SessionRow = {
          sessionId: item.sessionId,
          title: vals?.title || '未命名会话',
          preview: vals?.preview || '',
          updatedAt: item.updatedAt || Date.now(),
          running: !!item.running,
          isSubagent: isSub,
          parentSessionId: item.parentSessionId,
          workspace: vals?.cwd || item.cwd || null,
        };

        if (isSub) {
          subagents.push(row);
        } else {
          regular.push(row);
        }
      }

      setSessions(regular);
      setSubagentSessions(subagents);
    } catch (err: unknown) {
      console.warn('Failed to load sessions', err);
    } finally {
      setSessionsLoading(false);
    }
  };

  const loadChatPage = async (session: SessionRow | null, conn = connRef.current) => {
    if (!conn || !session) return;
    try {
      // 🔴 读会话记录有两个坑，都会造成「能打开会话、记录永远空白」且不报错到用户眼前：
      //     ① address 必须带 kind（否则 boundary validation）
      //     ② throughSeq 不能写死大值（主机报 "past cursor N"，要拿它重试）
      // 两者的请求构造/错误处理抽在 lib/session-page.ts，由
      // scripts/test-session-page.mjs 钉死（含真主机原文报文）。
      const res = await fetchChatPage((method, args) => conn.call(method, args), session);

      // 🔴 切会话竞态：请求飞在路上时用户可能已经切走，
      // 旧会话的记录会短暂写进新会话的界面（真机实测串台 2–3 秒）。
      if (currentSessionRef.current?.sessionId !== session.sessionId) return;

      const records = res?.records || [];
      // 映射规则（只渲染对话事件 / 跳过 reasoning / user 走 data.content）统一在
      // lib/session-page.ts 里，实时流与历史翻页**共用同一套**，避免两条路漂移。
      const lines = recordsToLines(records) as ChatLine[];
      // 同样走"择多保留"：若 follow 快照已经铺了更多内容，别被这次翻页削短。
      const kept = mergePageLines(chatLinesRef.current, lines);
      commitLinesNow(kept);
      setChatError(null);
    } catch (err) {
      // 🔴 F4：不能再只 console.warn。
      // 子代理会话在当前主机上**无法通过 session.page 读取**（实测 8 种 address 形状全被拒：
      // `kind:'subagent'` 不在 wire schema 里；用 `kind:'session'` 则要求 subagent delivery）。
      // 旧实现把异常吞掉，用户点进去只看到**空聊天页且没有任何错误** —— 又一次静默失败。
      console.warn('Failed to fetch chat page', err);
      const message = (err as Error)?.message ?? '未知错误';
      setChatError(
        session.isSubagent
          ? `子代理会话在当前主机上无法直接读取（主机要求 subagent delivery）：${message}。请打开它的父会话查看。`
          : `读取会话记录失败：${message}`,
      );
      if (currentSessionRef.current?.sessionId === session.sessionId) {
        cancelScheduledLines();
        setChatLines([]);
      }
    }
  };

  const handleSelectHost = (hostId: string) => {
    setActiveHostId(hostId);
    HostStore.setActiveId(hostId);
    startHostConnection(hostId);
    setRoute('sessions');
  };

  const handleAddDemo = () => {
    const demo = HostStore.addDemoHost();
    const updated = HostStore.all();
    setHosts(updated);
    setActiveHostId(demo.id);
    HostStore.setActiveId(demo.id);
    startHostConnection(demo.id);
    setRoute('sessions');
  };

  const handleDisconnectHost = () => {
    if (connRef.current) {
      connRef.current.stop();
      connRef.current = null;
    }
    // 断连时关掉 workspace/follow 流，否则重连后会挂两条订阅
    closeWorkspaceSubscription();
    setLinkState({ type: 'disconnected', reason: '已断开当前远程连接' });
    setSessions([]);
    setCurrentSession(null);
  };

  const handleForgetHost = (hostId: string) => {
    HostStore.remove(hostId);
    const updated = HostStore.all();
    setHosts(updated);
    if (activeHostId === hostId) {
      if (connRef.current) {
        connRef.current.stop();
        connRef.current = null;
      }
      // 忘记主机必须把原生侧的凭据与中继一并停掉，
      // 否则后台还挂着一个"守着别人的通道"的服务。
      NativeBridge.clearConnection();
      setRelayStatus(NativeBridge.status());
      setActiveHostId(updated[0]?.id || null);
      if (updated[0]) {
        startHostConnection(updated[0].id);
      } else {
        setRoute('pair');
      }
    }
  };

  const handleRenameHost = (hostId: string, label: string) => {
    HostStore.rename(hostId, label);
    setHosts(HostStore.all());
  };

  const handleLogin = async (
    baseUrl: string,
    user: string,
    pass: string,
    name: string,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const record = await PairingClient.login(baseUrl, user, pass, withDeviceSuffix(name));
      HostStore.upsert(record);
      setHosts(HostStore.all());
      setActiveHostId(record.id);
      startHostConnection(record.id);
      setRoute('sessions');
    } catch (err: unknown) {
      setError((err as Error).message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const handlePair = async (baseUrl: string, code: string, name: string) => {
    setBusy(true);
    setError(null);
    try {
      const record = await PairingClient.pair(baseUrl, code, withDeviceSuffix(name));
      HostStore.upsert(record);
      setHosts(HostStore.all());
      setActiveHostId(record.id);
      startHostConnection(record.id);
      setRoute('sessions');
    } catch (err: unknown) {
      setError((err as Error).message || '配对失败');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSession = (session: SessionRow) => {
    // 切会话就停止上一轮的跟踪，避免把 A 会话的轮询结果写进 B 会话
    stopTurnWatch();
    setRunning(session.running === true);
    setCurrentSession(session);
    setRoute('chat');
    // 先清空：否则上一会话的消息会短暂串台（真机实测 2–3 秒，F5）
    // ⚠️ 镜像也必须一起重置 —— "择多保留"只在**同一会话内**成立，
    // 带着上个会话的行去比较会让新会话一进来就显示旧内容（F5 回归）。
    // 同时取消还没刷上屏的旧帧，避免它在清空之后把上一会话画回来。
    commitLinesNow([]);
    setChatError(null);
    openFollow(session); // 实时流先行：它推的 snapshot 会把历史铺上
    loadChatPage(session); // 兜底：流没起来时至少还有历史
    setProjections({}); // 换会话先清空，别把上一轮的统计挂在新会话头上
    void loadProjections(session.sessionId);
    // 🔴 进入会话后校准运行态（2026-10-20 修）。
    // 上面 `setRunning(session.running)` 用的是**列表快照**，可能是一分钟前的数据。
    // 真机症状：电脑上任务早就结束了，手机打开这个会话却还显示「执行中」，
    // 而 startTurnWatch 只在"发消息之后"才启动，看历史时根本没有对账，
    // 于是一直卡在那个过期状态，直到用户再发一条消息。
    startRunningWatch(session.sessionId);
  };

  useEffect(() => stopTurnWatch, []);
  // 卸载时关掉实时流，别把订阅留在连接上
  useEffect(() => closeFollow, []);

  /**
   * 进入会话后的**运行态校准**（不依赖用户发消息）。
   *
   * 🔴 2026-10-20 真机问题：电脑上任务已经结束，手机打开那个会话仍显示「执行中」。
   * 根因：`handleOpenSession` 用列表快照 `session.running` 设置初始状态，
   * 而真正会刷新 running 的 `startTurnWatch` **只在发送消息后启动** ——
   * 纯浏览历史时没有任何对账，过期状态就一直挂着。
   *
   * 这里做一个轻量校准循环：
   *   · 每 3s 查一次 `session/list` 里该会话的 running；
   *   · **只在状态真的不同时才 setRunning**（避免无谓重渲染）；
   *   · 连续 3 次一致就停（稳定态不再打扰主机）；
   *   · 切会话/卸载时由 stopTurnWatch 统一停掉。
   */
  const runningWatchRef = useRef<number | null>(null);
  const stopRunningWatch = useCallback(() => {
    if (runningWatchRef.current !== null) {
      window.clearInterval(runningWatchRef.current);
      runningWatchRef.current = null;
    }
  }, []);

  const startRunningWatch = useCallback(
    (sessionId: string) => {
      stopRunningWatch();
      let ticks = 0;
      let stableStreak = 0;
      runningWatchRef.current = window.setInterval(() => {
        ticks += 1;
        const conn = connRef.current;
        // 上限 20 拍（约 60s）：足够覆盖"刚结束还在收尾"的窗口，又不会长期空转
        if (!conn || ticks > 20) {
          stopRunningWatch();
          return;
        }
        void (async () => {
          try {
            const res = (await conn.call('session/list', { _request: {} })) as {
              items?: Array<{ sessionId?: string; running?: boolean }>;
            };
            const row = res?.items?.find((i) => i.sessionId === sessionId);
            if (!row) return;
            const truth = row.running === true;
            setRunning((prev) => {
              if (prev === truth) {
                stableStreak += 1;
                // 连续几次和主机一致 → 认为稳定，停止校准（省 RPC）
                if (stableStreak >= 3) stopRunningWatch();
                return prev;
              }
              stableStreak = 0;
              return truth;
            });
          } catch {
            /* 下一拍再试 */
          }
        })();
      }, 3000);
    },
    [stopRunningWatch],
  );

  // 卸载时停掉校准循环
  useEffect(() => stopRunningWatch, [stopRunningWatch]);

  /**
   * 当前会话的**实时流**（`session/follow`）。
   *
   * 🔴 为什么必须有它（2026-10-15 真主机实测）：全局 `$events` **不含内容事件** ——
   * 它只推 `api-session/status`（sessionId, running）与 `api-session/activity` 这类粗粒度 emit。
   * 会话的逐事件进度只在按会话的 `session/follow` 上：
   *   先 `item:{type:'snapshot', cursor, records}`，之后每次变更推 `item:{type:'event', event}`。
   * 此前 App 只订阅 `$events`，所以界面必然表现为「卡一会儿 → 忽然出结果」。
   */
  const followRef = useRef<{ streamId: string; close: () => void } | null>(null);
  const lineKeysRef = useRef<Set<string>>(new Set());
  /** chatLines 的同步镜像：follow 快照与 loadChatPage 会并发写，需要比较"谁更全"。 */
  const chatLinesRef = useRef<ChatLine[]>([]);
  /**
   * 过程状态（"在干什么 + 干了多久"）。
   * 用 ref 保存真值 + 一个 tick 强制重渲染：事件到达很频繁，
   * 每次都 setState 一个新对象会让整棵时间线跟着重画，所以只推 tick。
   */
  const activityRef = useRef<ActivityState>(emptyActivity());
  /** tool/call 的 callId → 发起时刻（用于给每个工具算独立耗时）。 */
  const toolStartRef = useRef<Map<string, number>>(new Map());
  const [activityTick, setActivityTick] = useState(0);
  const activity = activityTick >= 0 ? activityRef.current : emptyActivity();
  /** 流式行提交与过程状态各合一帧，避免一条事件一次整页 setState。 */
  const linesFrameRef = useRef<number | null>(null);
  const activityFrameRef = useRef<number | null>(null);

  const cancelScheduledLines = () => {
    if (linesFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(linesFrameRef.current);
    }
    linesFrameRef.current = null;
  };

  /** 立刻提交（切会话、翻页、快照）。镜像同步更新，供择多保留比较。 */
  const commitLinesNow = (next: ChatLine[]) => {
    cancelScheduledLines();
    chatLinesRef.current = next;
    lineKeysRef.current = new Set(next.map((line) => line.key));
    setChatLines(next);
  };

  /**
   * 流式增量一帧最多提交一次。镜像立刻更新，翻页的择多保留
   * 看得到还没画上屏的更长历史。
   */
  const commitLinesSoon = (next: ChatLine[]) => {
    chatLinesRef.current = next;
    lineKeysRef.current = new Set(next.map((line) => line.key));
    if (typeof requestAnimationFrame !== 'function') {
      setChatLines(next);
      return;
    }
    if (linesFrameRef.current !== null) return;
    linesFrameRef.current = requestAnimationFrame(() => {
      linesFrameRef.current = null;
      setChatLines(chatLinesRef.current);
    });
  };

  /** 过程状态一帧最多刷一次。真值在 activityRef，tick 只让顶栏重画。 */
  const bumpActivity = () => {
    if (typeof requestAnimationFrame !== 'function') {
      setActivityTick((n) => n + 1);
      return;
    }
    if (activityFrameRef.current !== null) return;
    activityFrameRef.current = requestAnimationFrame(() => {
      activityFrameRef.current = null;
      setActivityTick((n) => n + 1);
    });
  };

  useEffect(() => {
    return () => {
      cancelScheduledLines();
      if (activityFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(activityFrameRef.current);
      }
    };
  }, []);

  /**
   * 会话统计（轮/步/tok-s、token 与缓存命中、上下文占用）。
   *
   * 数据源是真主机实测钉死的 `session/projections`，args 是**扁平**的
   * `{ request: { sessionId } }` —— 注意 `session/list` 里**没有**这些字段
   * （只有 title / sessionListMetadata），别再去列表里找。
   */
  const [projections, setProjections] = useState<SessionProjections>({});
  const readouts = buildReadouts(projections);

  /** 取一次统计；任何一个环节失败都保持旧值（宁可少显示，不要显示错的）。 */
  const loadProjections = async (sessionId: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const res = (await conn.call('session.projections', {
        request: { sessionId },
      })) as { value?: unknown } | null;
      setProjections(pickProjections(res?.value ?? res));
    } catch {
      /* 拿不到就保持上一次；UI 会因为字段缺失而隐藏对应读数 */
    }
  };

  const closeFollow = () => {
    followRef.current?.close();
    followRef.current = null;
  };

  const openFollow = (session: SessionRow) => {
    const conn = connRef.current;
    if (!conn) return;
    closeFollow();
    lineKeysRef.current = new Set();
    // 换会话要把过程状态清空，否则会显示上一轮残留的"第 N 步 / 分析中"
    activityRef.current = emptyActivity();
    toolStartRef.current = new Map();
    setActivityTick((n) => n + 1);
    followRef.current = conn.openStream(
      'session/follow',
      { request: { address: sessionAddress(session) } },
      {
        onItem: (value) => {
          // 切走之后到达的旧流帧必须丢弃
          if (currentSessionRef.current?.sessionId !== session.sessionId) return;
          const type = String(value.type || '');
          if (type === 'snapshot') {
            const records = (value.records as RawSessionEvent[]) || [];
            const lines = eventsToLines(records) as ChatLine[];
            // 🔴 空快照绝不清空界面；两份都非空时保留更长的一份。
            // 否则超大会话会出现"点开一片空白，但 session/page 明明 200 过"。
            if (lines.length > 0) {
              const kept = mergePageLines(chatLinesRef.current, lines);
              commitLinesNow(kept);
              activityRef.current = buildActivity(records);
              // 快照是历史事件：已结束的会话绝不能被历史快照篡改成 running=true
              if (session.running === true) {
                setRunning(true);
              } else {
                setRunning(false);
                if (activityRef.current) {
                  activityRef.current = {
                    ...activityRef.current,
                    phase: 'idle',
                    toolName: null,
                    thinking: null,
                  };
                }
              }
              setActivityTick((n) => n + 1);
            }
            setChatError(null);
            return;
          }
          if (type === 'event') {
            const event = value.event as RawSessionEvent;
            // 过程状态：每条事件都归约一次（分析中/调用工具/第 N 步…）
            // 顶栏一帧最多刷一次；不要为了状态把整份聊天记录再提交一遍。
            activityRef.current = applyActivityEvent(activityRef.current, event);
            bumpActivity();

            const evType = String(event?.type || '');
            if (
              evType === 'step/start' ||
              evType === 'tool/call' ||
              evType === 'turn/start' ||
              evType === 'agent/start'
            ) {
              setRunning(true);
            } else if (
              evType === 'turn/end' ||
              evType === 'session/complete' ||
              evType === 'run/finish' ||
              evType === 'session/idle' ||
              evType === 'cancel'
            ) {
              setRunning(false);
              activityRef.current = {
                ...activityRef.current,
                phase: 'idle',
                toolName: null,
                thinking: null,
              };
              bumpActivity();
            }

            // 每个工具的独立耗时：tool/call 记下时刻，tool/result 算出毫秒并写到那一行。
            // （只靠"当前工具"的时间算不出历史工具的耗时，必须按 callId 配对。）
            const callId = event?.data?.callId;
            const stamp = typeof event?.time === 'number' ? event.time : Date.now();
            if (callId && event.type === 'tool/call') {
              toolStartRef.current.set(callId, stamp);
            }

            // 同一 seq 的后续帧改写原行（流式正文），新 seq 才追加。
            const produced = eventToLines(event) as ChatLine[];
            let next = chatLinesRef.current;
            let changed = false;
            if (produced.length > 0) {
              const applied = applyFollowLines(next, produced, lineKeysRef.current);
              next = applied.lines;
              changed = applied.changed;
            }
            if (callId && event.type === 'tool/result') {
              const started = toolStartRef.current.get(callId);
              if (started !== undefined) {
                toolStartRef.current.delete(callId);
                const ms = Math.max(0, stamp - started);
                const lineKey = `line-${event.seq}`;
                let stamped = false;
                const patched = next.map((line) => {
                  if (line.key !== lineKey || line.toolMs === ms) return line;
                  stamped = true;
                  return { ...line, toolMs: ms };
                });
                if (stamped) {
                  next = patched;
                  changed = true;
                }
              }
            }
            if (changed) commitLinesSoon(next);
          }
        },
        onError: (error) => {
          // 子流挂了不能让页面空白：退回历史翻页 + 轮询兜底
          console.warn('[follow] session/follow 失败，退回轮询：', error);
          closeFollow();
          void loadChatPage(session);
          startTurnWatch(session);
        },
      },
    );
  };

  /**
   * 归档 / 取消归档 —— 走**官方 workspace 端点**，与电脑端双向同步。
   *
   * 🔴 2026-10-19 实测修正：旧实现把 id 存在手机 localStorage
   * （`dsh.sessions.archived.v1`），UI 上写「仅本机归档 · 主机无 archive 接口」。
   * 那句判断漏看了 `workspace` 命名空间 —— 归档能力就在那里：
   *   workspace/archiveSession / unarchiveSession / pinSession / unpinSession
   *   workspace/follow（流）→ baseline.archivedSessionIds
   * 实测：archiveSession → follow 立刻读到 → unarchiveSession → 集合减少，链路通。
   *
   * 现在两边共用同一份集合（电脑端 `<DSH_HOME>/storages/workspace.json`），
   * 电脑上归档的手机上立刻消失，反之亦然。
   *
   * ⚠️ 乐观更新：先本地改再发请求，失败则回滚 —— 归档是个高频小操作，
   *    等一个来回的网络延迟会导致点了没反应。
   */
  const applyArchive = (session: SessionRow, archived: boolean) => {
    const conn = connRef.current;
    const sid = session.sessionId;
    let rollback: string[] = [];
    setArchivedIds((prev) => {
      rollback = prev;
      const next = setArchivedId(prev, sid, archived);
      try {
        writeArchivedIds(next, localStorage);
      } catch {
        /* 本地缓存写不下不影响本次会话内的隐藏 */
      }
      return next;
    });
    // 没有连接时只能本地生效（例如离线查看），不假装同步成功
    if (!conn) {
      setCreateNotice({ kind: 'error', text: '未连接电脑，归档只在本次运行内生效' });
      return;
    }
    const task = archived ? archiveSession(conn, sid) : unarchiveSession(conn, sid);
    void task.then((ok) => {
      if (ok) {
        // 成功后重新对齐一次权威集合，纠正并发/多端操作
        void refreshWorkspaceState();
        // 归档成功也要给反馈：列表里那一行会移进「已归档」区，
        // 但用户很容易以为"点了没反应"（尤其是折叠状态下看不到移动）。
        setCreateNotice({
          kind: 'info',
          text: archived ? '已归档（与电脑同步）' : '已取消归档',
        });
      } else {
        setArchivedIds(rollback);
        try {
          writeArchivedIds(rollback, localStorage);
        } catch {
          /* ignore */
        }
        // 🔴 原来这里只调 setError，而 setError 的展示位在**聊天页**——
        // 归档动作发生在**会话列表页**，于是用户完全看不到失败原因，
        // 观感就是「点了没成功」。改用列表页自己的提示通道。
        setCreateNotice({
          kind: 'error',
          text: archived ? '归档失败：电脑端未接受' : '取消归档失败：电脑端未接受',
        });
      }
    });
  };

  /** 星标置顶 —— 同样走官方 pinSession/unpinSession，与电脑端同源。 */
  const handleTogglePin = (session: SessionRow) => {
    const conn = connRef.current;
    const sid = session.sessionId;
    setPinnedIds((prev) => {
      const next = togglePinnedId(prev, sid);
      try {
        writePinnedIds(next, localStorage);
      } catch {
        /* 存不下降级 */
      }
      return next;
    });
    if (!conn) return;
    const nowPinned = !pinnedIds.includes(sid);
    void (nowPinned ? pinSession(conn, sid) : unpinSession(conn, sid)).then((ok) => {
      if (ok) void refreshWorkspaceState();
    });
  };

  /**
   * 会话重命名（T6）。真网关实测：args 必须包 `{request:{sessionId,title}}`，
   * 少了 request 包裹会被边界校验拒（`missing "request"`）。
   */
  const handleRenameSession = async (session: SessionRow, title: string): Promise<void> => {
    const conn = connRef.current;
    const next = title.trim();
    if (!conn || !next) return;
    const res = (await conn.call('session.rename', {
      request: { sessionId: session.sessionId, title: next },
    })) as { title?: string } | undefined;
    const applied = res?.title || next;
    const stamp = Date.now();
    setSessions((prev) => applySessionRename(prev, session.sessionId, applied, stamp));
    setSubagentSessions((prev) => applySessionRename(prev, session.sessionId, applied, stamp));
    setCurrentSession((prev) =>
      prev && prev.sessionId === session.sessionId ? { ...prev, title: applied } : prev,
    );
  };

  /** 会话 fork（T6）：主机返回新 sessionId，插到列表顶部再刷新。 */
  const handleForkSession = async (session: SessionRow): Promise<void> => {
    const conn = connRef.current;
    if (!conn) return;
    const res = (await conn.call('session.fork', {
      request: { sessionId: session.sessionId },
    })) as { sessionId?: string } | undefined;
    const forked = res?.sessionId;
    if (!forked) throw new Error('主机没有返回新的会话 id');
    setSessions((prev) => [buildForkedSession(session, forked, Date.now()), ...prev]);
    void loadSessions();
  };

  /** 取消该会话正在跑的一轮（T6）；完成后刷新 running 标记。 */
  const handleCancelSession = async (session: SessionRow): Promise<void> => {
    const conn = connRef.current;
    if (!conn) return;
    await conn.call('session.cancel', { request: { sessionId: session.sessionId } });
    void loadSessions();
  };

  const handleCreateSession = async (cwd?: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      // 🔴 一定要挑一个**真工作区**，不能留空。
      // 实测（2026-10-15 活主机）：cwd 缺省时主机把会话丢进
      // `C:\Users\<user>\.dsh\profiles\desktop`，而桌面版是**按 Workspace 实体分组**的，
      // 落在 profile 目录的会话不属于任何工作区 → 在电脑上根本找不到。
      // 另外 `{ cwd: undefined }` 会被 JSON.stringify 丢掉、退化成 `{}`，所以必须显式填。
      const targetCwd = cwd && cwd.trim() ? cwd.trim() : inferDefaultCwd(sessions);
      const res = (await conn.call('session.create', {
        request: { cwd: targetCwd },
      })) as { sessionId?: string };

      const newId = res?.sessionId || 'session-' + Date.now();
      const newRow: SessionRow = {
        sessionId: newId,
        title: '新遥控会话',
        preview: '就绪',
        updatedAt: Date.now(),
        running: false,
        isSubagent: false,
        workspace: targetCwd,
      };

      setSessions([newRow, ...sessions]);
      handleOpenSession(newRow);
      setCreateNotice({
        kind: 'info',
        text: `已在「${targetCwd}」建会话。发出第一条消息后电脑端才会看到它（桌面版会隐藏还没说过话的空白会话）。`,
      });
    } catch (err) {
      console.warn('Failed to create session', err);
      setCreateNotice({ kind: 'error', text: '建会话失败：' + (err instanceof Error ? err.message : String(err)) });
    }
  };

  const handleSearchSessions = async (q: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const res = (await conn.call('session.search', {
        request: { query: q },
      })) as {
        items?: Array<{
          sessionId?: string;
          title?: string;
          snippet?: string;
          updatedAt?: number;
        }>;
      };

      if (res?.items) {
        // 🔴 不能再 setSessions(...)：那会把本地全量列表**覆盖**成搜索结果，
        // 于是远端结果被当成普通会话落进"未知工作区"组，而用户原本的会话全没了。
        // 搜索结果走独立 prop，由 SessionsScreen 单独成组置顶展示。
        setSearchResults(
          res.items.map((i) => ({
            sessionId: i.sessionId || '',
            title: i.title || '搜索结果',
            preview: i.snippet || '',
            updatedAt: i.updatedAt || Date.now(),
            running: false,
            isSubagent: false,
          })),
        );
      }
    } catch {
      loadSessions();
    }
  };

  /** 发送后跟踪本轮执行：轮询刷新 + 用主机权威的 running 标记决定何时停。 */
  const pollTimerRef = useRef<number | null>(null);

  const stopTurnWatch = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  /**
   * 发完指令后盯着这一轮，直到主机说它不跑了。
   *
   * 🔴 为什么不能只靠事件流刷新：实测（验证者的整 app 端到端第 9 步）
   * 新建会话里主机已经写了回复，**App 界面却一直不更新** ——
   * 只靠 emit 事件 + 发送后两次固定轮询（0/1.5s）根本覆盖不了真实生成耗时。
   *
   * 🔴 也不能因为有了 `session/follow` 就把它关掉：真机实测假主机不推
   * `api-session/status`，此时运行态只能靠轮询兜底，否则界面**永久卡在"执行中"**
   * （发送按钮变成"加入待发队列"，用户再也发不出去）。所以：
   *   - **运行态**：始终轮询（廉价、自愈，不依赖主机实现）
   *   - **内容**：follow 流在场时由流负责，没有流时才轮询翻页
   */
  const startTurnWatch = (session: SessionRow) => {
    stopTurnWatch();
    let ticks = 0;
    // 🔴 只在**见过 running=true 之后的 false**才算"这一轮结束"。
    // 踩过的坑：刚发完指令时主机可能还报 running=false（轮次尚未真正开始），
    // 一见 false 就停轮询 → 回复随后到达却再也没人取，界面永远停在"执行中"。
    let seenRunning = false;
    let falseStreak = 0;

    pollTimerRef.current = window.setInterval(() => {
      ticks += 1;
      const conn = connRef.current;
      if (!conn) {
        stopTurnWatch();
        return;
      }
      // 内容：实时流在场就别重复翻页（省 RPC，也避免和流抢渲染）
      if (!followRef.current) void loadChatPage(session);

      // 每两拍查一次主机的 running 标记（2s 一次；太慢会让"执行中"多挂十几秒）
      if (ticks % 2 === 0) {
        void (async () => {
          try {
            const res = (await conn.call('session.list', { _request: {} })) as {
              items?: Array<{ sessionId?: string; running?: boolean }>;
            };
            const row = res?.items?.find((i) => i.sessionId === session.sessionId);
            if (!row) return;
            if (row.running === true) {
              seenRunning = true;
              falseStreak = 0;
              return;
            }
            falseStreak += 1;
            // 真实转换（跑过再停），或一直没跑起来但已连续多次报 false（约 6s）
            if ((seenRunning && row.running === false) || falseStreak >= 3) {
              setRunning(false);
              void loadChatPage(session);
              stopTurnWatch();
            }
          } catch {
            /* 忽略：下一拍再试 */
          }
        })();
      }

      // 上限兜底：最长盯 5 分钟，避免异常情况下无限轮询
      if (ticks > 300) {
        setRunning(false);
        stopTurnWatch();
      }
    }, 1000);
  };

  const handleStartNewChat = () => {
    stopTurnWatch();
    closeFollow();
    setCurrentSession(null);
    commitLinesNow([]);
    setPendingPrompt(null);
    setPromptSessionId(null);
    setRoute('chat');
  };

  /**
   * 真正把一条指令发出去。
   *
   * @returns true=主机已接收；**false=没送到，调用方必须保留用户输入**。
   */
  const sendPromptNow = async (
    text: string,
    image?: { data: string; mediaType: string },
  ): Promise<boolean> => {
    if (!connRef.current) return false;

    // 🔴 如果当前没有会话（从 MiniMax 空白主页直接发问），自动在电脑上建会话
    let activeSession = currentSession;
    if (!activeSession) {
      try {
        const targetCwd = inferDefaultCwd(sessions);
        const res = (await connRef.current.call('session.create', {
          request: { cwd: targetCwd },
        })) as { sessionId?: string };
        const newId = res?.sessionId || 'session-' + Date.now();
        activeSession = {
          sessionId: newId,
          title: text.slice(0, 20) || '新遥控会话',
          preview: text.slice(0, 30),
          updatedAt: Date.now(),
          running: true,
          isSubagent: false,
          workspace: targetCwd,
        };
        setSessions((prev) => [activeSession!, ...prev]);
        setCurrentSession(activeSession);
        openFollow(activeSession);
      } catch (err) {
        console.error('Failed to auto create session for prompt', err);
        setError('创建新会话失败，请检查主机连接');
        return false;
      }
    }
    const sid = activeSession.sessionId;

    setSending(true);
    setPreparing(true);
    setPreparingStep(0);

    // Staged progression simulating remote desktop preparation
    if (advanceTimerRef.current) clearInterval(advanceTimerRef.current);
    let step = 0;
    advanceTimerRef.current = window.setInterval(() => {
      step++;
      if (step <= 3) {
        setPreparingStep(step);
      } else {
        if (advanceTimerRef.current) clearInterval(advanceTimerRef.current);
      }
    }, 700);

    try {
      const contentParts: Array<{ type: string; text?: string; data?: string; mediaType?: string }> = [];
      if (image && image.data) {
        contentParts.push({
          type: 'image',
          mediaType: image.mediaType || 'image/png',
          data: image.data,
        });
      }
      if (text) {
        contentParts.push({ type: 'text', text });
      }

      // 走 sendOrQueue：在线=直接发；离线/网络故障=**落盘排队**，重连后自动 flush。
      // 旧实现在断线时直接抛错 → 用户丢字（现在至少不会丢，且能看到待发条数）。
      const res = await connRef.current.sendOrQueue('session.prompt', {
        request: {
          requestId: 'req-' + Date.now(),
          sessionId: sid,
          mode: 'queue',
          content: contentParts,
        },
      });

      if (!res.delivered) {
        setPreparing(false);
        setSending(false);
        if (res.queued) {
          setNotice(`当前离线，已排入待发（共 ${connRef.current.outboxSize()} 条），连上后自动发送`);
          return true; // 已落盘：可以清空输入框
        }
        const why = res.reason === 'auth-failed' ? '设备令牌已失效，请重新配对' : res.error || '原因未知';
        setError(`指令未送达：${why}`);
        return false; // 保留草稿
      }

      setPreparing(false);
      setRunning(true);
      setSending(false);

      // Refresh chat；真正的实时更新靠事件流 + 下面的 turn watch
      loadChatPage(activeSession);
      startTurnWatch(activeSession);
      return true;
    } catch (err) {
      setPreparing(false);
      setSending(false);
      setError(`指令未送达：${(err as Error)?.message ?? '未知错误'}`);
      // 🔴 返回 false：ChatScreen 据此**保留草稿**。
      // 旧实现这里只 console.warn，而输入框早被清空 —— 用户丢字。
      return false;
    }
  };

  /**
   * 发送入口（ChatScreen 的 onSend）。
   *
   * 任务运行中时**不再禁用输入框**，而是排队 —— 这是 Kotlin 版修过、
   * 迁移到 Web 后丢掉的能力（见 docs/v0.2-handover.md §3）。
   */
  const handleSendPrompt = async (
    text: string,
    image?: { data: string; mediaType: string },
  ): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed && !image) return true; // 空消息不算失败，不该卡住草稿
    if (!currentSession || !connRef.current) return false;

    if (running) {
      setQueued((prev) => [
        ...prev,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: trimmed,
          createdAt: Date.now(),
          ...(image ? { image } : {}),
        },
      ]);
      return true;
    }

    return sendPromptNow(trimmed, image);
  };

  /** 上一轮跑完就自动把队首发出去；失败退回队首并计数，绝不静默丢弃。 */
  useEffect(() => {
    if (running || sending || queued.length === 0) return;
    const [next, ...rest] = queued;
    // 已连续失败到上限：留在队列里标成 failed，等用户手动重试/删除，
    // 不要无限自动重试（那是在主机忙时刷请求）。
    if ((next.attempts ?? 0) >= MAX_QUEUE_ATTEMPTS) {
      if (next.status !== 'failed') {
        setQueued([{ ...next, status: 'failed', error: `连续 ${MAX_QUEUE_ATTEMPTS} 次发送失败` }, ...rest]);
      }
      return;
    }
    const timer = window.setTimeout(() => {
      setQueued(rest);
      void sendPromptNow(next.text, next.image).then((ok) => {
        if (!ok) {
          const attempts = (next.attempts ?? 0) + 1;
          setQueued((prev) => [
            attempts >= MAX_QUEUE_ATTEMPTS
              ? { ...next, attempts, status: 'failed' as const, error: `连续 ${attempts} 次发送失败` }
              : { ...next, attempts, status: 'pending' as const },
            ...prev,
          ]);
        }
      });
    }, 1500);
    return () => window.clearTimeout(timer);
    // sendPromptNow 每次渲染都会重建，但它只依赖 ref 与 state，不必进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, sending, queued]);

  /** 删除队列项。 */
  const handleRemoveQueued = (id: string) => {
    setQueued((prev) => prev.filter((q) => q.id !== id));
  };

  /** 手动重试失败项：清零计数并置回队首（让上面那个 effect 立刻接手）。 */
  const handleRetryQueued = (id: string) => {
    setQueued((prev) => {
      const target = prev.find((q) => q.id === id);
      if (!target) return prev;
      const rest = prev.filter((q) => q.id !== id);
      return [{ ...target, attempts: 0, status: 'pending' as const, error: undefined }, ...rest];
    });
  };

  const handleCancelPrompt = async () => {
    if (!currentSession || !connRef.current) return;
    try {
      stopTurnWatch();
      setRunning(false);
      setSending(false);
      setPreparing(false);
      activityRef.current = {
        ...activityRef.current,
        phase: 'idle',
        toolName: null,
        thinking: null,
      };
      setActivityTick((n) => n + 1);

      await connRef.current.call('session.cancel', {
        request: { sessionId: currentSession.sessionId },
      });
      void loadProjections(currentSession.sessionId);
    } catch (err) {
      console.warn('Cancel failed', err);
      setError('停止任务失败：' + ((err as Error)?.message || '网络异常'));
    }
  };

  /**
   * 审批作答。
   *
   * 🔴 **`outcome` 只允许由 `Envelopes` 构造，不许在这里手写字面量。**
   * 主机的审批词表只有四个裸字符串（`allowed-once | rejected | cancelled | unavailable`），
   * 词表外的值**不报错、日志干净，而是被静默归一化成 `unavailable`（= 拒绝）** ——
   * 现象就是「用户点了允许，工具却被拒绝」，极难排查。
   * 这条约束由 `scripts/test-approval-contract.mjs` 钉死（含源码级扫描）。
   */
  const handleApprove = async (allow: boolean) => {
    if (!pendingPrompt || !connRef.current) return;
    const ok = await connRef.current.respond(
      pendingPrompt.rpcId,
      Envelopes.approvalOutcome(allow),
    );
    if (!ok) {
      // 没送达却关掉弹窗 = 用户以为批了、主机还在等。保持弹窗可重试，并如实报错。
      setError(allow ? '「允许」未送达电脑，请重试' : '「拒绝」未送达电脑，请重试');
      return;
    }
    setError(null);
    setPendingPrompt(null);
  };

  const handleAnswerOption = async (
    selected: string[] | string | Array<{ id: string; selected: string[]; text?: string }>,
    customText?: string,
  ) => {
    if (!pendingPrompt || !connRef.current) return;
    let outcome: Record<string, unknown>;
    if (Array.isArray(selected) && selected.length > 0 && typeof selected[0] === 'object') {
      outcome = Envelopes.multiQuestionOutcome(
        selected as Array<{ id: string; selected: string[]; text?: string }>,
      );
    } else {
      const selectedArr = Array.isArray(selected) ? (selected as string[]) : [selected as string];
      outcome = Envelopes.questionOutcome(
        pendingPrompt.questionId || (pendingPrompt.questions?.[0]?.id) || 'q1',
        selectedArr,
        customText,
      );
    }
    const ok = await connRef.current.respond(pendingPrompt.rpcId, outcome);
    if (!ok) {
      setError('回答未送达电脑，请重试');
      return;
    }
    setError(null);
    setPendingPrompt(null);
  };

  /**
   * 用户在桌面通知上做了决定。
   *
   * 🔴 `allow === null` 只表示「点了通知，把窗口拿到我面前」——
   * **不是同意**。把点击当批准，等于"用户只瞄了一眼，工具就执行了"。
   */
  useEffect(() => {
    return NativeBridge.onApprovalAction((decision) => {
      if (decision.allow === null) return;
      if (!pendingPrompt || decision.eventId !== pendingPrompt.rpcId) return;
      void handleApprove(decision.allow);
    });
    // handleApprove 每次渲染都会重建，但只有 pendingPrompt 变化时才需要重新订阅；
    // 回调里用 eventId 与当前待办比对，不会误伤。
  }, [pendingPrompt]);

  /**
   * Android 中继在通知栏把待办处理掉后，收起 App 里的弹窗。
   *
   * 没有这一步，用户会看到「通知栏点过允许了，App 里还挂着让我点」——
   * 于是怀疑到底批没批，甚至重复应答同一个 eventId。
   */
  useEffect(() => {
    if (!pendingPrompt) return;
    const eventId = pendingPrompt.rpcId;
    const timer = window.setInterval(() => {
      if (NativeBridge.isAnsweredElsewhere(eventId)) {
        setPendingPrompt(null);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pendingPrompt]);

  /**
   * 后台提醒能力缺失时必须让用户知道。
   *
   * 产品的核心承诺是「电脑端等你授权 → 手机立刻收到」。在普通浏览器里打开时
   * 这条承诺**不成立**（切后台就断连），静默地不成立比明说更糟。
   */
  const alertBanner: { text: string; onPress?: () => void } | null = (() => {
    // 鉴权失效优先级最高：连接本身都没了，后面的提醒都无意义。
    if (authFailure) {
      return {
        text: `登录状态已失效（HTTP ${authFailure.status}）：请在"我的电脑"里重新配对。`,
        onPress: () => setRoute('hosts'),
      };
    }
    // 聊天页读取失败（子代理读不到 / 网络失败）必须可见 —— 否则用户只看到空历史。
    if (chatError) {
      return { text: chatError, onPress: () => setChatError(null) };
    }
    // 离线：发送会落盘排队，重连后自动补发。点一下可立刻重试连接。
    if (linkPhase === 'offline') {
      return {
        text:
          outbox.pending > 0
            ? `当前离线：${outbox.pending} 条指令已排队，连上后自动发送。`
            : '当前离线：现在发送的指令会先排队，连上后自动发送。',
        onPress: () => {
          const ok = connRef.current?.retryNow() ?? false;
          if (!ok) setLinkPhase('connecting');
        },
      };
    }
    // 在线但队列里还有东西（上次断线留下的）—— 也要让用户看得见、能立刻补发。
    if (outbox.pending > 0 || outbox.failed > 0) {
      return {
        text:
          outbox.failed > 0
            ? `待发 ${outbox.pending} 条，另有 ${outbox.failed} 条发送失败。点这里立即重试。`
            : `有 ${outbox.pending} 条指令等待补发。点这里立即发送。`,
        onPress: () => {
          void connRef.current?.flushOutbox();
        },
      };
    }
    if (hosts.length === 0) return null;
    const platform = NativeBridge.platform();
    if (platform === 'web') {
      return {
        text: '当前在浏览器中打开：锁屏或切到后台后收不到审批提醒。要随时收到请在手机上安装 App。',
      };
    }
    if (!relayStatus) return null;
    if (relayStatus.state === 'auth-failed') {
      return {
        text: '后台审批通道已停止：设备令牌失效，请重新配对，否则电脑端等待授权时手机不会有任何提示。',
        onPress: () => setRoute('hosts'),
      };
    }
    if (relayStatus.configured && !relayStatus.notificationsEnabled) {
      return {
        text: '通知权限未开启：审批到了手机也不会提醒你。点这里去系统设置里允许通知。',
        // 真能跳系统设置页（壳提供）；桌面/浏览器里返回 false，点了也只是重试。
        onPress: () => {
          if (!NativeBridge.openNotificationSettings()) {
            setRelayStatus(NativeBridge.status());
          }
        },
      };
    }
    if (relayStatus.lastError) {
      return { text: `后台审批通道异常：${relayStatus.lastError}` };
    }
    return null;
  })();

  const activeHost = hosts.find((h) => h.id === activeHostId);

  /** 把连接状态上报给桌面壳：托盘 tooltip 与菜单据此显示。 */
  useEffect(() => {
    NativeBridge.reportRelayStatus({
      connected: linkState.type === 'ready',
      host: linkState.hostName || activeHost?.label,
      pending: pendingPrompt ? 1 : 0,
    });
  }, [linkState, activeHost?.label, pendingPrompt]);

  /** 桌面托盘菜单点了「重新连接」。 */
  useEffect(() => {
    return NativeBridge.onReconnectRequest(() => {
      if (activeHostId) startHostConnection(activeHostId);
    });
  }, [activeHostId]);

  const handleSetConnectionMode = (id: string, mode: 'auto' | 'lan' | 'wan') => {
    HostStore.setConnectionMode(id, mode);
    setHosts(HostStore.all());
    if (connRef.current && activeHostId === id) {
      connRef.current.setConnectionMode(mode);
    }
  };

  const handleProbeLan = async (id: string) => {
    if (connRef.current && activeHostId === id) {
      setNotice('正在探测局域网直连...');
      const ok = await connRef.current.switchToLanNow();
      if (ok) {
        setNotice('✅ 已成功切换至局域网高速通道！');
      } else {
        setNotice('未能探测到可用局域网服务，继续保持公网中继');
      }
      setTimeout(() => setNotice(null), 3000);
    }
  };

  /**
   * Android 壳的返回键。
   *
   * 🔴 之前真机上**在会话列表按返回会直接退出 App**（WebView 无历史 → super → finish）。
   * 现在由网页决定：抽屉开着先关抽屉；chat/pair/hosts 各回上一级；
   * 只有根页面（sessions）才返回 false 交给壳（壳会二次确认再退出）。
   */
  const backHandlerRef = useRef<() => boolean>(() => false);
  useEffect(() => {
    backHandlerRef.current = () => {
      if (drawerOpen) {
        setDrawerOpen(false);
        return true;
      }
      if (route === 'chat') {
        setRoute('sessions');
        return true;
      }
      if (route === 'pair') {
        setRoute(hosts.length > 0 ? 'hosts' : 'sessions');
        return true;
      }
      if (route === 'hosts') {
        setRoute('sessions');
        return true;
      }
      return false; // sessions：交给壳（首次提示、再按才退出）
    };
  });
  useEffect(() => {
    NativeBridge.installBackHandler(() => backHandlerRef.current());
  }, []);

  /** 把路由告诉壳，让它的返回键判定有依据。 */
  useEffect(() => {
    NativeBridge.setRoute({ route, drawerOpen });
  }, [route, drawerOpen]);

  /** 轻提示几秒后自动消失。 */
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** 点通知进来 → 跳到对应会话（壳会推，也可能需要网页主动取一次）。 */
  const deepLinkRef = useRef<(link: { eventId?: string; sessionId?: string }) => boolean>(() => false);
  useEffect(() => {
    deepLinkRef.current = (link) => {
      const sessionId = link?.sessionId;
      if (!sessionId) return false;
      let target = [...sessions, ...subagentSessions].find((s) => s.sessionId === sessionId);
      if (!target) {
        target = {
          sessionId,
          title: '待处理审批会话',
          workspace: '',
          preview: '',
          isSubagent: false,
          running: true,
          updatedAt: Date.now(),
        };
      }
      setPendingPrompt(null);
      if (target) {
        handleOpenSession(target);
      }
      return true;
    };
  }, [sessions, subagentSessions]);

  useEffect(() => {
    NativeBridge.installDeepLinkHandler((link) => deepLinkRef.current(link));
    const pending = NativeBridge.takePendingDeepLink();
    if (pending?.pending) deepLinkRef.current(pending);
  }, []);

  return (
    <div
      // 🔴 刘海/挖孔屏：targetSdk 35 在 Android 15+ 强制边到边，整页需让出上下安全区，
      // 否则标题栏被刘海压住、输入区被手势条压住（真机 RMX5200 / Android 17 实测）。
      className="flex h-screen w-screen overflow-hidden bg-white text-[#18181b] font-sans pt-[var(--sat)] pb-[var(--sab)]"
      data-safe-area="top-bottom"
    >
      {/* 自定义壁纸图层（由主题中心配置注入） */}
      <div
        className="fixed inset-0 pointer-events-none z-0 bg-cover bg-center transition-all duration-300"
        style={{
          backgroundImage: 'var(--custom-bg-image, none)',
          opacity: 'var(--custom-bg-opacity, 0)',
          filter: 'blur(var(--custom-bg-blur, 0px))',
        }}
      />

      {/* App Drawer */}
      <AppDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeHostName={linkState.hostName || activeHost?.label || 'caixuf.Windows'}
        isHostOnline={linkState.type === 'ready'}
        sessions={sessions}
        currentSessionId={currentSession?.sessionId}
        onSelectSession={(s) => {
          handleOpenSession(s);
          setDrawerOpen(false);
        }}
        onNewSession={() => {
          handleStartNewChat();
          setDrawerOpen(false);
        }}
        onManageHosts={() => {
          setRoute('hosts');
          setDrawerOpen(false);
        }}
        onOpenUserCenter={() => setUserCenterOpen(true)}
      />

      {/* MiniMax User Center Modal (Screenshot 2) */}
      <UserCenterModal
        isOpen={userCenterOpen}
        onClose={() => setUserCenterOpen(false)}
        username={linkState.hostName ? linkState.hostName.split('.')[0] : 'caixuf'}
        hostName={linkState.hostName || activeHost?.label || 'caixuf.Windows'}
        isOnline={linkState.type === 'ready'}
        onManageHosts={() => {
          setUserCenterOpen(false);
          setRoute('hosts');
        }}
        onDisconnect={() => {
          handleDisconnectHost();
          setUserCenterOpen(false);
          setRoute('hosts');
        }}
      />

      {/* Main Screen Router */}
      <main className="flex-1 h-full overflow-hidden flex flex-col relative">
        {/* 顶部横幅栈：流式自然排布，绝不遮挡下层屏幕的标题栏与操作按钮 */}
        {Boolean((pendingPrompt && route !== 'chat') || alertBanner || notice) && (
          <div className="shrink-0 z-40 flex flex-col shadow-md">
            {pendingPrompt && route !== 'chat' && (
              <button
                type="button"
                onClick={() => {
                  const targetId =
                    promptSessionId ||
                    sessions.find((s) => s.running)?.sessionId ||
                    currentSession?.sessionId ||
                    sessions[0]?.sessionId;

                  let target = targetId
                    ? [...sessions, ...subagentSessions].find((s) => s.sessionId === targetId)
                    : currentSession;

                  if (!target && targetId) {
                    target = {
                      sessionId: targetId,
                      title: pendingPrompt?.title || '待处理审批会话',
                      workspace: '',
                      preview: '',
                      isSubagent: false,
                      running: true,
                      updatedAt: Date.now(),
                    };
                  }

                  if (!target && sessions.length > 0) {
                    target = sessions[0];
                  }

                  if (target) {
                    handleOpenSession(target);
                  } else {
                    handleCreateSession();
                  }
                }}
                className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left bg-violet-50 border-b border-violet-200 text-violet-950 active:bg-violet-100 transition-colors"
              >
                <span className="shrink-0 w-2 h-2 rounded-full bg-violet-600 animate-pulse" />
                <span className="flex-1 min-w-0 truncate text-xs font-medium">
                  有 1 项待你处理：{pendingPrompt.title}
                </span>
                <span className="shrink-0 text-xs font-semibold text-violet-700 underline">去处理</span>
              </button>
            )}

            {/* 环境/鉴权警示必须明说，不能静默 */}
            {alertBanner &&
              (alertBanner.onPress ? (
                <button
                  type="button"
                  onClick={alertBanner.onPress}
                  className="w-full text-left bg-amber-50 text-amber-900 border-b border-amber-200 px-3.5 py-2 text-[11px] leading-snug font-medium active:bg-amber-100 transition-colors"
                >
                  ⚠️ {alertBanner.text} <span className="underline font-semibold ml-1">去处理</span>
                </button>
              ) : (
                <div className="bg-amber-50 text-amber-900 border-b border-amber-200 px-3.5 py-2 text-[11px] leading-snug font-medium">
                  ⚠️ {alertBanner.text}
                </div>
              ))}

            {/* 轻提示（离线已入队等）：不打断操作，几秒自消 */}
            {notice && (
              <div
                role="status"
                className="bg-blue-50 text-blue-900 border-b border-blue-200 px-3.5 py-2 text-[11px] leading-snug font-medium"
              >
                {notice}
              </div>
            )}
          </div>
        )}

        {/* 屏幕内容区 */}
        <div className="flex-1 min-h-0 relative">
          {route === 'hosts' && (
            <HostsScreen
              hosts={hosts}
              activeId={activeHostId}
              linkState={linkState}
              onOpen={handleSelectHost}
              onForget={handleForgetHost}
              onRename={handleRenameHost}
              onReconnect={() => activeHostId && startHostConnection(activeHostId)}
              onAdd={() => setRoute('pair')}
              onAddDemo={handleAddDemo}
              onBack={() => setRoute('sessions')}
              onSetConnectionMode={handleSetConnectionMode}
              onProbeLan={handleProbeLan}
            />
          )}

          {route === 'pair' && (
            <PairScreen
              busy={busy}
              error={error}
              onBack={hosts.length > 0 ? () => setRoute('hosts') : null}
              onLogin={handleLogin}
              onPair={handlePair}
              deviceName={DEVICE_NAME}
            />
          )}

          {route === 'sessions' && (
            <SessionsScreen
              linkState={linkState}
              sessions={sessions}
              subagentSessions={subagentSessions}
              searchResults={searchResults}
              loading={sessionsLoading}
              archivedIds={archivedIds}
              onArchive={(s) => applyArchive(s, true)}
              onUnarchive={(s) => applyArchive(s, false)}
              pinnedIds={pinnedIds}
              onTogglePin={handleTogglePin}
              onRenameSession={handleRenameSession}
              onForkSession={handleForkSession}
              onCancelSession={handleCancelSession}
              onOpen={handleOpenSession}
              onRefresh={() => loadSessions()}
              onSearch={handleSearchSessions}
              onCreate={handleCreateSession}
              createNotice={createNotice}
              onDismissCreateNotice={() => setCreateNotice(null)}
              onOpenDrawer={() => setDrawerOpen(true)}
            />
          )}

          {route === 'chat' && (
            <ChatScreen
              sessionId={currentSession?.sessionId || ''}
              title={currentSession?.title || '新会话'}
              lines={chatLines}
              pending={pendingPrompt}
              running={running}
              sending={sending}
              preparing={preparing}
              preparingStep={preparingStep}
              hostName={linkState.hostName || activeHost?.label}
              workspace={currentSession?.workspace}
              queued={queued}
              onRemoveQueued={handleRemoveQueued}
              onRetryQueued={handleRetryQueued}
              liveConnected={linkState.type === 'ready'}
              activity={activity}
              readouts={readouts}
              onBack={() => setRoute('sessions')}
              onSend={handleSendPrompt}
              onCancel={handleCancelPrompt}
              onApprove={handleApprove}
              onAnswerOption={handleAnswerOption}
              onOpenDrawer={() => setDrawerOpen(true)}
              onManageHosts={() => setRoute('hosts')}
              onNewSession={handleStartNewChat}
              isDemoHost={activeHost?.id === 'demo-local-host'}
              modelCatalog={modelCatalog}
              selectedModel={selectedModel}
              onSelectModel={handleSelectModel}
              isLan={linkState.isLan}
              pingMs={linkState.pingMs}
              onRefreshConnection={() => activeHostId && startHostConnection(activeHostId)}
            />
          )}
        </div>
      </main>
    </div>
  );
};
