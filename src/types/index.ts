export type HostConnectionMode = 'auto' | 'lan' | 'wan';

export interface HostRecord {
  id: string;
  label: string;
  baseUrl: string;
  /** 局域网高速直连地址（如 http://192.168.1.5:4142） */
  lanUrl?: string;
  /** 网关上报的所有候选局域网地址 */
  lanAddresses?: string[];
  /** 当前生效的活跃地址（局域网或公网） */
  activeUrl?: string;
  /** 连接策略：auto（默认，同局域网优先并自动回退公网）| lan（仅局域网）| wan（仅公网服务器） */
  connectionMode?: HostConnectionMode;
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
  /** 当前连接是否通过局域网高速通道 */
  isLan?: boolean;
  /** 当前生效连接的实际地址 */
  effectiveUrl?: string;
  /** 当前往返延迟（毫秒） */
  pingMs?: number;
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
  /**
   * 该消息引用的图片附件（主机侧引用，字节需经 `session/attachment` 取）。
   *
   * 🔴 纯图片消息的 `text` 为空 —— 没有它，这条消息在界面上**整条不存在**。
   */
  imageRefs?: Array<{
    attachmentId: string;
    mediaType: string;
    bytes?: number;
    width?: number;
    height?: number;
    name?: string;
  }>;
}

export interface PromptQuestionOption {
  label: string;
  description?: string;
}

export interface PromptQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options: PromptQuestionOption[];
  multiSelect?: boolean;
}

export interface PendingPrompt {
  rpcId: string;
  method: string;
  title: string;
  body: string;
  options: string[];
  questionId?: string | null;
  approval: boolean;
  questions?: PromptQuestion[];
  multiSelect?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  reasoning?: { efforts: string[] };
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelInfo[];
}

export interface ModelCatalog {
  default?: { provider: string; model: string };
  routableProviders?: string[];
  groups: ModelGroup[];
}

export type StepStatus = 'COMPLETED' | 'RUNNING' | 'PENDING';

export interface TaskStep {
  title: string;
  status: StepStatus;
  detail?: string | null;
}

