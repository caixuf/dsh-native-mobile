import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Menu,
  Send,
  Mic,
  Square,
  Folder,
  AlertTriangle,
  HelpCircle,
  Loader2,
  Sparkles,
  Terminal,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  X,
  Paperclip,
  CheckSquare,
  Cpu,
  ThumbsUp,
  ThumbsDown,
  Copy,
  RotateCw,
  Plus,
  MoreHorizontal,
  Lightbulb,
} from 'lucide-react';
import { copyToClipboard } from '../chat/clipboard';
import { ChatLine, PendingPrompt, TaskStep, ModelCatalog } from '../../types';
import { MarkdownView } from '../common/MarkdownView';
import { DisclosureToolCard } from '../chat/DisclosureToolCard';
import { TaskProgressCard } from '../chat/TaskProgressCard';
import { VoiceRecordingOverlay } from '../chat/VoiceRecordingOverlay';
import { QueuedMessagesBar } from '../chat/QueuedMessagesBar';
import { SessionStatsBar } from '../chat/SessionStatsBar';
import { CollapsibleMessage } from '../chat/CollapsibleMessage';
import { QuestionCard } from '../chat/QuestionCard';
import { ModelPicker } from '../chat/ModelPicker';
import { CommandPalette } from '../chat/CommandPalette';
import { ChangedFilesCard } from '../chat/ChangedFilesCard';
import { AttachmentBar, ImageAttachment } from '../chat/AttachmentBar';
import { clearDraft, loadDraft, loadExpandedKeys, saveDraft, saveExpandedKeys } from '../chat/draft-store';
import { ConnectionDot } from '../common/ConnectionDot';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
import { DeepSeekMascot } from '../common/DeepSeekMascot';
import { triggerHaptic } from '../../utils/haptics';
import type { QueuedMessage } from '../../lib/message-queue';
import { elapsedMs, formatDuration, modelLabel, phaseLabel, turnSummary } from '../../lib/session-activity';
import type { ActivityState } from '../../lib/session-activity';
import { describeWorkspace } from '../../lib/session-groups';
import { Laptop } from 'lucide-react';

interface Props {
  sessionId: string;
  title: string;
  lines: ChatLine[];
  pending: PendingPrompt | null;
  running: boolean;
  sending: boolean;
  preparing: boolean;
  preparingStep: number;
  hostName?: string;
  workspace?: string | null;
  /** 待发队列投影（App 维护；只给 id/text/createdAt 也能工作）。 */
  queued?: QueuedMessage[];
  onRemoveQueued?: (id: string) => void;
  /** 失败重试；缺省时 ChatScreen 用该项原文重新调用 onSend。 */
  onRetryQueued?: (id: string) => void;
  /** 实时事件流是否连着（断开时提示"会入队、结果可能延迟"）。 */
  liveConnected?: boolean;
  /**
   * 过程状态（App 从 `session/follow` 归约出来）。
   * 让界面能说出"现在到底在干什么"——对齐 GUI 的
   * 「已完成分析 / 正在分析请求 / 深度搜索中，用时 1分56秒」。
   * 缺省时 ChatScreen 只显示原有的"执行中"，不报错。
   */
  activity?: ActivityState | null;
  /**
   * 底部状态栏读数（轮/步/tok-s、token 与缓存命中、上下文占用）。
   * 缺省或字段缺失时**整块隐藏**，绝不显示 0 冒充真实值。
   */
  readouts?: { activity: string | null; usage: string | null; context: string | null; detail: Array<{ label: string; value: string }> } | null;
  onBack: () => void;
  /**
   * 返回 `false` = **上层未接收**（发送失败）→ ChatScreen 必须保留草稿原文。
   * `true` / `void` 视为已接收（向后兼容旧实现）。
   */
  onSend: (text: string, image?: { data: string; mediaType: string }) => Promise<boolean> | boolean | void;
  onCancel: () => void;
  onApprove: (allow: boolean) => void;
  onAnswerOption: (selected: string[] | string, customText?: string) => void;
  onOpenDrawer: () => void;
  onManageHosts?: () => void;
  onNewSession?: () => void;
  isDemoHost?: boolean;
  modelCatalog?: ModelCatalog | null;
  selectedModel?: { provider?: string; model?: string } | null;
  onSelectModel?: (provider: string, model: string) => Promise<boolean | void> | void;
}

export const ChatScreen: React.FC<Props> = ({
  sessionId,
  title,
  lines,
  pending,
  running,
  sending,
  preparing,
  preparingStep,
  hostName,
  workspace,
  queued,
  onRemoveQueued,
  onRetryQueued,
  liveConnected,
  activity,
  readouts,
  onBack,
  onSend,
  onCancel,
  onApprove,
  onAnswerOption,
  onOpenDrawer,
  onManageHosts,
  onNewSession,
  isDemoHost,
  modelCatalog,
  selectedModel,
  onSelectModel,
}) => {
  const [inputText, setInputText] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);

  const activeModelDisplayName =
    selectedModel?.model ||
    (activity && activity.model) ||
    modelCatalog?.default?.model ||
    'MiniMax-M3.1';
  /** 被手动展开过的消息 key（按会话持久化；默认折叠是大多数）。 */
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set(loadExpandedKeys(sessionId)));
  /** 长按激活的消息 key（移动端没有 hover，用长按唤出操作条）。 */
  const [activeMessageKey, setActiveMessageKey] = useState<string | null>(null);
  /** 用户上滑看历史时出现「跳到最新」。 */
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  /** 自动跟随开关：只在用户**本来就在底部**时为真，避免把读历史的人拽走。 */
  const followBottomRef = useRef(true);
  // 当前会话 + 当前输入的最新值（用于 await 期间切会话 / 卸载时的正确处理）
  const activeSessionRef = useRef(sessionId);
  const inputRef = useRef(inputText);
  inputRef.current = inputText;

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
  };

  /** 滚动位置 → 是否贴底（80px 容差：手指抖动/惯性不算"离开底部"）。 */
  const handleTimelineScroll = () => {
    const el = timelineRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 80;
    followBottomRef.current = atBottom;
    setShowJumpToLatest(lines.length > 0 && !atBottom);
  };

  const jumpToLatest = () => {
    triggerHaptic('light');
    followBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollToBottom('smooth');
  };

  const pendingCardRef = useRef<HTMLDivElement>(null);

  // 🔴 自动跟随只在"本来就在底部"时生效（原来无条件 scrollIntoView，
  //    用户上滑读历史时每条流式增量都会把他拽回底部）。
  useEffect(() => {
    if (followBottomRef.current) scrollToBottom();
  }, [lines, running, preparing]);

  // 当出现待批准操作或选项提问时，这是最高优先级交互，确保卡片平滑滚动到屏幕中央，绝不被遮挡
  useEffect(() => {
    if (pending) {
      triggerHaptic('warning');
      const timer = setTimeout(() => {
        pendingCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [pending]);

  // 切会话：恢复该会话的草稿与展开状态，并给出**可见**提示（静默恢复 = 没恢复）
  useEffect(() => {
    activeSessionRef.current = sessionId;
    const restored = loadDraft(sessionId);
    setInputText(restored.text);
    inputRef.current = restored.text;
    setDraftNotice(restored.restored ? '已恢复上次未发送的草稿' : null);
    setSendError(null);
    setExpandedKeys(new Set(loadExpandedKeys(sessionId)));
    setActiveMessageKey(null);
    // 换会话一律先贴底（否则新会话会停在上一会话的滚动位置）
    followBottomRef.current = true;
    setShowJumpToLatest(false);
    const frame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => scrollToBottom('auto'))
        : 0;
    return () => {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    };
  }, [sessionId]);

  /** 折叠/展开并**按会话持久化**（切走再回来不丢）。 */
  const toggleExpanded = (key: string) => {
    const next = new Set(expandedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedKeys(next);
    saveExpandedKeys(sessionId, next);
  };

  // 离开会话 / 卸载：把当前输入落盘（"退出不丢"）
  useEffect(() => {
    return () => {
      saveDraft(sessionId, inputRef.current);
    };
  }, [sessionId]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    inputRef.current = value;
    setInputText(value);
    setSendError(null);
    if (draftNotice) setDraftNotice(null);
    saveDraft(sessionId, value);
  };

  /**
   * 发送 / 入队 —— 三个缺陷的核心修复点：
   *  - 不再用 `sending` 或 `running` 拦输入（运行中也能补话，App 侧入队）；
   *  - **先 await onSend 再决定是否清空草稿**（不是先清空后调用）；
   *  - 上游返回 `false`（含抛异常）时把原文写回输入框 + 落盘，一条都不丢。
   */
  const handleSendText = async (raw: string) => {
    const text = raw.trim();
    if (!text && !attachment) return;
    triggerHaptic('medium');
    const targetSession = sessionId;
    setSendError(null);
    setDraftNotice(null);

    let accepted: boolean | void = true;
    try {
      const imagePayload = attachment ? { data: attachment.data, mediaType: attachment.mediaType } : undefined;
      accepted = imagePayload ? await Promise.resolve(onSend(text, imagePayload)) : await Promise.resolve(onSend(text));
    } catch (error) {
      accepted = false;
      setSendError(`发送异常：${error instanceof Error ? error.message : String(error)}`);
    }

    // 🔴 只有明确"未接收"才走保留分支；true / undefined 视为已接收（向后兼容）。
    if (accepted === false) {
      if (activeSessionRef.current !== targetSession) return;
      const current = inputRef.current;
      // 用户在等待期间又打了新字 → 不覆盖；否则把原文原样放回输入框。
      const kept = current.trim() === '' ? text : current;
      inputRef.current = kept;
      setInputText(kept);
      saveDraft(targetSession, kept);
      setSendError((prev) => prev || '消息未发送成功，草稿已保留，可直接重试');
      return;
    }

    setAttachment(null);
    // 已接收：清空。若期间切了会话，只清那条会话的持久化草稿，不动新会话输入框。
    if (activeSessionRef.current !== targetSession) {
      clearDraft(targetSession);
      return;
    }
    inputRef.current = '';
    setInputText('');
    clearDraft(targetSession);
  };

  const togglePlanMode = () => {
    triggerHaptic('selection');
    const next = !planMode;
    setPlanMode(next);
    void handleSendText(next ? '/plan' : '/plan off');
  };

  const handleSend = () => {
    void handleSendText(inputText);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Extract task steps from current round of lines
  const extractSteps = (): TaskStep[] => {
    const steps: TaskStep[] = [];

    for (const line of lines) {
      if (line.role === 'assistant' || line.role === 'agent') {
        const lineTexts = line.text.split('\n');
        for (const lt of lineTexts) {
          const match = lt.match(/^[-*]\s*\[([ xX])\]\s*(.+)$/);
          if (match) {
            const isChecked = match[1].toLowerCase() === 'x';
            steps.push({
              title: match[2].trim(),
              status: isChecked ? 'COMPLETED' : running ? 'RUNNING' : 'PENDING',
            });
          }
        }
      }
    }

    if (steps.length === 0 && running) {
      return [{ title: '电脑端正在执行遥控任务…', status: 'RUNNING' }];
    }

    return steps;
  };

  const steps = extractSteps();

  // 工具结果配对：桌面端行为是"结果并回对应调用卡片"；
  // 配不上 callId 的独立结果单独成卡（kind='tool/result'，与调用视觉可区分）。
  const resultByCallId = new Map<string, ChatLine>();
  for (const line of lines) {
    if (line.kind === 'tool/result' && line.toolCallId && !resultByCallId.has(line.toolCallId)) {
      resultByCallId.set(line.toolCallId, line);
    }
  }

  const handleRetryQueued = (id: string) => {
    if (onRetryQueued) {
      onRetryQueued(id);
      return;
    }
    const item = (queued || []).find((entry) => entry.id === id);
    if (item) void handleSendText(item.text);
  };

  /** 消息 key：与下方 map 完全一致（折叠状态/流式光标都按它定位）。 */
  const lineKeyOf = (line: ChatLine, index: number) => line.key || `idx-${index}`;

  /** 最后一条"消息类"行（跳过工具卡）—— 流式光标挂在它尾部。 */
  let lastMessageKey: string | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const kind = lines[i].kind;
    if (kind === 'tool/call' || kind === 'tool/result' || kind === 'step/start') continue;
    lastMessageKey = lineKeyOf(lines[i], i);
    break;
  }

  /** 流式光标：仅"实时链路健康 + 任务在跑"时显示（链路断了不假装还在输出）。 */
  const showStreamCursor = running && liveConnected === true;

  // 「用时 1分56秒」必须**自己走**，不能等下一条事件才刷新 ——
  // 工具跑一分钟时事件可能一直不来，只靠事件驱动会让计时停在原地。
  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const activityOn = running && !!activity && activity.phase !== 'idle';
  const activityText = activityOn ? phaseLabel(activity as ActivityState, clockTick) : '';
  const activityModel = activityOn ? modelLabel(activity as ActivityState) : '';
  const activityElapsed = activityOn ? formatDuration(elapsedMs(activity as ActivityState, clockTick)) : '';
  /**
   * 跑完之后的总结（`3 步 · 2 次工具调用 · 用时 42秒 · 输出 1.2k tokens`）。
   * 只在"刚跑完一轮"时出现；数据不足就显示空 —— 不塞"0 步 0 秒"这种噪音。
   */
  const summaryText = !running && activity ? turnSummary(activity as ActivityState, clockTick) : '';

  // 注入上下文默认收起；用户手动展开的才记住（这些键只在本会话有效）。
  const [injectedOpenKeys, setInjectedOpenKeys] = useState<Set<string>>(new Set());
  const toggleInjected = (key: string) =>
    setInjectedOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const preparingStages = [
    '唤醒远程守护进程…',
    '加载桌面环境知识与工具…',
    '准备工作空间上下文…',
    '即将开始执行…',
  ];

  const quickPrompts = [
    '检查当前工作区 git 状态与分支',
    '运行自动化测试套件并列出耗时',
    '查看构建输出与端口监听情况',
    '读取 package.json 依赖配置',
  ];

  return (
    <div className="flex flex-col h-full bg-white text-[#18181b] select-none">
      {/* 1. MiniMax Light Header (对齐 MiniMax 主界面：左侧汉堡菜单，右侧新会话与更多) */}
      <header
        className={`sticky top-0 z-30 transition-all px-4 py-2 ${
          lines.length === 0
            ? 'bg-transparent border-b border-transparent'
            : 'bg-white/95 backdrop-blur-md border-b border-gray-100'
        }`}
      >
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {lines.length === 0 ? (
              <button
                onClick={() => {
                  triggerHaptic('light');
                  onOpenDrawer();
                }}
                type="button"
                aria-label="打开会话菜单"
                className="w-11 h-11 rounded-full hover:bg-gray-100/80 flex items-center justify-center text-gray-800 cursor-pointer shrink-0"
              >
                <Menu size={22} strokeWidth={1.8} />
              </button>
            ) : (
              <button
                onClick={() => {
                  triggerHaptic('light');
                  onBack();
                }}
                type="button"
                aria-label="返回会话列表"
                className="w-11 h-11 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-800 cursor-pointer shrink-0"
              >
                <ArrowLeft size={20} />
              </button>
            )}
            {lines.length > 0 && (
              <div className="min-w-0">
                <h2 className="text-[15px] font-bold tracking-tight text-gray-900 truncate">
                  {title || '新会话'}
                </h2>
                <div className="flex items-center gap-1.5 text-[11px] text-[#52525b] truncate">
                  <span className="truncate">{hostName || 'caixuf'}</span>
                  {workspace && (
                    <>
                      <span>·</span>
                      <span
                        className="truncate font-medium text-gray-700 max-w-[130px]"
                        title={workspace}
                      >
                        {describeWorkspace(workspace).label}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {running && (
              <span
                className="flex items-center gap-1.5 text-[11px] font-medium text-blue-600 theme-text-accent bg-blue-50 px-2.5 py-1 rounded-full shrink-0"
                data-testid="activity-badge"
                data-phase={activityOn ? (activity as ActivityState).phase : 'unknown'}
                title={activityModel ? `模型：${activityModel}` : undefined}
              >
                <Loader2 size={11} className="animate-spin shrink-0" />
                <span className="truncate">{activityText || '执行中'}</span>
                {activityElapsed && <span className="font-mono shrink-0">· {activityElapsed}</span>}
              </span>
            )}
            {!running && summaryText && (
              <span
                data-testid="turn-summary"
                className="text-[11px] text-[#52525b] bg-gray-100 px-2.5 py-1 rounded-full max-w-[120px] sm:max-w-[180px] shrink-0 truncate font-mono"
              >
                {summaryText}
              </span>
            )}
            {lines.length > 0 && (
              <button
                type="button"
                onClick={togglePlanMode}
                aria-label={`计划模式：${planMode ? '已开启' : '已关闭'}`}
                className={`flex items-center gap-1 px-2.5 py-1 min-h-[44px] rounded-full text-[11px] font-mono transition-colors cursor-pointer shrink-0 ${
                  planMode
                    ? 'bg-purple-100 text-purple-700 border border-purple-300 font-semibold'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                title={planMode ? '点击退出计划模式' : '点击开启计划模式'}
              >
                <CheckSquare size={11} className={planMode ? 'text-purple-600' : 'text-[#52525b]'} />
                <span>{planMode ? 'Plan' : 'Plan'}</span>
              </button>
            )}
            {onNewSession && (
              <button
                onClick={() => {
                  triggerHaptic('light');
                  onNewSession();
                }}
                type="button"
                aria-label="开启新会话"
                className="theme-text-accent w-11 h-11 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors cursor-pointer"
                title="开启新会话"
              >
                <Plus size={20} />
              </button>
            )}
            <button
              onClick={() => {
                triggerHaptic('light');
                onOpenDrawer();
              }}
              type="button"
              aria-label="打开侧边菜单"
              className="w-11 h-11 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-700 transition-colors cursor-pointer"
            >
              <MoreHorizontal size={19} />
            </button>
          </div>
        </div>
      </header>

      {/* 1.1 Session Performance & Readouts Bar (对齐桌面端 StatsPills，置顶展开，不遮挡底栏操作) */}
      <SessionStatsBar
        activity={(readouts && readouts.activity) || null}
        usage={(readouts && readouts.usage) || null}
        context={(readouts && readouts.context) || null}
        detail={(readouts && readouts.detail) || []}
      />

      {/* 2. Chat Timeline */}
      <div
        ref={timelineRef}
        onScroll={handleTimelineScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 max-w-2xl w-full mx-auto pb-[calc(16rem+var(--sab)+var(--keyboard-inset-bottom,0px))]"
      >
        {/* MiniMax Empty State: Iconic Mascot & "有什么可以帮忙的" */}
        {lines.length === 0 && (
          <div className="h-full min-h-[50vh] flex flex-col items-center justify-center text-center px-4 select-none animate-in fade-in duration-300">
            <div className="mb-4 p-2 rounded-full hover:bg-blue-50/50 transition-colors">
              <DeepSeekMascot size={80} interactive={true} />
            </div>
            <h1 className="text-[26px] font-bold tracking-tight text-gray-900 mb-6">
              有什么可以帮忙的
            </h1>
            <div className="flex flex-wrap justify-center gap-2 max-w-sm">
              {quickPrompts.slice(0, 3).map((p, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    void handleSendText(p);
                  }}
                  className="px-3.5 py-2 min-h-[44px] rounded-full bg-gray-50 hover:bg-gray-100 text-gray-700 border border-gray-200 text-xs font-medium shadow-2xs transition-all cursor-pointer"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Task Progress Summary if steps exist */}
        {steps.length > 0 && <TaskProgressCard steps={steps} running={running} />}

        {/* Messages */}
        {lines.map((line, idx) => {
          const key = lineKeyOf(line, idx);
          const isLastMessage = showStreamCursor && key === lastMessageKey;

          // 步骤分隔线：`step/start` 事件渲染成"── 第 N 步 ──"（GUI 里也是这么分的）。
          // 它不是消息，所以必须在下面的消息分支之前拦掉。
          if (line.kind === 'step/start') {
            return (
              <div
                key={key}
                data-testid="step-marker"
                className="flex items-center gap-3 py-2.5 select-none"
              >
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-white/12 to-white/12" />
                <span className="text-[11px] font-semibold tracking-wide text-[#52525b] shrink-0">
                  {line.text}
                </span>
                <span className="h-px flex-1 bg-gradient-to-r from-white/12 via-white/12 to-transparent" />
              </div>
            );
          }

          // 宿主注入的上下文（运行时上下文 / 记忆快照 / 技能清单…）
          // 真机实测手机上一进来就是 7000+ 字的记忆快照，以用户气泡形式铺在最前面 ——
          // 既挤掉真正的对话，又让人以为"我什么时候发过这个"。这里折叠成一条安静注记。
          if (line.kind === 'user/injected') {
            const injectedOpen = injectedOpenKeys.has(key);
            return (
              <div key={key} className="my-1" data-testid="injected-note" data-label={line.injectedLabel || ''}>
                <button
                  type="button"
                  onClick={() => toggleInjected(key)}
                  aria-expanded={injectedOpen}
                  aria-label={`${line.injectedLabel || '上下文'}，共 ${line.text.length} 字，点${injectedOpen ? '收起' : '展开查看'}`}
                  className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-black/[0.08] bg-black/[0.02] text-left cursor-pointer studio-tap"
                >
                  {injectedOpen ? (
                    <ChevronDown size={13} className="text-[#52525b] shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="text-[#52525b] shrink-0" />
                  )}
                  <span className="text-[11.5px] text-[#52525b] truncate">
                    {line.injectedLabel || '上下文'} · 由电脑端注入，不是你发的（{line.text.length} 字）
                  </span>
                </button>
                {injectedOpen && (
                  <div className="mt-1.5 px-3 py-2 rounded-xl bg-black/25 border border-black/[0.06]">
                    <pre className="text-[11px] leading-[1.5] text-[#52525b] whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">
                      {line.text}
                    </pre>
                  </div>
                )}
              </div>
            );
          }

          if (line.kind === 'tool/call') {
            // 结果可能在后续的 tool/result 事件里（App 按 seq 逐条映射），这里配对回来
            const paired = line.toolCallId ? resultByCallId.get(line.toolCallId) : undefined;
            const result = line.toolResult ?? paired?.toolResult ?? paired?.text ?? undefined;
            return (
              <div key={key} className="my-1.5">
                <DisclosureToolCard
                  toolName={line.toolName}
                  toolArgs={line.toolArgs}
                  toolResult={result}
                  toolMs={line.toolMs ?? paired?.toolMs ?? null}
                  isError={Boolean(line.isError || paired?.isError)}
                  kind="tool/call"
                />
              </div>
            );
          }

          if (line.kind === 'tool/result') {
            // 已并回对应 call 卡片的结果不再重复成卡；独立结果单独展示（原来这里直接 return null → 结果全丢）
            if (line.toolCallId && resultByCallId.get(line.toolCallId) === line) {
              const callLine = lines.find((l) => l.kind === 'tool/call' && l.toolCallId === line.toolCallId);
              if (callLine) return null;
            }
            return (
              <div key={key} className="my-1.5">
                <DisclosureToolCard
                  toolName={line.toolName ?? '工具结果'}
                  toolArgs={line.toolArgs}
                  toolResult={line.toolResult ?? line.text}
                  isError={line.isError}
                  kind="tool/result"
                />
              </div>
            );
          }

          if (line.role === 'user') {
            // 超长用户消息默认折叠为 6 行 + 复制
            return (
              <CollapsibleMessage
                key={key}
                messageKey={key}
                text={line.text}
                mode="plain"
                align="end"
                messageRole="user"
                expanded={expandedKeys.has(key)}
                onToggleExpand={toggleExpanded}
                active={activeMessageKey === key}
                onActivate={setActiveMessageKey}
                showCursor={isLastMessage}
                bodyClassName="max-w-[85%] px-4 py-2.5 rounded-2xl bg-[#f4f4f5] text-[#18181b] text-[14.5px] leading-relaxed shadow-2xs break-words border border-gray-200/60"
              />
            );
          }

          if (line.role === 'system') {
            return (
              <div key={key} className="flex justify-center my-2">
                <span className="px-3 py-1 rounded-full text-[11.5px] text-[#52525b] bg-gray-100 border border-gray-200/60">
                  {line.text}
                </span>
              </div>
            );
          }

          // Assistant message: CollapsibleMessage with MiniMax light style + Action Bar
          return (
            <CollapsibleMessage
              key={key}
              messageKey={key}
              text={line.text}
              mode="markdown"
              align="start"
              messageRole="assistant"
              expanded={expandedKeys.has(key)}
              onToggleExpand={toggleExpanded}
              active={activeMessageKey === key}
              onActivate={setActiveMessageKey}
              showCursor={isLastMessage}
              bodyClassName="my-2.5 w-full text-[#18181b]"
            >
              <div className="space-y-2">
                <div
                  className="text-[#18181b] leading-relaxed text-[15px]"
                  data-message-body
                >
                  <MarkdownView content={line.text} streaming={isLastMessage && running} />
                </div>
                <div className="flex items-center gap-1 pt-1 text-[#52525b]">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      void copyToClipboard(line.text);
                    }}
                    aria-label="复制回答"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 text-[#52525b] hover:text-black transition-colors cursor-pointer"
                    title="复制"
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerHaptic('light')}
                    aria-label="赞同回答"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 text-[#52525b] hover:text-black transition-colors cursor-pointer"
                    title="赞同"
                  >
                    <ThumbsUp size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => triggerHaptic('light')}
                    aria-label="反对回答"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 text-[#52525b] hover:text-black transition-colors cursor-pointer"
                    title="反对"
                  >
                    <ThumbsDown size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('medium');
                      void handleSendText('请重新生成');
                    }}
                    aria-label="重新生成回答"
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 text-[#52525b] hover:text-black transition-colors cursor-pointer"
                    title="重新生成"
                  >
                    <RotateCw size={15} />
                  </button>
                  <span className="text-[11px] text-[#52525b] ml-auto font-mono pr-2">
                    {isLastMessage && running ? '生成中…' : '刚刚'}
                  </span>
                </div>
              </div>
            </CollapsibleMessage>
          );
        })}

        {/* Prompt suggestion pills for quick trigger when lines are short */}
        {lines.length > 0 && lines.length <= 2 && (
          <div className="pt-2">
            <div className="text-[11px] font-semibold text-[#52525b] mb-2 px-1 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={13} className="text-blue-500" />
              <span>快捷指令建议</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {quickPrompts.map((p, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    void handleSendText(p);
                  }}
                  className="px-3.5 py-2 min-h-[44px] rounded-xl bg-[#f4f4f6] hover:bg-[#eaeaea] text-gray-800 border border-gray-200/60 text-[12.5px] font-medium shadow-2xs transition-all cursor-pointer"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Preparing Stepper State */}
        {preparing && (
          <div className="p-4 rounded-2xl specular-card border border-[#3b82f6]/40 shadow-xl animate-pulse">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#60a5fa]">
              <Loader2 size={15} className="animate-spin" />
              <span>{preparingStages[preparingStep] || '电脑准备中…'}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 mt-2.5">
              {[0, 1, 2, 3].map((step) => (
                <div
                  key={step}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    step <= preparingStep ? 'bg-blue-600 shadow-sm' : 'bg-gray-200'
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Pending Approval or Question Card */}
        {pending && (
          <div ref={pendingCardRef} className="my-4 scroll-m-24" data-testid="pending-interaction">
            {pending.approval ? (
              <div className="p-5 rounded-3xl bg-white border-2 border-blue-500 shadow-xl animate-in zoom-in-95 duration-200">
                <div className="flex items-center gap-2 text-[14px] font-bold text-gray-900">
                  <AlertTriangle size={18} className="text-amber-500 shrink-0" />
                  <span>{pending.title}</span>
                </div>
                <p className="text-[13px] text-gray-600 mt-2.5 leading-relaxed whitespace-pre-wrap">
                  {pending.body}
                </p>
                <div className="flex items-center justify-end gap-3 mt-5 pt-3 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('medium');
                      onApprove(false);
                    }}
                    aria-label="拒绝本次操作"
                    className="min-h-[44px] px-4 py-2 rounded-xl border border-rose-200 text-[13px] font-medium text-rose-600 bg-rose-50 hover:bg-rose-100 transition-colors cursor-pointer"
                  >
                    拒绝 (Reject)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('success');
                      onApprove(true);
                    }}
                    aria-label="允许一次"
                    className="theme-bg-deep min-h-[44px] px-5 py-2 rounded-xl bg-black text-white text-[13px] font-semibold shadow-sm transition-transform cursor-pointer"
                  >
                    允许一次 (Allow Once)
                  </button>
                </div>
              </div>
            ) : (
              <QuestionCard
                prompt={pending}
                onSubmit={(selected, customText) => onAnswerOption(selected, customText)}
              />
            )}
          </div>
        )}

        {/* 只有工具卡时才需要独立的流式光标（消息类行自己会带） */}
        {showStreamCursor && lastMessageKey === null && (
          <div className="flex items-center gap-2 px-1" role="status">
            <span className="inline-block w-[7px] h-[15px] rounded-[2px] bg-blue-600 animate-pulse" />
            <span className="text-[11.5px] text-[#52525b]">正在输出…</span>
          </div>
        )}

        {/* 本轮改动文件卡片（审阅修改/新增的文件及差异） */}
        <ChangedFilesCard lines={lines} />

        <div ref={messagesEndRef} />
      </div>

      {/* 3. Floating MiniMax Composer Dock (Screenshot 5) */}
      <div className="fixed bottom-0 left-0 right-0 z-20 pointer-events-none bg-gradient-to-t from-white via-white/95 to-transparent pt-4 pb-[calc(1.25rem+var(--sab)+var(--keyboard-inset-bottom,0px))] px-4 transition-all duration-150">
        <div className="max-w-2xl mx-auto pointer-events-auto">
          {/* 上滑看历史时才出现；点了回底部并恢复自动跟随 */}
          {showJumpToLatest && (
            <div className="flex justify-center mb-2">
              <button
                type="button"
                onClick={jumpToLatest}
                aria-label="跳到最新消息"
                className="flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-white/95 border border-gray-200 text-gray-700 text-[12px] font-medium shadow-md hover:bg-gray-50 backdrop-blur-sm cursor-pointer"
              >
                <ChevronDown size={14} />
                <span>跳到最新</span>
              </button>
            </div>
          )}
          {/* Live event stream status */}
          {lines.length > 0 && liveConnected === false && (
            <div
              role="status"
              className="flex items-center gap-1.5 mb-2 px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-[11.5px] text-amber-800"
            >
              <AlertTriangle size={12} className="shrink-0 text-amber-600" />
              <span>实时事件流未连接：消息会先入队，恢复后按序补发，结果可能延迟</span>
            </div>
          )}

          {/* 发送失败 */}
          {sendError && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl bg-rose-50 border border-rose-200 text-[11.5px] text-rose-800"
            >
              <AlertTriangle size={13} className="shrink-0 text-rose-600" />
              <span className="flex-1">{sendError}</span>
              <button
                type="button"
                onClick={() => void handleSendText(inputText)}
                aria-label="重试发送当前草稿"
                className="min-h-[44px] px-3 rounded-xl flex items-center gap-1.5 text-[11.5px] font-semibold text-rose-700 bg-white border border-rose-200 cursor-pointer"
              >
                <RefreshCw size={13} />
                <span>重试</span>
              </button>
              <button
                type="button"
                onClick={() => setSendError(null)}
                aria-label="关闭发送失败提示"
                className="w-11 h-11 rounded-full flex items-center justify-center text-rose-700 hover:bg-rose-100 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* 草稿恢复提示 */}
          {draftNotice && !sendError && (
            <div
              role="status"
              className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-200 text-[11.5px] text-blue-800"
            >
              <Sparkles size={12} className="shrink-0 text-blue-600 theme-text-accent" />
              <span className="flex-1">{draftNotice}</span>
              <button
                type="button"
                onClick={() => setDraftNotice(null)}
                aria-label="关闭草稿恢复提示"
                className="w-11 h-11 rounded-full flex items-center justify-center text-blue-700 hover:bg-blue-100 cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* 待发队列 */}
          <QueuedMessagesBar
            queued={queued || []}
            running={running}
            onRemove={onRemoveQueued}
            onRetry={handleRetryQueued}
          />

          {/* Running cancel button */}
          {running && (
            <div className="flex justify-center mb-2.5">
              <button
                type="button"
                onClick={onCancel}
                className="flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-white border border-rose-200 text-rose-600 text-[12px] font-medium shadow-md hover:bg-rose-50 transition-transform cursor-pointer"
              >
                <Square size={11} fill="currentColor" />
                <span>停止当前任务</span>
              </button>
            </div>
          )}

          {/* Quick Command Palette */}
          <CommandPalette
            isOpen={commandPaletteOpen}
            onClose={() => setCommandPaletteOpen(false)}
            onSelect={(cmd) => {
              setInputText(cmd + ' ');
              setCommandPaletteOpen(false);
            }}
            filterText={inputText}
          />

          {/* Attachment Bar */}
          <AttachmentBar
            attachment={attachment}
            onRemove={() => setAttachment(null)}
            onAttach={(att) => setAttachment(att)}
            onInsertPath={(p) => setInputText((prev) => prev + p)}
            workspace={workspace}
          />

          {/* MiniMax Host Status Pill (对应用户截图左下角 caixuf 电脑连接标识) */}
          <div className="flex items-center justify-between mb-2 px-1">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                onManageHosts?.();
              }}
              aria-label="切换连接电脑"
              className="min-h-[44px] flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-[#f4f4f6] hover:bg-gray-200/70 border border-transparent text-[13px] font-medium text-gray-800 transition-all cursor-pointer group active:scale-95"
              title="点击查看或切换连接电脑"
            >
              <Laptop size={15} className="text-gray-700 group-hover:text-blue-600 theme-text-accent transition-colors" />
              <span className="font-medium text-gray-900">
                {hostName ? hostName.split('.')[0] : 'caixuf'}
              </span>
              <span
                className={`w-2 h-2 rounded-full ${
                  isDemoHost
                    ? 'bg-amber-400'
                    : liveConnected
                    ? 'bg-emerald-500'
                    : 'bg-gray-400'
                }`}
              />
              {isDemoHost && (
                <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.2 rounded-md font-semibold">
                  演练
                </span>
              )}
            </button>
          </div>

          {/* MiniMax Iconic Rounded-3xl Input Capsule Dock (Screenshot 5) */}
          <div className="p-3 rounded-3xl bg-[#f4f4f6] border border-gray-200/70 shadow-sm focus-within:border-gray-400 focus-within:bg-white transition-all">
            {/* Hidden File Input for Image Chooser */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const result = reader.result as string;
                  const base64Data = result.split(',')[1] || result;
                  setAttachment({
                    data: base64Data,
                    mediaType: file.type || 'image/png',
                    name: file.name,
                  });
                };
                reader.readAsDataURL(file);
                e.target.value = '';
              }}
            />

            {/* 上层：多行自适应文本域 */}
            <div className="w-full px-1">
              <textarea
                rows={1}
                value={inputText}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                aria-label="输入遥控指令"
                aria-describedby="composer-hint"
                enterKeyHint="send"
                autoComplete="off"
                placeholder={
                  running
                    ? '任务执行中，继续输入会进入待发队列…'
                    : '问点什么吧...'
                }
                className="w-full max-h-36 min-h-[40px] py-1 text-[15px] leading-relaxed resize-none focus:outline-hidden bg-transparent text-gray-900 placeholder:text-[#52525b] font-normal"
              />
            </div>

            {/* 下层：左侧添加/指令按钮，中间模型选择胶囊，右侧麦克风/发送 */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-200/50 mt-1">
              <div className="flex items-center gap-0.5">
                {/* 附件与图片 */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="添加图片附件"
                  className="min-h-[44px] min-w-[44px] rounded-full text-[#52525b] hover:text-black flex items-center justify-center transition-colors cursor-pointer shrink-0"
                  title="添加图片附件"
                >
                  <Plus size={19} />
                </button>

                {/* 快捷指令 */}
                <button
                  type="button"
                  onClick={() => setCommandPaletteOpen((prev) => !prev)}
                  aria-label="快捷指令"
                  className={`min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                    commandPaletteOpen
                      ? 'bg-blue-100 text-blue-700'
                      : 'text-[#52525b] hover:text-black'
                  }`}
                  title="快捷指令"
                >
                  <Terminal size={17} />
                </button>
              </div>

              <div className="flex items-center gap-2">
                {/* MiniMax Model Selector Pill (Screenshot 5: M3.1-Flash... default ⌵) */}
                <button
                  type="button"
                  onClick={() => setModelPickerOpen(true)}
                  aria-label={`切换模型：当前 ${activeModelDisplayName}`}
                  className="min-h-[44px] px-3.5 py-1.5 rounded-full bg-white hover:bg-gray-50 border border-gray-200/80 text-[12px] font-medium text-gray-700 shadow-2xs flex items-center gap-1.5 cursor-pointer shrink-0 max-w-[170px] truncate"
                  title="点击切换模型"
                >
                  <span className="truncate">{activeModelDisplayName} default</span>
                  <ChevronDown size={12} className="text-[#52525b] shrink-0" />
                </button>

                {/* 右侧：无输入时麦克风，有输入时黑色发送按钮 */}
                {!inputText.trim() && !attachment ? (
                  <button
                    type="button"
                    onClick={() => setVoiceOpen(true)}
                    aria-label="语音遥控"
                    className="min-h-[44px] min-w-[44px] rounded-full text-gray-600 hover:text-black flex items-center justify-center transition-colors cursor-pointer shrink-0"
                    title="语音遥控"
                  >
                    <Mic size={18} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    aria-label={running || sending ? '加入待发队列' : '发送'}
                    className="theme-bg-deep min-h-[44px] min-w-[44px] rounded-full bg-black hover:bg-gray-800 text-white flex items-center justify-center shadow-md active:scale-95 transition-all cursor-pointer shrink-0"
                    title={running ? '加入待发队列' : '发送'}
                  >
                    <Send size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="text-center mt-2.5">
            <span className="text-[11px] text-gray-400 select-none">
              内容由AI生成，重要信息请务必核查
            </span>
          </div>
        </div>
      </div>

      {/* Voice Recording Overlay */}
      <VoiceRecordingOverlay
        isOpen={voiceOpen}
        onSend={(text) => {
          setVoiceOpen(false);
          void handleSendText(text);
        }}
        onCancel={() => setVoiceOpen(false)}
      />

      {/* Model Selection Sheet */}
      <ModelPicker
        isOpen={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        catalog={modelCatalog || null}
        currentModel={selectedModel}
        onSelectModel={async (provider, model) => {
          if (onSelectModel) {
            await onSelectModel(provider, model);
          }
        }}
      />
    </div>
  );
};
