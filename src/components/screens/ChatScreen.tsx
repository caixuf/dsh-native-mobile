import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Menu, Send, Mic, Square, Folder, AlertTriangle, HelpCircle, Loader2, Terminal } from 'lucide-react';
import { ChatLine, PendingPrompt, TaskStep } from '../../types';
import { MarkdownView } from '../common/MarkdownView';
import { DisclosureToolCard } from '../chat/DisclosureToolCard';
import { TaskProgressCard } from '../chat/TaskProgressCard';
import { VoiceRecordingOverlay } from '../chat/VoiceRecordingOverlay';
import { ConnectionDot } from '../common/ConnectionDot';
import { DeepSeekLogo } from '../common/DeepSeekLogo';

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
  onBack: () => void;
  onSend: (text: string) => void;
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
  onBack,
  onSend,
  onCancel,
  onApprove,
  onAnswerOption,
  onOpenDrawer,
}) => {
  const [inputText, setInputText] = useState('');
  const [voiceOpen, setVoiceOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [lines, running, preparing]);

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

  const handleSend = () => {
    if (inputText.trim() && !sending) {
      onSend(inputText.trim());
      setInputText('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
    <div className="flex flex-col h-full bg-[#f2f2f7]">
      {/* 1. iOS Glass Execution Context Bar */}
      <header className="sticky top-0 z-30 ios-glass border-b border-[rgba(60,60,67,0.12)] px-4 py-2.5 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={onBack}
              type="button"
              className="w-8 h-8 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] flex items-center justify-center text-[#000000] cursor-pointer ios-spring-tap shrink-0"
            >
              <ArrowLeft size={17} />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <DeepSeekLogo size={16} variant="brand" className="shrink-0" />
                <h2 className="text-[14px] font-bold tracking-tight text-[#000000] truncate">
                  {title || '遥控会话'}
                </h2>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[#8e8e93] truncate mt-0.5">
                <span className="flex items-center gap-1 font-medium text-[#1c1c1e]">
                  <ConnectionDot status="online" size={6} />
                  <span>{hostName || '本地工作电脑'}</span>
                </span>
                {workspace && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 font-mono truncate max-w-[180px]">
                      <Folder size={11} className="text-[#3964fe]" />
                      <span className="truncate">{workspace}</span>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {running && (
              <span className="flex items-center gap-1 text-[11px] font-semibold text-[#3964fe] bg-[#edf2ff] px-2.5 py-1 rounded-full">
                <Loader2 size={11} className="animate-spin" />
                <span>电脑在忙</span>
              </span>
            )}
            <button
              onClick={onOpenDrawer}
              type="button"
              className="w-8 h-8 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] flex items-center justify-center text-[#000000] transition-colors cursor-pointer ios-spring-tap"
            >
              <Menu size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* 2. iOS Chat Timeline */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 max-w-2xl w-full mx-auto pb-36">
        {/* Task Progress Summary if steps exist */}
        {steps.length > 0 && <TaskProgressCard steps={steps} running={running} />}

        {/* Messages */}
        {lines.map((line, idx) => {
          if (line.kind === 'tool/call') {
            return (
              <div key={line.key || idx} className="my-1.5">
                <DisclosureToolCard
                  toolName={line.toolName}
                  toolArgs={line.toolArgs}
                  toolResult={line.toolResult}
                  isError={line.isError}
                />
              </div>
            );
          }

          if (line.kind === 'tool/result') {
            return null; // Merged into DisclosureToolCard
          }

          if (line.role === 'user') {
            return (
              <div key={line.key || idx} className="flex justify-end my-1">
                <div className="max-w-[82%] px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#3964fe] text-white text-[14.5px] leading-relaxed shadow-xs break-words">
                  {line.text}
                </div>
              </div>
            );
          }

          if (line.role === 'system') {
            return (
              <div key={line.key || idx} className="flex justify-center my-2">
                <span className="px-3 py-1 rounded-full text-[12px] text-[#8e8e93] bg-[rgba(118,118,128,0.12)]">
                  {line.text}
                </span>
              </div>
            );
          }

          // Assistant message: iOS styled card with DeepSeek badge header
          return (
            <div key={line.key || idx} className="my-2 bg-[#ffffff] p-4 rounded-3xl border border-[rgba(60,60,67,0.08)] shadow-2xs">
              <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-[rgba(60,60,67,0.06)]">
                <div className="w-5 h-5 rounded-lg bg-[#edf2ff] flex items-center justify-center p-0.5">
                  <DeepSeekLogo size={14} variant="brand" />
                </div>
                <span className="text-[12px] font-bold text-[#000000]">DeepSeek 远程执行响应</span>
              </div>
              <MarkdownView content={line.text} />
            </div>
          );
        })}

        {/* Prompt suggestion pills for quick trigger when lines are short */}
        {lines.length <= 2 && (
          <div className="pt-2">
            <div className="text-[11px] font-semibold text-[#8e8e93] mb-2 px-1 uppercase tracking-wider">
              快捷指令建议
            </div>
            <div className="flex flex-wrap gap-2">
              {quickPrompts.map((p, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onSend(p)}
                  className="px-3 py-1.5 rounded-xl bg-[#ffffff] hover:bg-[#edf2ff] hover:text-[#3964fe] text-[#1c1c1e] border border-[rgba(60,60,67,0.08)] text-[12.5px] font-medium shadow-2xs transition-all cursor-pointer ios-spring-tap"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Preparing Stepper State (iOS Island style) */}
        {preparing && (
          <div className="p-4 rounded-2xl bg-[#ffffff] border border-[#3964fe]/30 shadow-xs animate-pulse">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#3964fe]">
              <Loader2 size={15} className="animate-spin" />
              <span>{preparingStages[preparingStep] || '电脑准备中…'}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 mt-2.5">
              {[0, 1, 2, 3].map((step) => (
                <div
                  key={step}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    step <= preparingStep ? 'bg-[#3964fe]' : 'bg-[#e5e5ea]'
                  }`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Pending Approval or Question Card */}
        {pending && (
          <div className="p-5 rounded-3xl bg-[#ffffff] border-2 border-[#3964fe] shadow-xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-2 text-[14px] font-bold text-[#000000]">
              {pending.approval ? (
                <AlertTriangle size={18} className="text-[#ff9500]" />
              ) : (
                <HelpCircle size={18} className="text-[#3964fe]" />
              )}
              <span>{pending.title}</span>
            </div>
            <p className="text-[13px] text-[#3a3a3c] mt-2 leading-relaxed whitespace-pre-wrap">
              {pending.body}
            </p>

            {pending.approval ? (
              <div className="flex items-center justify-end gap-2.5 mt-5 pt-3 border-t border-[rgba(60,60,67,0.08)]">
                <button
                  type="button"
                  onClick={() => onApprove(false)}
                  className="px-4 py-2 rounded-xl border border-[rgba(60,60,67,0.12)] text-[13px] font-medium text-[#ff3b30] hover:bg-[#ffe5e5] transition-colors cursor-pointer ios-spring-tap"
                >
                  拒绝 (Reject)
                </button>
                <button
                  type="button"
                  onClick={() => onApprove(true)}
                  className="px-5 py-2 rounded-xl bg-[#3964fe] hover:bg-[#2b4ec9] text-white text-[13px] font-semibold shadow-xs transition-transform cursor-pointer ios-spring-tap"
                >
                  允许一次 (Allow Once)
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-[rgba(60,60,67,0.08)]">
                {pending.options.map((opt, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onAnswerOption(opt)}
                    className="px-3.5 py-2 rounded-xl bg-[#f2f2f7] hover:bg-[#3964fe] hover:text-white text-[13px] font-medium text-[#000000] transition-all cursor-pointer border border-[rgba(60,60,67,0.08)] ios-spring-tap"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 3. iOS Composer Seat (Frosted glass floating capsule) */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-[#f2f2f7] via-[#f2f2f7]/95 to-transparent pt-6 pb-5 px-4">
        <div className="max-w-2xl mx-auto">
          {/* Running cancel button */}
          {running && (
            <div className="flex justify-center mb-2">
              <button
                type="button"
                onClick={onCancel}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#000000] text-white text-[12px] font-medium shadow-md hover:bg-[#1c1c1e] transition-transform cursor-pointer ios-spring-tap"
              >
                <Square size={11} fill="currentColor" />
                <span>停止当前任务</span>
              </button>
            </div>
          )}

          <div className="flex items-end gap-2.5 ios-glass p-2 rounded-3xl border border-[rgba(60,60,67,0.12)] shadow-lg focus-within:ring-2 focus-within:ring-[#3964fe]/25 transition-all">
            <textarea
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="发送遥控指令，例如：检查 git 状态、运行测试…"
              className="flex-1 max-h-32 min-h-[38px] py-2 px-3 text-[14px] leading-relaxed resize-none focus:outline-hidden bg-transparent text-[#000000] placeholder:text-[#8e8e93]"
            />

            {/* iOS Voice Dictation Button */}
            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              className="w-9 h-9 rounded-full bg-[rgba(118,118,128,0.12)] text-[#1c1c1e] hover:text-[#3964fe] hover:bg-[#edf2ff] flex items-center justify-center transition-colors cursor-pointer ios-spring-tap shrink-0"
              title="语音遥控"
            >
              <Mic size={18} />
            </button>

            {/* iOS Send Arrow Button */}
            <button
              type="button"
              disabled={!inputText.trim() || sending}
              onClick={handleSend}
              className="w-9 h-9 rounded-full bg-[#3964fe] hover:bg-[#2b4ec9] text-white disabled:opacity-30 flex items-center justify-center transition-all shadow-xs cursor-pointer ios-spring-tap shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Voice Recording Overlay */}
      <VoiceRecordingOverlay
        isOpen={voiceOpen}
        onSend={(text) => {
          setVoiceOpen(false);
          onSend(text);
        }}
        onCancel={() => setVoiceOpen(false)}
      />
    </div>
  );
};
