export interface HostRecord {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
  deviceId: string;
  instanceName: string;
  pairedAt: number;
  lastUsedAt: number;
}

export type LinkStateType = 'disconnected' | 'connecting' | 'ready' | 'degraded';

export interface LinkState {
  type: LinkStateType;
  hostName?: string;
  attempt?: number;
  reason?: string;
}

export interface SessionRow {
  sessionId: string;
  title: string;
  preview: string;
  updatedAt: number;
  running: boolean;
  isSubagent: boolean;
  parentSessionId?: string | null;
  workspace?: string | null;
}

export interface ChatLine {
  key: string;
  role: 'user' | 'assistant' | 'system' | 'agent';
  text: string;
  kind: 'user/message' | 'assistant/message' | 'system/message' | 'tool/call' | 'tool/result' | string;
  toolName?: string | null;
  toolArgs?: string | null;
  toolResult?: string | null;
  toolCallId?: string | null;
  /** 该工具调用实际耗时（毫秒）；App 按 callId 把 tool/call 与 tool/result 配对算出。 */
  toolMs?: number | null;
  /** 注入上下文的标注（如「记忆快照」）；只有 `kind === 'user/injected'` 才有。 */
  injectedLabel?: string | null;
  isError?: boolean;
}

export interface PendingPrompt {
  rpcId: string;
  method: string;
  title: string;
  body: string;
  options: string[];
  questionId?: string | null;
  approval: boolean;
}

export type StepStatus = 'COMPLETED' | 'RUNNING' | 'PENDING';

export interface TaskStep {
  title: string;
  status: StepStatus;
  detail?: string | null;
}
