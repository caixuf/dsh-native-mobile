import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Menu, Send, Mic, Square, Folder, AlertTriangle, HelpCircle, Loader2, Sparkles, Terminal } from 'lucide-react';
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
    <div className="flex flex-col h-full bg-[#090a0f] text-[#f8fafc] mesh-glow-bg select-none">
      {/* 1. Studio Execution Context Bar */}
      <header className="sticky top-0 z-30 studio-glass border-b border-white/[0.08] px-4 py-2.5 transition-all">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={onBack}
              type="button"
              className="w-8 h-8 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#e2e8f0] cursor-pointer studio-tap shrink-0"
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
              className="w-8 h-8 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] flex items-center justify-center text-[#e2e8f0] transition-colors cursor-pointer studio-tap"
            >
              <Menu size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* 2. Chat Timeline */}
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
                <div className="max-w-[84%] px-4 py-2.5 rounded-2xl rounded-br-xs bg-gradient-to-r from-[#2563eb] to-[#3b82f6] text-white text-[14.5px] leading-relaxed shadow-[0_0_20px_rgba(59,130,246,0.3)] break-words border border-white/10">
                  {line.text}
                </div>
              </div>
            );
          }

          if (line.role === 'system') {
            return (
              <div key={line.key || idx} className="flex justify-center my-2">
                <span className="px-3 py-1 rounded-full text-[11.5px] text-[#94a3b8] bg-[#141824] border border-white/[0.08]">
                  {line.text}
                </span>
              </div>
            );
          }

          // Assistant message: Obsidian Studio Specular Card
          return (
            <div key={line.key || idx} className="my-2.5 specular-card p-4 rounded-3xl border border-white/10 shadow-xl">
              <div className="flex items-center gap-2 mb-2.5 pb-2 border-b border-white/[0.08]">
                <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 flex items-center justify-center p-0.5 shadow-inner">
                  <DeepSeekLogo size={14} variant="brand" />
                </div>
                <span className="text-[12px] font-bold text-white tracking-wide">DeepSeek 远程执行响应</span>
              </div>
              <div className="text-[#f1f5f9] leading-relaxed">
                <MarkdownView content={line.text} />
              </div>
            </div>
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
                  onClick={() => onSend(p)}
                  className="px-3.5 py-2 rounded-xl bg-[#141824] hover:bg-[#1e2538] hover:border-[#3b82f6]/40 text-[#cbd5e1] hover:text-white border border-white/10 text-[12.5px] font-medium shadow-sm transition-all cursor-pointer studio-tap"
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
                  className="px-4 py-2 rounded-xl border border-[#f43f5e]/30 text-[13px] font-medium text-[#fb7185] bg-[#f43f5e]/10 hover:bg-[#f43f5e]/20 transition-colors cursor-pointer studio-tap"
                >
                  拒绝 (Reject)
                </button>
                <button
                  type="button"
                  onClick={() => onApprove(true)}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[13px] font-semibold shadow-[0_0_20px_rgba(59,130,246,0.4)] transition-transform cursor-pointer studio-tap"
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
                    className="px-3.5 py-2 rounded-xl bg-[#141824] hover:bg-[#3b82f6] hover:text-white text-[13px] font-medium text-[#cbd5e1] transition-all cursor-pointer border border-white/10 studio-tap"
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

      {/* 3. Floating Composer Dock */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-[#090a0f] via-[#090a0f]/95 to-transparent pt-6 pb-5 px-4">
        <div className="max-w-2xl mx-auto">
          {/* Running cancel button */}
          {running && (
            <div className="flex justify-center mb-2.5">
              <button
                type="button"
                onClick={onCancel}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-[#1e131d] border border-[#f43f5e]/40 text-[#fb7185] text-[12px] font-medium shadow-lg hover:bg-[#2b1725] transition-transform cursor-pointer studio-tap"
              >
                <Square size={11} fill="currentColor" />
                <span>停止当前任务</span>
              </button>
            </div>
          )}

          <div className="flex items-end gap-2.5 studio-glass-dock p-2 rounded-3xl transition-all focus-within:border-[#3b82f6]/50 focus-within:ring-2 focus-within:ring-[#3b82f6]/30">
            <textarea
              rows={1}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="发送遥控指令，例如：检查 git 状态、运行测试…"
              className="flex-1 max-h-32 min-h-[38px] py-2 px-3 text-[14px] leading-relaxed resize-none focus:outline-hidden bg-transparent text-white placeholder:text-[#64748b]"
            />

            {/* Voice Dictation Button */}
            <button
              type="button"
              onClick={() => setVoiceOpen(true)}
              className="w-9 h-9 rounded-xl bg-white/[0.06] text-[#94a3b8] hover:text-[#38bdf8] hover:bg-white/[0.1] border border-white/[0.08] flex items-center justify-center transition-colors cursor-pointer studio-tap shrink-0"
              title="语音遥控"
            >
              <Mic size={18} />
            </button>

            {/* Send Arrow Button */}
            <button
              type="button"
              disabled={!inputText.trim() || sending}
              onClick={handleSend}
              className="w-9 h-9 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white disabled:opacity-30 flex items-center justify-center transition-all shadow-[0_0_15px_rgba(59,130,246,0.5)] cursor-pointer studio-tap shrink-0"
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
