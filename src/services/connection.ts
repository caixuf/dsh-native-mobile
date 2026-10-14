import { LinkState, PendingPrompt, SessionRow, ChatLine } from '../types';
import { Envelopes } from './envelopes';

export interface HostRequestItem {
  rpcId: string;
  method: string;
  payload: Record<string, unknown>;
  answerable: boolean;
}

// Built-in simulated session storage for local test drive & fallback
const MOCK_SESSIONS: SessionRow[] = [
  {
    sessionId: 'session-project-init-01',
    title: '全栈电商平台架构迁移与重构',
    preview: '已完成数据库索引升级，当前正在执行前端构建与微服务拆分…',
    updatedAt: Date.now() - 1000 * 60 * 12,
    running: false,
    isSubagent: false,
    workspace: '~/Developer/workspaces/nexus-ecommerce',
  },
  {
    sessionId: 'session-deploy-fix-02',
    title: '生产环境网关 502 错误排查与流量切换',
    preview: '分析 Nginx 错误日志与 upstream 超时参数，准备更新配置文件',
    updatedAt: Date.now() - 1000 * 60 * 45,
    running: true,
    isSubagent: false,
    workspace: '/var/www/infrastructure/gateway',
  },
  {
    sessionId: 'session-ai-agent-03',
    title: 'MCP 远程工具与终端自动化测试',
    preview: '终端命令执行完成：pytest tests/test_agent_flow.py (全部通过)',
    updatedAt: Date.now() - 1000 * 3600 * 3,
    running: false,
    isSubagent: false,
    workspace: '~/Projects/dsh-mobile-remote',
  },
  {
    sessionId: 'subagent-trace-internal-99',
    title: 'Subagent: 日志分析与指标收集',
    preview: '后台静默聚合 Prometheus 节点指标',
    updatedAt: Date.now() - 1000 * 3600 * 5,
    running: false,
    isSubagent: true,
    parentSessionId: 'session-deploy-fix-02',
    workspace: '/var/www/infrastructure/gateway',
  },
];

const MOCK_MESSAGES: Record<string, ChatLine[]> = {
  'session-project-init-01': [
    {
      key: 'msg-1',
      role: 'user',
      text: '帮我检查一下 nexus-ecommerce 项目的构建配置，并将数据库连接池大小提升到 50。',
      kind: 'user/message',
    },
    {
      key: 'msg-2',
      role: 'assistant',
      text: '正在连线你的本地工作环境并扫描配置文件…\n\n- [x] 读取 `package.json` 与 `database.config.ts`\n- [x] 验证当前连接池大小与环境变量\n- [ ] 更新连接池最大活跃连接为 50\n- [ ] 运行数据库健康检查与单元测试',
      kind: 'assistant/message',
    },
    {
      key: 'msg-3',
      role: 'assistant',
      text: '调用 read_file · {"path": "config/database.ts"}',
      kind: 'tool/call',
      toolName: 'read_file',
      toolArgs: '{"path": "config/database.ts", "encoding": "utf-8"}',
      toolCallId: 'call_read_db_config',
    },
    {
      key: 'msg-4',
      role: 'assistant',
      text: '{\n  "host": "localhost",\n  "port": 5432,\n  "pool": {\n    "min": 5,\n    "max": 20\n  }\n}',
      kind: 'tool/result',
      toolName: 'read_file',
      toolResult: '{\n  "host": "localhost",\n  "port": 5432,\n  "pool": { "min": 5, "max": 20 }\n}',
      toolCallId: 'call_read_db_config',
    },
    {
      key: 'msg-5',
      role: 'assistant',
      text: '调用 edit_file · {"path": "config/database.ts", "max": 50}',
      kind: 'tool/call',
      toolName: 'edit_file',
      toolArgs: '{"path": "config/database.ts", "changes": [{"line": 6, "replace": "\\"max\\": 50"}]}',
      toolCallId: 'call_edit_db_config',
    },
    {
      key: 'msg-6',
      role: 'assistant',
      text: '文件更新成功：`config/database.ts` (连接池上限已调整为 50)。',
      kind: 'tool/result',
      toolName: 'edit_file',
      toolResult: 'Success: patched 1 file with 1 replacement chunk.',
      toolCallId: 'call_edit_db_config',
    },
    {
      key: 'msg-7',
      role: 'assistant',
      text: '修改已落盘！接下来准备在你的本地机器上启动数据库连接压测。',
      kind: 'assistant/message',
    },
  ],
  'session-deploy-fix-02': [
    {
      key: 'msg-10',
      role: 'user',
      text: '网关上有很多 502 报警，马上查一下错误原因并重启服务。',
      kind: 'user/message',
    },
    {
      key: 'msg-11',
      role: 'assistant',
      text: '收到遥控指令！正在排查服务器日志：\n\n- [x] 查询 Nginx error.log 最新 100 条错误\n- [x] 检查后端 upstream 进程存活状态\n- [ ] 申请安全权限并重启网关进程',
      kind: 'assistant/message',
    },
    {
      key: 'msg-12',
      role: 'assistant',
      text: '调用 run_command · {"command": "tail -n 30 /var/log/nginx/error.log"}',
      kind: 'tool/call',
      toolName: 'run_command',
      toolArgs: '{"command": "tail -n 30 /var/log/nginx/error.log"}',
      toolCallId: 'call_tail_nginx_log',
    },
    {
      key: 'msg-13',
      role: 'assistant',
      text: '2026/10/13 12:40:02 [error] 1420#1420: *49812 connect() to unix:/run/app.sock failed (111: Connection refused) while connecting to upstream',
      kind: 'tool/result',
      toolName: 'run_command',
      toolResult: 'connect() to unix:/run/app.sock failed (111: Connection refused)',
      toolCallId: 'call_tail_nginx_log',
    },
    {
      key: 'msg-14',
      role: 'assistant',
      text: '排查发现是本地应用套接字服务崩溃。正在准备拉起守护进程。',
      kind: 'assistant/message',
    },
  ],
};

export const WS_MUX = '/mobile-gateway/remote.mux';
export const EVENT_STREAM_ENDPOINT = '$events';
export const EVENT_RESULT_ENDPOINT = '$events/result';

export class DshConnection {
  private baseUrl: string;
  private token: string;
  private instanceName: string;
  private socket: WebSocket | null = null;
  private stateListeners: Set<(state: LinkState) => void> = new Set();
  private requestListeners: Set<(req: HostRequestItem) => void> = new Set();
  private isStopped = false;
  private attempt = 0;
  private eventClientId: string | null = null;
  private answeredEventIds: Set<string> = new Set();
  private mockSessions: SessionRow[] = [...MOCK_SESSIONS];
  private mockMessages: Record<string, ChatLine[]> = { ...MOCK_MESSAGES };

  constructor(baseUrl: string, token: string, instanceName = '') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.instanceName = instanceName;
  }

  public onStateChange(listener: (state: LinkState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public onRequest(listener: (req: HostRequestItem) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  private notifyState(state: LinkState) {
    this.stateListeners.forEach((fn) => fn(state));
  }

  public start() {
    this.isStopped = false;
    this.attempt += 1;
    this.notifyState({ type: 'connecting', attempt: this.attempt });

    // If demo token or local demo host, activate robust simulated mode
    if (this.baseUrl.includes('demo') || this.token.includes('demo')) {
      setTimeout(() => {
        if (!this.isStopped) {
          this.eventClientId = 'mock-client-' + Math.random().toString(36).slice(2, 8);
          this.notifyState({
            type: 'ready',
            hostName: this.instanceName || 'MacBook Pro (Demo 实例)',
          });
        }
      }, 500);
      return;
    }

    this.connectReal();
  }

  public stop() {
    this.isStopped = true;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.notifyState({ type: 'disconnected' });
  }

  private connectReal() {
    try {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + WS_MUX;
      const ws = new WebSocket(wsUrl);
      this.socket = ws;

      ws.onopen = () => {
        if (this.isStopped) {
          ws.close();
          return;
        }
        // Send open frame for $events stream
        const openFrame = {
          type: 'open',
          streamId: 'stream-' + Date.now(),
          endpoint: EVENT_STREAM_ENDPOINT,
          payload: { args: {} },
        };
        ws.send(JSON.stringify(openFrame));

        // Test probe with session.list
        this.call('session.list', { _request: {} })
          .then(() => {
            this.attempt = 0;
            this.notifyState({
              type: 'ready',
              hostName: this.instanceName || this.baseUrl,
            });
          })
          .catch((err) => {
            this.notifyState({
              type: 'degraded',
              reason: '主机未响应 session.list: ' + (err.message || '未知错误'),
              attempt: this.attempt,
            });
          });
      };

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === 'item' && frame.value) {
            this.handleStreamItem(frame.value);
          } else if (frame.type === 'end' || frame.type === 'error') {
            this.notifyState({
              type: 'degraded',
              reason: frame.error?.message || '事件流被关闭',
              attempt: this.attempt,
            });
          }
        } catch (e) {
          console.warn('Failed to parse frame', e);
        }
      };

      ws.onerror = () => {
        this.notifyState({
          type: 'degraded',
          reason: 'WebSocket 连接异常',
          attempt: this.attempt,
        });
      };

      ws.onclose = () => {
        if (!this.isStopped) {
          this.notifyState({
            type: 'degraded',
            reason: '连接已关闭，准备重连…',
            attempt: this.attempt,
          });
          setTimeout(() => {
            if (!this.isStopped) this.connectReal();
          }, 3000);
        }
      };
    } catch (e: unknown) {
      const err = e as Error;
      this.notifyState({
        type: 'degraded',
        reason: '无法创建网络连接: ' + (err?.message || '网络不可达'),
        attempt: this.attempt,
      });
    }
  }

  private handleStreamItem(value: Record<string, unknown>) {
    if (value.type === 'ready') {
      const val = value;
      this.eventClientId = String(val.clientId);
    } else if (value.type === 'emit') {
      const eventName = String(value.event || '');
      this.requestListeners.forEach((fn) =>
        fn({
          rpcId: eventName,
          method: eventName,
          payload: value,
          answerable: false,
        }),
      );
    } else if (value.type === 'waterfall') {
      const eventName = String(value.event || '');
      const eventId = String(value.eventId || '');
      if (this.answeredEventIds.has(eventId)) return;
      this.answeredEventIds.add(eventId);

      this.requestListeners.forEach((fn) =>
        fn({
          rpcId: eventId,
          method: eventName,
          payload: (value.request as Record<string, unknown>) || value,
          answerable: true,
        }),
      );
    }
  }

  public async call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // If running in demo mode or offline simulated fallback
    if (this.baseUrl.includes('demo') || this.token.includes('demo')) {
      return this.handleMockCall(method, args);
    }

    const rpcId = 'r' + Math.random().toString(36).slice(2, 9);
    const endpoint = Envelopes.toEndpoint(method);
    const body = Envelopes.clientRequest(rpcId, method, args);

    const res = await fetch(`${this.baseUrl}/mobile-gateway/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`RPC 失败: HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.result?.ok) {
      return json.result.value;
    } else {
      throw new Error(json.result?.error?.message || `${method} 返回了错误`);
    }
  }

  public async respond(eventId: string, outcome: Record<string, unknown>): Promise<boolean> {
    if (this.baseUrl.includes('demo') || this.token.includes('demo')) {
      return true;
    }
    const clientId = this.eventClientId;
    if (!clientId) return false;

    try {
      const rpcId = 'r' + Math.random().toString(36).slice(2, 9);
      const body = Envelopes.clientRequest(rpcId, '$events/result', {
        clientId,
        eventId,
        outcome,
      });

      const res = await fetch(`${this.baseUrl}/mobile-gateway/api/${EVENT_RESULT_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });

      return res.ok;
    } catch {
      return false;
    }
  }

  // --- Mock Engine for instant interactive testing ---
  private handleMockCall(method: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const norm = method.replace(/\//g, '.');

        if (norm === 'session.list') {
          resolve({
            items: this.mockSessions.map((s) => ({
              sessionId: s.sessionId,
              origin: s.isSubagent ? 'subagent' : 'user',
              parentSessionId: s.parentSessionId || null,
              running: s.running,
              updatedAt: s.updatedAt,
              cwd: s.workspace,
              projections: {
                values: {
                  title: s.title,
                  preview: s.preview,
                  cwd: s.workspace,
                },
              },
            })),
          });
        } else if (norm === 'session.search') {
          const req = (args.request || {}) as { query?: string };
          const q = (req.query || '').toLowerCase();
          const filtered = this.mockSessions.filter(
            (s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q),
          );
          resolve({
            items: filtered.map((s) => ({
              sessionId: s.sessionId,
              title: s.title,
              snippet: s.preview,
              updatedAt: s.updatedAt,
            })),
          });
        } else if (norm === 'session.create') {
          const req = (args.request || {}) as { cwd?: string };
          const newId = 'session-' + Date.now();
          const newSession: SessionRow = {
            sessionId: newId,
            title: '新建遥控会话 #' + this.mockSessions.length,
            preview: '等待下发遥控指令…',
            updatedAt: Date.now(),
            running: false,
            isSubagent: false,
            workspace: req.cwd || '~/Developer/workspaces/app',
          };
          this.mockSessions.unshift(newSession);
          this.mockMessages[newId] = [
            {
              key: 'init-' + Date.now(),
              role: 'assistant',
              text: '电脑端 AI 遥控就绪 ⚡\n\n已绑定工作区：`' + (newSession.workspace || '~') + '`\n你可以发送文字，或按住右下角麦克风语音遥控。',
              kind: 'assistant/message',
            },
          ];
          resolve({ sessionId: newId });
        } else if (norm === 'session.page') {
          const req = (args.request || {}) as {
            address?: { sessionId?: string };
            throughSeq?: number;
            maxMessages?: number;
          };
          const sid = req.address?.sessionId || '';
          const msgs = this.mockMessages[sid] || [];
          resolve({
            records: msgs.map((m, idx) => ({
              type: 'event',
              seq: idx + 1,
              event: {
                type: m.kind,
                seq: idx + 1,
                time: Date.now(),
                data: {
                  name: m.toolName,
                  callId: m.toolCallId,
                  arguments: m.toolArgs,
                  result: m.toolResult,
                  isError: m.isError,
                  message: {
                    content: [{ type: 'text', text: m.text }],
                  },
                },
              },
            })),
          });
        } else if (norm === 'session.prompt') {
          const req = (args.request || {}) as {
            sessionId?: string;
            content?: Array<{ type: string; text?: string }>;
          };
          const sid = req.sessionId || '';
          const text = req.content?.[0]?.text || '';
          const list = this.mockMessages[sid] || [];

          // Add user message
          list.push({
            key: 'user-' + Date.now(),
            role: 'user',
            text,
            kind: 'user/message',
          });

          // Simulate agent execution steps & tool card
          setTimeout(() => {
            list.push({
              key: 'tool-call-' + Date.now(),
              role: 'assistant',
              text: `执行终端命令 · {"command": "npm test"}`,
              kind: 'tool/call',
              toolName: 'run_command',
              toolArgs: '{"command": "npm test", "cwd": "' + (this.mockSessions.find((s) => s.sessionId === sid)?.workspace || '~') + '"}',
              toolCallId: 'call_test_' + Date.now(),
            });

            setTimeout(() => {
              list.push({
                key: 'tool-res-' + Date.now(),
                role: 'assistant',
                text: 'PASS src/index.test.ts (4 passed, 4 total)\nTest Suites: 1 passed, 1 total\nSnapshots:   0 total\nTime:        1.42s',
                kind: 'tool/result',
                toolName: 'run_command',
                toolResult: 'PASS src/index.test.ts (4 passed, 4 total)',
                toolCallId: 'call_test_' + Date.now(),
              });

              list.push({
                key: 'assistant-reply-' + Date.now(),
                role: 'assistant',
                text: `指令 **"${text}"** 已在远程电脑执行完毕！\n\n- [x] 解析移动端语音/文字遥控意图\n- [x] 调用桌面本地环境执行命令\n- [x] 单元测试执行并通过 (4/4)\n\n电脑状态平稳，工作区无未提交的脏变更。`,
                kind: 'assistant/message',
              });

              // Update session preview
              const session = this.mockSessions.find((s) => s.sessionId === sid);
              if (session) {
                session.preview = text;
                session.updatedAt = Date.now();
                session.running = false;
              }
            }, 800);
          }, 600);

          resolve({ ok: true });
        } else if (norm === 'session.cancel') {
          const req = (args.request || {}) as { sessionId?: string };
          const sid = req.sessionId || '';
          const session = this.mockSessions.find((s) => s.sessionId === sid);
          if (session) session.running = false;
          resolve({ ok: true });
        } else {
          resolve({ ok: true });
        }
      }, 150);
    });
  }

  // Trigger interactive approval or question for testing
  public triggerSimulatedPrompt(pending: PendingPrompt) {
    this.requestListeners.forEach((fn) =>
      fn({
        rpcId: pending.rpcId,
        method: pending.method,
        payload: {
          questions: pending.questionId
            ? [
                {
                  id: pending.questionId,
                  header: pending.title,
                  question: pending.body,
                  options: pending.options.map((opt) => ({ label: opt })),
                },
              ]
            : undefined,
          displayReason: pending.body,
          toolName: 'execute_sensitive_shell_script',
        },
        answerable: true,
      }),
    );
  }
}
