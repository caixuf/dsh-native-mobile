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
  X,
} from 'lucide-react';
import { ChatLine, PendingPrompt, TaskStep } from '../../types';
import { MarkdownView } from '../common/MarkdownView';
import { DisclosureToolCard } from '../chat/DisclosureToolCard';
import { TaskProgressCard } from '../chat/TaskProgressCard';
import { VoiceRecordingOverlay } from '../chat/VoiceRecordingOverlay';
import { QueuedMessagesBar } from '../chat/QueuedMessagesBar';
import { CollapsibleMessage } from '../chat/CollapsibleMessage';
import { clearDraft, loadDraft, loadExpandedKeys, saveDraft, saveExpandedKeys } from '../chat/draft-store';
import { ConnectionDot } from '../common/ConnectionDot';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
import type { QueuedMessage } from '../../lib/message-queue';

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
  onBack: () => void;
  /**
   * 返回 `false` = **上层未接收**（发送失败）→ ChatScreen 必须保留草稿原文。
   * `true` / `void` 视为已接收（向后兼容旧实现）。
   */
  onSend: (text: string) => Promise<boolean> | boolean | void;
  onCancel: () => void;
  onApprove: (allow: boolean) => void;
  onAnswerOption: (text: string) => void;
  onOpenDrawer: () => void;
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
  onBack,
  onSend,
  onCancel,
  onApprove,
  onAnswerOption,
  onOpenDrawer,
}) => {
  const [inputText, setInputText] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
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
    setShowJumpToLatest((prev) => (prev === !atBottom ? prev : !atBottom));
  };

  const jumpToLatest = () => {
    followBottomRef.current = true;
    setShowJumpToLatest(false);
    scrollToBottom('smooth');
  };

  // 🔴 自动跟随只在"本来就在底部"时生效（原来无条件 scrollIntoView，
  //    用户上滑读历史时每条流式增量都会把他拽回底部）。
  useEffect(() => {
    if (followBottomRef.current) scrollToBottom();
  }, [lines, running, preparing]);

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
    if (!text) return;
    const targetSession = sessionId;
    setSendError(null);
    setDraftNotice(null);

    let accepted: boolean | void = true;
    try {
      accepted = await Promise.resolve(onSend(text));
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

    // 已接收：清空。若期间切了会话，只清那条会话的持久化草稿，不动新会话输入框。
    if (activeSessionRef.current !== targetSession) {
      clearDraft(targetSession);
      return;
    }
    inputRef.current = '';
    setInputText('');
    clearDraft(targetSession);
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
    if (kind === 'tool/call' || kind === 'tool/result') continue;
    lastMessageKey = lineKeyOf(lines[i], i);
    break;
  }

  /** 流式光标：仅"实时链路健康 + 任务在跑"时显示（链路断了不假装还在输出）。 */
  const showStreamCursor = running && liveConnected === true;

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
    <div className="flex flex-col h-full bg-[#090a0f] text-[#f8fafc] mesh-glow-bg select-none">
      {/* 1. Studio Execution Context Bar */}
      <header className="sticky top-0 z-30 studio-glass border-b border-white/[0.08] px-4 py-2.5 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={onBack}
              type="button"
              aria-label="返回会话列表"
              className="w-11 h-11 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#e2e8f0] cursor-pointer studio-tap shrink-0"
            >
              <ArrowLeft size={17} />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <DeepSeekLogo size={16} variant="brand" className="shrink-0" />
                <h2 className="text-[14px] font-bold tracking-tight text-white truncate">
                  {title || '遥控会话'}
                </h2>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[#94a3b8] truncate mt-0.5">
                <span className="flex items-center gap-1.5 font-medium text-[#cbd5e1]">
                  <ConnectionDot status="online" size={6} />
                  <span>{hostName || '远程工作站'}</span>
                </span>
                {workspace && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 font-mono text-[#94a3b8] truncate max-w-[180px]">
                      <Folder size={11} className="text-[#3b82f6]" />
                      <span className="truncate">{workspace}</span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {running && (
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#38bdf8] bg-[#38bdf8]/15 border border-[#38bdf8]/30 px-2.5 py-1 rounded-full">
                <Loader2 size={11} className="animate-spin" />
                <span>执行中</span>
              </span>
            )}
            <button
              onClick={onOpenDrawer}
              type="button"
              aria-label="打开会话菜单"
              className="w-11 h-11 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#e2e8f0] transition-colors cursor-pointer studio-tap"
            >
              <Menu size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* 2. Chat Timeline */}
      <div
        ref={timelineRef}
        onScroll={handleTimelineScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 max-w-2xl w-full mx-auto pb-36"
      >
        {/* Task Progress Summary if steps exist */}
        {steps.length > 0 && <TaskProgressCard steps={steps} running={running} />}

        {/* Messages */}
        {lines.map((line, idx) => {
          const key = lineKeyOf(line, idx);
          const isLastMessage = showStreamCursor && key === lastMessageKey;

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
            // 超长用户消息（runtime context 动辄上万字）默认折叠为 6 行 + 复制
            return (
              <CollapsibleMessage
                key={key}
                messageKey={key}
                text={line.text}
                mode="plain"
                align="end"
                expanded={expandedKeys.has(key)}
                onToggleExpand={toggleExpanded}
                active={activeMessageKey === key}
                onActivate={setActiveMessageKey}
                showCursor={isLastMessage}
                bodyClassName="max-w-[84%] px-4 py-2.5 rounded-2xl rounded-br-xs bg-gradient-to-r from-[#2563eb] to-[#3b82f6] text-white text-[14.5px] leading-relaxed shadow-[0_0_20px_rgba(59,130,246,0.3)] break-words border border-white/10"
              />
            );
          }

          if (line.role === 'system') {
            return (
              <div key={key} className="flex justify-center my-2">
                <span className="px-3 py-1 rounded-full text-[11.5px] text-[#94a3b8] bg-[#141824] border border-white/[0.08]">
                  {line.text}
                </span>
              </div>
            );
          }

          // Assistant message: Obsidian Studio Specular Card（超长正文同样折叠）
          return (
            <CollapsibleMessage
              key={key}
              messageKey={key}
              text={line.text}
              mode="markdown"
              align="start"
              expanded={expandedKeys.has(key)}
              onToggleExpand={toggleExpanded}
              active={activeMessageKey === key}
              onActivate={setActiveMessageKey}
              showCursor={isLastMessage}
              bodyClassName="my-2.5 w-full specular-card p-4 rounded-3xl border border-white/10 shadow-xl"
              header={
                <div className="flex items-center gap-2 mb-2.5 pb-2 border-b border-white/[0.08]">
                  <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 flex items-center justify-center p-0.5 shadow-inner">
                    <DeepSeekLogo size={14} variant="brand" />
                  </div>
                  <span className="text-[12px] font-bold text-white tracking-wide">DeepSeek 远程执行响应</span>
                </div>
              }
            >
              <div className="text-[#f1f5f9] leading-relaxed">
                <MarkdownView content={line.text} />
              </div>
            </CollapsibleMessage>
          );
        })}

        {/* Prompt suggestion pills for quick trigger when lines are short */}
        {lines.length <= 2 && (
          <div className="pt-2">
            <div className="text-[11px] font-semibold text-[#64748b] mb-2 px-1 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={13} className="text-[#3b82f6]" />
              <span>快捷指令建议</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {quickPrompts.map((p, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => void handleSendText(p)}
                  className="px-3.5 py-2 min-h-[44px] rounded-xl bg-[#141824] hover:bg-[#1e2538] hover:border-[#3b82f6]/40 text-[#cbd5e1] hover:text-white border border-white/10 text-[12.5px] font-medium shadow-sm transition-all cursor-pointer studio-tap"
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
                    step <= preparingStep ? 'bg-[#3b82f6] shadow-[0_0_8px_rgba(59,130,246,0.6)]' : 'bg-white/10'
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Pending Approval or Question Card */}
        {pending && (
          <div className="p-5 rounded-3xl specular-card border-2 border-[#3b82f6] shadow-[0_0_30px_rgba(59,130,246,0.25)] animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2 text-[14px] font-bold text-white">
              {pending.approval ? (
                <AlertTriangle size={18} className="text-[#f59e0b]" />
              ) : (
                <HelpCircle size={18} className="text-[#38bdf8]" />
              )}
              <span>{pending.title}</span>
            </div>
            <p className="text-[13px] text-[#cbd5e1] mt-2.5 leading-relaxed whitespace-pre-wrap">
              {pending.body}
            </p>

            {pending.approval ? (
              <div className="flex items-center justify-end gap-2.5 mt-5 pt-3 border-t border-white/10">
                <button
                  type="button"
                  onClick={() => onApprove(false)}
                  aria-label="拒绝本次操作"
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-[#f43f5e]/30 text-[13px] font-medium text-[#fb7185] bg-[#f43f5e]/10 hover:bg-[#f43f5e]/20 transition-colors cursor-pointer studio-tap"
                >
                  拒绝 (Reject)
                </button>
                <button
                  type="button"
                  onClick={() => onApprove(true)}
                  aria-label="允许一次"
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[13px] font-semibold shadow-[0_0_20px_rgba(59,130,246,0.4)] transition-transform cursor-pointer studio-tap"
                >
                  允许一次 (Allow Once)
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-white/10">
                {pending.options.map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onAnswerOption(opt)}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#141824] hover:bg-[#3b82f6] hover:text-white text-[13px] font-medium text-[#cbd5e1] transition-all cursor-pointer border border-white/10 studio-tap"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 只有工具卡时才需要独立的流式光标（消息类行自己会带） */}
        {showStreamCursor && lastMessageKey === null && (
          <div className="flex items-center gap-2 px-1" role="status">
            <span className="inline-block w-[7px] h-[15px] rounded-[2px] bg-[#38bdf8] animate-pulse" />
            <span className="text-[11.5px] text-[#64748b]">正在输出…</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 3. Floating Composer Dock */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-[#090a0f] via-[#090a0f]/95 to-transparent pt-6 pb-5 px-4">
        <div className="max-w-2xl mx-auto">
          {/* 上滑看历史时才出现；点了回底部并恢复自动跟随 */}
          {showJumpToLatest && (
            <div className="flex justify-center mb-2">
              <button
                type="button"
                onClick={jumpToLatest}
                aria-label="跳到最新消息"
                className="flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-[#141824]/95 border border-[#3b82f6]/40 text-[#93c5fd] text-[12px] font-medium shadow-lg hover:bg-[#1e2538] backdrop-blur-sm cursor-pointer studio-tap"
              >
                <ChevronDown size={14} />
                <span>跳到最新</span>
              </button>
            </div>
          )}
          {/* Live event stream status: 断开时明说，不静默假装正常 */}
          {liveConnected === false && (
            <div
              role="status"
              className="flex items-center gap-1.5 mb-2 px-3 py-1.5 rounded-xl bg-[#f59e0b]/10 border border-[#f59e0b]/30 text-[11.5px] text-[#fcd34d]"
            >
              <AlertTriangle size={12} className="shrink-0" />
              <span>实时事件流未连接：消息会先入队，恢复后按序补发，结果可能延迟</span>
            </div>
          )}

          {/* 发送失败：明确告知"字没丢"，并给一键重试 */}
          {sendError && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-center gap-2 mb-2 px-3 py-2 rounded-xl bg-[#f43f5e]/12 border border-[#f43f5e]/35 text-[11.5px] text-[#fda4af]"
            >
              <AlertTriangle size={13} className="shrink-0" />
              <span className="flex-1">{sendError}</span>
              <button
                type="button"
                onClick={() => void handleSendText(inputText)}
                aria-label="重试发送当前草稿"
                className="min-h-[44px] px-3 rounded-xl flex items-center gap-1.5 text-[11.5px] font-semibold text-[#fb7185] bg-[#f43f5e]/15 hover:bg-[#f43f5e]/25 border border-[#f43f5e]/35 cursor-pointer studio-tap"
              >
                <RefreshCw size={13} />
                <span>重试</span>
              </button>
              <button
                type="button"
                onClick={() => setSendError(null)}
                aria-label="关闭发送失败提示"
                className="w-11 h-11 rounded-xl flex items-center justify-center text-[#fda4af] hover:text-white bg-white/[0.05] hover:bg-white/[0.12] border border-white/[0.08] cursor-pointer studio-tap"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* 草稿恢复提示：恢复必须是可见的 */}
          {draftNotice && !sendError && (
            <div
              role="status"
              className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-[#3b82f6]/10 border border-[#3b82f6]/30 text-[11.5px] text-[#93c5fd]"
            >
              <Sparkles size={12} className="shrink-0" />
              <span className="flex-1">{draftNotice}</span>
              <button
                type="button"
                onClick={() => setDraftNotice(null)}
                aria-label="关闭草稿恢复提示"
                className="w-11 h-11 rounded-xl flex items-center justify-center text-[#93c5fd] hover:text-white bg-white/[0.05] hover:bg-white/[0.12] border border-white/[0.08] cursor-pointer studio-tap"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* 待发队列（运行中补的话都在这里，可展开/删除/重试） */}
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
                className="flex items-center gap-1.5 min-h-[44px] px-4 rounded-full bg-[#1e131d] border border-[#f43f5e]/40 text-[#fb7185] text-[12px] font-medium shadow-lg hover:bg-[#2b1725] transition-transform cursor-pointer studio-tap"
              >
                <Square size={11} fill="currentColor" />
                <span>停止当前任务</span>
              </button>
            </div>
          )}

          <div className="flex items-end gap-2.5 studio-glass-dock p-2 rounded-3xl transition-all focus-within:border-[#3b82f6]/50 focus-within:ring-2 focus-within:ring-[#3b82f6]/30">
            {/* 🔴 运行中/发送中**都不禁用**：继续输入即入队（历史缺陷：Composer(enabled = !running)） */}
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
                  : '发送遥控指令，例如：检查 git 状态、运行测试…'
              }
              className="flex-1 max-h-32 min-h-[44px] py-2 px-3 text-[14px] leading-relaxed resize-none focus:outline-hidden bg-transparent text-white placeholder:text-[#64748b]"
            />

            {/* Voice Dictation Button */}
            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              aria-label="语音遥控"
              className="w-11 h-11 rounded-xl bg-white/[0.06] text-[#94a3b8] hover:text-[#38bdf8] hover:bg-white/[0.1] border border-white/[0.08] flex items-center justify-center transition-colors cursor-pointer studio-tap shrink-0"
              title="语音遥控"
            >
              <Mic size={18} />
            </button>

            {/* Send Arrow Button：只按"有没有内容"禁用，不再看 sending/running */}
            <button
              type="button"
              disabled={!inputText.trim()}
              onClick={handleSend}
              aria-label={running || sending ? '加入待发队列' : '发送'}
              className="w-11 h-11 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white disabled:opacity-30 flex items-center justify-center transition-all shadow-[0_0_15px_rgba(59,130,246,0.5)] cursor-pointer studio-tap shrink-0"
            >
              <Send size={16} />
            </button>
          </div>

          <p id="composer-hint" className="mt-1.5 px-2 text-[10.5px] text-[#64748b]">
            {running
              ? '任务执行中：Enter 发送即入队，不会被丢弃'
              : sending
                ? '正在发送：继续输入会排队，按序发出'
                : 'Enter 发送 · Shift+Enter 换行 · 草稿自动保存（切会话/退出不丢）'}
          </p>
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
    </div>
  );
};
