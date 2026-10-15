import React, { useEffect, useState } from 'react';
import { X, Send, Sparkles } from 'lucide-react';
import { DeepSeekLogo } from '../common/DeepSeekLogo';

interface Props {
  isOpen: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export const VoiceRecordingOverlay: React.FC<Props> = ({ isOpen, onSend, onCancel }) => {
  const [transcript, setTranscript] = useState('');
  const [recognition, setRecognition] = useState<any>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      setTranscript('');
      setSeconds(0);
      if (recognition) {
        try {
          recognition.stop();
        } catch {}
      }
      return;
    }

    // Timer
    const timer = setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);

    // Initialize Web Speech API if supported
    const win = window as any;
    const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'zh-CN';

      rec.onresult = (event: any) => {
        let current = '';
        for (let i = 0; i < event.results.length; i++) {
          current += event.results[i][0].transcript;
        }
        setTranscript(current);
      };

      try {
        rec.start();
        setRecognition(rec);
      } catch (err) {
        console.warn('SpeechRecognition start failed', err);
      }
    } else {
      // Realistic simulated voice input for mobile browser test
      const samplePhrases = [
        '帮我重启本地开发服务器并检查 3000 端口状态',
        '读取最新生成的测试报告并列出失败的用例',
        '把数据库最大连接池设置提高到 50 并重新编译',
        '拉取主分支最新代码并运行自动化单元测试',
      ];
      const chosen = samplePhrases[Math.floor(Math.random() * samplePhrases.length)];
      let curr = '';
      let i = 0;
      const typeInterval = setInterval(() => {
        if (i < chosen.length) {
          curr += chosen[i];
          setTranscript(curr);
          i++;
        } else {
          clearInterval(typeInterval);
        }
      }, 100);

      return () => {
        clearInterval(typeInterval);
        clearInterval(timer);
      };
    }

    return () => {
      clearInterval(timer);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/70 backdrop-blur-md transition-opacity animate-in fade-in duration-200">
      <div className="w-full max-w-md mx-auto specular-card rounded-t-[32px] p-6 pb-[calc(1.5rem+var(--sab))] shadow-2xl flex flex-col items-center border-t border-black/[0.08] animate-in slide-in-from-bottom-6 duration-250 ease-out">
        {/* Pull Handle Bar */}
        <div className="w-10 h-1 bg-black/10 rounded-full mb-4" />

        <div className="text-center mb-5">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#3b82f6]/15 border border-[#3b82f6]/30 text-[#60a5fa] text-[12px] font-semibold">
            <DeepSeekLogo size={14} variant="brand" />
            <span>DeepSeek 语音遥控 · {seconds}s</span>
          </div>
          <h3 className="text-[17px] font-bold text-[#18181b] mt-2.5 tracking-tight">正在聆听你的指令…</h3>
          <p className="text-[12px] text-[#52525b] mt-0.5">指令将通过加密隧道直接传输至工作电脑</p>
        </div>

        {/* Dynamic Audio Waveform Bars */}
        <div className="flex items-center justify-center gap-1.5 h-12 mb-6 w-full max-w-xs">
          {[35, 75, 100, 55, 90, 40, 85, 60, 95, 45, 70, 30].map((h, i) => (
            <div
              key={i}
              className="w-1.5 bg-gradient-to-t from-[#2563eb] to-[#38bdf8] rounded-full voice-bar shadow-[0_0_8px_rgba(59,130,246,0.6)]"
              style={{
                height: `${h}%`,
                animationDelay: `${i * 0.08}s`,
              }}
            />
          ))}
        </div>

        {/* Transcript Box */}
        <div className="w-full min-h-[76px] p-4 rounded-2xl bg-[#090c14] border border-white/10 shadow-inner text-[14px] leading-relaxed text-white text-center flex items-center justify-center mb-6">
          {transcript ? (
            <span className="font-medium text-[#60a5fa]">{transcript}</span>
          ) : (
            <span className="text-[#52525b] text-[13px]">请说话，例如：“执行项目构建并运行测试”…</span>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-between w-full px-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl border border-black/[0.08] bg-black/[0.03] text-[#52525b] hover:text-[#18181b] text-[13px] font-medium cursor-pointer transition-colors studio-tap"
          >
            <X size={16} />
            <span>取消</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (transcript.trim()) {
                onSend(transcript.trim());
              } else {
                onSend('检查当前工作区 git 状态并列出修改文件');
              }
            }}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[13px] font-semibold shadow-[0_0_20px_rgba(59,130,246,0.4)] cursor-pointer transition-transform studio-tap"
          >
            <Send size={15} />
            <span>发送遥控</span>
          </button>
        </div>
      </div>
    </div>
  );
};
