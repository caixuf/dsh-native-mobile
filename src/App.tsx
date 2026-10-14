import React, { useState, useEffect, useRef } from 'react';
import type { HostRecord, LinkState, SessionRow, ChatLine, PendingPrompt } from './types';
import { HostStore } from './services/store';
import { DshConnection } from './services/connection';
import type { HostRequestItem } from './services/connection';
import { PairingClient } from './services/pairing';
import { Envelopes } from './services/envelopes';
import { NativeBridge } from './services/native-bridge';
import type { NativeRelayStatus } from './services/native-bridge';
import { HostsScreen } from './components/screens/HostsScreen';
import { PairScreen } from './components/screens/PairScreen';
import { SessionsScreen } from './components/screens/SessionsScreen';
import { ChatScreen } from './components/screens/ChatScreen';
import { AppDrawer } from './components/drawer/AppDrawer';

type Route = 'hosts' | 'pair' | 'sessions' | 'chat';

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

  const connRef = useRef<DshConnection | null>(null);
  const advanceTimerRef = useRef<number | null>(null);

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
      handleHostRequest(req);
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

    const body = isApproval
      ? String(req.payload.displayReason || req.payload.reason || `工具调用: ${req.payload.toolName || ''}`)
      : qFirst?.question || JSON.stringify(req.payload, null, 2);

    const options = qFirst?.options?.map((o) => o.label || '').filter(Boolean) || [];

    setPendingPrompt({
      rpcId: req.rpcId,
      method: req.method,
      title,
      body,
      options,
      questionId: qFirst?.id,
      approval: isApproval,
    });

    // 桌面壳：窗口可能正藏在托盘里，网页根本不在看 —— 由主进程发系统通知。
    // （Android 由前台服务自己发带按钮的通知，不经这里。）
    NativeBridge.notifyApproval({
      eventId: req.rpcId,
      title,
      body,
      kind: isApproval ? 'approval' : 'question',
    });
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

  const loadChatPage = async (sessionId: string, conn = connRef.current) => {
    if (!conn) return;
    try {
      const res = (await conn.call('session.page', {
        request: {
          address: { sessionId },
          throughSeq: 1000000,
          maxMessages: 50,
        },
      })) as {
        records?: Array<{
          seq?: number;
          event?: {
            type?: string;
            seq?: number;
            data?: {
              name?: string;
              callId?: string;
              arguments?: string;
              result?: string;
              isError?: boolean;
              message?: {
                content?: Array<{ text?: string }>;
              };
            };
          };
        }>;
      };

      const records = res?.records || [];
      const lines: ChatLine[] = [];

      records.forEach((rec, idx) => {
        const ev = rec.event;
        if (!ev) return;
        const kind = ev.type || 'assistant/message';
        const data = ev.data;
        const role = kind.startsWith('user') ? 'user' : 'assistant';
        const text =
          data?.message?.content?.[0]?.text ||
          (data?.result ? String(data.result) : '') ||
          '';

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
    } catch (err) {
      console.warn('Failed to fetch chat page', err);
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
      const record = await PairingClient.login(baseUrl, user, pass, name);
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
      const record = await PairingClient.pair(baseUrl, code, name);
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
    setCurrentSession(session);
    setRoute('chat');
    loadChatPage(session.sessionId);
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
        setSessions(
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

  const handleSendPrompt = async (text: string) => {
    if (!currentSession || !connRef.current) return;
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

      // Refresh chat
      loadChatPage(sid);
      setTimeout(() => loadChatPage(sid), 1500);
      setTimeout(() => {
        loadChatPage(sid);
        setRunning(false);
      }, 3000);
    } catch (err) {
      setPreparing(false);
      setSending(false);
      console.warn('Prompt send error', err);
    }
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
  const backgroundAlertWarning = (() => {
    if (hosts.length === 0) return null;
    const platform = NativeBridge.platform();
    if (platform === 'web') {
      return '当前在浏览器中打开：锁屏或切到后台后收不到审批提醒。要随时收到请在手机上安装 App。';
    }
    if (!relayStatus) return null;
    if (relayStatus.state === 'auth-failed') {
      return '后台审批通道已停止：设备令牌失效，请重新配对，否则电脑端等待授权时手机不会有任何提示。';
    }
    if (relayStatus.configured && !relayStatus.notificationsEnabled) {
      return '通知权限未开启：审批到了手机也不会提醒你。请在系统设置里允许本应用发送通知。';
    }
    if (relayStatus.lastError) {
      return `后台审批通道异常：${relayStatus.lastError}`;
    }
    return null;
  })();

  const activeHost = hosts.find((h) => h.id === activeHostId);

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
        {/* 「锁屏收不到提醒」必须明说，不能静默 */}
        {backgroundAlertWarning && (
          <div className="absolute top-0 inset-x-0 z-50 bg-amber-500/15 text-amber-200 border-b border-amber-500/30 px-3 py-2 text-[11px] leading-snug backdrop-blur-sm">
            ⚠️ {backgroundAlertWarning}
          </div>
        )}
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
            deviceName="Web Remote Client"
          />
        )}

        {route === 'sessions' && (
          <SessionsScreen
            linkState={linkState}
            sessions={sessions}
            subagentSessions={subagentSessions}
            loading={sessionsLoading}
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
