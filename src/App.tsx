import React, { useState, useEffect, useRef } from 'react';
import type { HostRecord, LinkState, SessionRow, ChatLine, PendingPrompt } from './types';
import { HostStore } from './services/store';
import { DshConnection } from './services/connection';
import type { HostRequestItem } from './services/connection';
import { PairingClient } from './services/pairing';
import { Envelopes } from './services/envelopes';
import { NativeBridge } from './services/native-bridge';
import type { NativeRelayStatus } from './services/native-bridge';
import { fetchChatPage } from './lib/session-page';
import { collectMessageText, isDialogEvent, isToolEvent } from './lib/session-page';
import {
  readArchivedIds,
  setArchivedId,
  writeArchivedIds,
} from './lib/session-groups';
import { currentDeviceName, getOrCreateDeviceId, uniqueDeviceName } from './services/device';
import { HostsScreen } from './components/screens/HostsScreen';
import { PairScreen } from './components/screens/PairScreen';
import { SessionsScreen } from './components/screens/SessionsScreen';
import { ChatScreen } from './components/screens/ChatScreen';
import { AppDrawer } from './components/drawer/AppDrawer';

type Route = 'hosts' | 'pair' | 'sessions' | 'chat';

/** 排队等待发送的指令（任务运行中时用户仍可继续输入）。 */
interface QueuedPrompt {
  id: string;
  text: string;
  createdAt: number;
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

/**
 * 真主机下发的文案字段可能是**多语言对象** `{en, zh}`（实测：`displayReason`）。
 *
 * 旧写法 `String(payload.displayReason)` 会把对象变成字面量 `"[object Object]"`
 * 直接怼到用户脸上 —— 审批卡片最重要的一行说明就成了乱码。
 * 这里按「当前语言 → 英文 → 纯字符串 → 空」依次取。
 */
function localizedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const zh = record.zh;
    const en = record.en;
    if (typeof zh === 'string' && zh.trim()) return zh;
    if (typeof en === 'string' && en.trim()) return en;
    // 其它语言的兜底：取第一个非空字符串值
    for (const candidate of Object.values(record)) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
  }
  return '';
}

export const App: React.FC = () => {
  const [route, setRoute] = useState<Route>('sessions');
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

  /** 网页端的鉴权失效（401/403 分流后的状态，见 connection.ts）。 */
  const [authFailure, setAuthFailure] = useState<{ status: number; message: string } | null>(null);

  /** 运行中排队的指令（发送失败会退回队首并计数）。 */
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);

  /** 聊天页的读取错误（子代理读不到、网络失败等）——必须让用户看见，不能只 console.warn。 */
  const [chatError, setChatError] = useState<string | null>(null);

  /** 本机归档的会话 id（真主机没有 archive 端点，UI 已如实标注"仅本机归档"）。 */
  const [archivedIds, setArchivedIds] = useState<string[]>(() => {
    try {
      return readArchivedIds(localStorage);
    } catch {
      return [];
    }
  });

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

  // Load hosts on initial mount
  useEffect(() => {
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

    const conn = new DshConnection(record.baseUrl, record.token, record.label);
    connRef.current = conn;

    // 把凭据交给原生壳：Android 由前台服务在后台守着审批通道（WebView 一旦切后台
    // 就会被挂起，靠网页自己守不住）；普通浏览器里这是安全的空操作。
    const published = NativeBridge.publishConnection(record.baseUrl, record.token, record.label);
    if (published) setRelayStatus(published);

    conn.onStateChange((state) => {
      setLinkState(state);
      if (state.type === 'ready') {
        loadSessions(conn);
      }
    });

    conn.onRequest((req: HostRequestItem) => {
      if (req.answerable) {
        handleHostRequest(req);
        return;
      }
      // 非应答事件 = 主机在推流（emit）。长任务的实时进度就靠它。
      handleStreamTick();
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

    conn.start();
  };

  const handleHostRequest = (req: HostRequestItem) => {
    if (!req.answerable) return;
    const isApproval = req.method.includes('approval');
    const questions = req.payload.questions as Array<{
      id?: string;
      header?: string;
      question?: string;
      options?: Array<{ label?: string }>;
    }> | undefined;
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

    // 审批载荷里带 sessionId（真主机字段：sessionId / approvalId / toolName / callId / reason），
    // 有了它，用户不在聊天页时也能直接跳到**出事的那个会话**去处理。
    const sessionId =
      (typeof req.payload.sessionId === 'string' && req.payload.sessionId) ||
      (typeof (req.payload.address as { sessionId?: string } | undefined)?.sessionId === 'string'
        ? (req.payload.address as { sessionId: string }).sessionId
        : null);

    setPendingPrompt({
      rpcId: req.rpcId,
      method: req.method,
      title,
      body,
      options,
      questionId: qFirst?.id,
      approval: isApproval,
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
   * 主机推来的**非应答**事件（`emit`）=「还在干活」的唯一实时信号。
   *
   * 旧实现只在上屏后轮询 3 次（0 / 1.5s / 3s）就停 —— 超过 3 秒的活儿
   * 界面**永远不再更新**，用户只能退出重进。这里改成：事件到达即防抖重取当前会话。
   */
  const handleStreamTick = () => {
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
      const lines: ChatLine[] = [];

      records.forEach((rec, idx) => {
        const ev = rec.event;
        if (!ev) return;
        const kind = ev.type || '';

        // 🔴 P0：只渲染真正的对话事件。旧实现把所有记录都当气泡，
        // 于是**整段系统提示词**（含内部工具说明）被渲染成助手消息。
        if (!isDialogEvent(kind)) return;

        const data = ev.data;
        const role = kind.startsWith('user') ? 'user' : 'assistant';

        // 🔴 P0：取**所有** text 段并跳过 reasoning。
        // 旧实现写死 `content[0].text`，模型先输出思考时就把**私有推理当回答显示**，
        // 真正的正文被吞掉 —— 表现为间歇性"答非所问"。
        //
        // 而且两种事件的载荷形状**不一样**（真主机实测）：
        //   assistant/message → { message: { content: [...] } }
        //   user/message      → { content: [...] }        ← 没有 message 包装！
        // 只读 `data.message.content` 会让**用户自己发的指令渲染成空气泡**。
        const text =
          collectMessageText(data?.message?.content ?? data?.content) ||
          (data?.result ? String(data.result) : '') ||
          '';

        // 工具事件即使正文为空也要渲染；普通消息为空则不入列表（避免空卡）
        if (!isToolEvent(kind) && !text) return;

        lines.push({
          key: `line-${rec.seq || idx}`,
          role,
          text,
          kind,
          toolName: data?.name,
          toolArgs: data?.arguments,
          toolResult: data?.result,
          toolCallId: data?.callId,
          isError: data?.isError,
        });
      });

      setChatLines(lines);
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
      if (currentSessionRef.current?.sessionId === session.sessionId) setChatLines([]);
    }
  };

  const handleSelectHost = (hostId: string) => {
    setActiveHostId(hostId);
    HostStore.setActiveId(hostId);
    startHostConnection(hostId);
    setRoute('sessions');
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
    setRunning(false);
    setCurrentSession(session);
    setRoute('chat');
    // 先清空：否则上一会话的消息会短暂串台（真机实测 2–3 秒，F5）
    setChatLines([]);
    setChatError(null);
    loadChatPage(session);
  };

  useEffect(() => stopTurnWatch, []);

  /** 本机归档（真主机无 archive 端点；仅隐藏并持久化在设备上）。 */
  const applyArchive = (session: SessionRow, archived: boolean) => {
    setArchivedIds((prev) => {
      const next = setArchivedId(prev, session.sessionId, archived);
      try {
        writeArchivedIds(next, localStorage);
      } catch {
        /* 存不下也不影响本次会话内的隐藏 */
      }
      return next;
    });
  };

  const handleCreateSession = async (cwd?: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const res = (await conn.call('session.create', {
        request: { cwd },
      })) as { sessionId?: string };

      const newId = res?.sessionId || 'session-' + Date.now();
      const newRow: SessionRow = {
        sessionId: newId,
        title: '新遥控会话',
        preview: '就绪',
        updatedAt: Date.now(),
        running: false,
        isSubagent: false,
        workspace: cwd || '~/Developer/workspaces/app',
      };

      setSessions([newRow, ...sessions]);
      handleOpenSession(newRow);
    } catch (err) {
      console.warn('Failed to create session', err);
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
   * 这里改成：边转边刷（2.5s），并用 `session/list` 的 `running` 标记作为**权威终止信号**
   * （主机会如实告诉你这个会话还在不在跑），有上限兜底，切换会话即停。
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
      void loadChatPage(session);

      if (ticks % 3 === 0) {
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
            // 真实转换（跑过再停），或一直没跑起来但已连续多次报 false（约 15s）
            if ((seenRunning && row.running === false) || falseStreak >= 5) {
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

  /**
   * 真正把一条指令发出去。
   *
   * @returns true=主机已接收；**false=没送到，调用方必须保留用户输入**。
   */
  const sendPromptNow = async (text: string): Promise<boolean> => {
    if (!currentSession || !connRef.current) return false;
    const sid = currentSession.sessionId;

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
      await connRef.current.call('session.prompt', {
        request: {
          requestId: 'req-' + Date.now(),
          sessionId: sid,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
      });

      setPreparing(false);
      setRunning(true);
      setSending(false);

      // Refresh chat；真正的实时更新靠事件流 + 下面的 turn watch
      loadChatPage(currentSession);
      startTurnWatch(currentSession);
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
  const handleSendPrompt = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return true; // 空消息不算失败，不该卡住草稿
    if (!currentSession || !connRef.current) return false;

    if (running) {
      setQueued((prev) => [
        ...prev,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text: trimmed,
          createdAt: Date.now(),
        },
      ]);
      return true;
    }

    return sendPromptNow(trimmed);
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
      void sendPromptNow(next.text).then((ok) => {
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
      await connRef.current.call('session.cancel', {
        request: { sessionId: currentSession.sessionId },
      });
      setRunning(false);
    } catch (err) {
      console.warn('Cancel failed', err);
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

  const handleAnswerOption = async (text: string) => {
    if (!pendingPrompt || !connRef.current) return;
    const outcome = Envelopes.questionOutcome(pendingPrompt.questionId || 'q1', [text]);
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

  /** 点通知进来 → 跳到对应会话（壳会推，也可能需要网页主动取一次）。 */
  const deepLinkRef = useRef<(link: { eventId?: string; sessionId?: string }) => boolean>(() => false);
  useEffect(() => {
    deepLinkRef.current = (link) => {
      const sessionId = link?.sessionId;
      if (!sessionId) return false;
      const target = [...sessions, ...subagentSessions].find((s) => s.sessionId === sessionId);
      if (!target) return false;
      setPendingPrompt(null);
      handleOpenSession(target);
      return true;
    };
  }, [sessions, subagentSessions]);

  useEffect(() => {
    NativeBridge.installDeepLinkHandler((link) => deepLinkRef.current(link));
    const pending = NativeBridge.takePendingDeepLink();
    if (pending?.pending) deepLinkRef.current(pending);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#090a0f] text-[#f8fafc] font-sans">
      {/* App Drawer */}
      <AppDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeHostName={linkState.hostName || activeHost?.label || '我的电脑'}
        isHostOnline={linkState.type === 'ready'}
        sessions={sessions}
        currentSessionId={currentSession?.sessionId}
        onSelectSession={(s) => {
          handleOpenSession(s);
          setDrawerOpen(false);
        }}
        onNewSession={() => {
          handleCreateSession();
          setDrawerOpen(false);
        }}
        onManageHosts={() => {
          setRoute('hosts');
          setDrawerOpen(false);
        }}
      />

      {/* Main Screen Router */}
      <main className="flex-1 h-full overflow-hidden relative">
        {/* 顶部横幅栈：待审批优先级最高（它有时效），其次才是环境警示 */}
        <div className="absolute top-0 inset-x-0 z-50 flex flex-col">
          {/*
            用户在会话列表/主机页时，待审批项原本**完全看不见** —— 只有进到聊天页才渲染。
            真主机的审批载荷带 sessionId，所以这里可以直接跳到出事的那个会话。
          */}
          {pendingPrompt && route !== 'chat' && (
            <button
              type="button"
              onClick={() => {
                const target = promptSessionId
                  ? [...sessions, ...subagentSessions].find((s) => s.sessionId === promptSessionId)
                  : currentSession;
                if (target) {
                  handleOpenSession(target);
                } else {
                  // 找不到对应会话（比如它还没出现在列表里）：至少把列表打开，
                  // 不要给一个点了没反应的横幅。
                  setDrawerOpen(true);
                }
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-left bg-violet-500/20 border-b border-violet-400/40 text-violet-100 backdrop-blur-sm active:bg-violet-500/30"
            >
              <span className="shrink-0 w-2 h-2 rounded-full bg-violet-300 animate-pulse" />
              <span className="flex-1 min-w-0 truncate text-xs">
                有 1 项待你处理：{pendingPrompt.title}
              </span>
              <span className="shrink-0 text-xs underline">去处理</span>
            </button>
          )}

          {/* 环境/鉴权警示必须明说，不能静默 */}
          {alertBanner &&
            (alertBanner.onPress ? (
              <button
                type="button"
                onClick={alertBanner.onPress}
                className="w-full text-left bg-amber-500/15 text-amber-200 border-b border-amber-500/30 px-3 py-2 text-[11px] leading-snug backdrop-blur-sm active:bg-amber-500/25"
              >
                ⚠️ {alertBanner.text} <span className="underline">去处理</span>
              </button>
            ) : (
              <div className="bg-amber-500/15 text-amber-200 border-b border-amber-500/30 px-3 py-2 text-[11px] leading-snug backdrop-blur-sm">
                ⚠️ {alertBanner.text}
              </div>
            ))}
        </div>
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
            onOpen={handleOpenSession}
            onRefresh={() => loadSessions()}
            onSearch={handleSearchSessions}
            onCreate={handleCreateSession}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        )}

        {route === 'chat' && currentSession && (
          <ChatScreen
            sessionId={currentSession.sessionId}
            title={currentSession.title}
            lines={chatLines}
            pending={pendingPrompt}
            running={running}
            sending={sending}
            preparing={preparing}
            preparingStep={preparingStep}
            hostName={linkState.hostName || activeHost?.label}
            workspace={currentSession.workspace}
            queued={queued}
            onRemoveQueued={handleRemoveQueued}
            onRetryQueued={handleRetryQueued}
            liveConnected={linkState.type === 'ready'}
            onBack={() => setRoute('sessions')}
            onSend={handleSendPrompt}
            onCancel={handleCancelPrompt}
            onApprove={handleApprove}
            onAnswerOption={handleAnswerOption}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        )}
      </main>
    </div>
  );
};
