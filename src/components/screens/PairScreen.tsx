import React, { useState, useEffect } from 'react';
import { ArrowLeft, KeyRound, Monitor, QrCode, Loader2, CheckCircle2, Sparkles, ShieldCheck, Camera, ScanLine } from 'lucide-react';
import { PairingClient } from '../../services/pairing';
import { DeepSeekLogo } from '../common/DeepSeekLogo';
import { QrScannerModal } from '../pairing/QrScannerModal';
import { triggerHaptic } from '../../utils/haptics';

interface Props {
  busy: boolean;
  error: string | null;
  onBack: (() => void) | null;
  onLogin: (baseUrl: string, user: string, pass: string, name: string) => Promise<void>;
  onPair: (baseUrl: string, code: string, name: string) => Promise<void>;
  deviceName: string;
}

export const PairScreen: React.FC<Props> = ({
  busy,
  error,
  onBack,
  onLogin,
  onPair,
  deviceName,
}) => {
  const [tab, setTab] = useState<'login' | 'pair'>('login');

  // Login form state
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:4142');
  const [username, setUsername] = useState('developer');
  const [password, setPassword] = useState('••••••••');
  const [devName, setDevName] = useState(deviceName || 'Studio Remote Client');

  // Pair code state
  const [pairCode, setPairCode] = useState('');
  const [pinDigits, setPinDigits] = useState(['', '', '', '', '', '']);

  // Host probe
  const [probedHost, setProbedHost] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    let cancel = false;
    if (baseUrl.startsWith('http')) {
      setProbing(true);
      PairingClient.probe(baseUrl).then((inst) => {
        if (!cancel) {
          setProbedHost(inst);
          setProbing(false);
        }
      });
    }
    return () => {
      cancel = true;
    };
  }, [baseUrl]);

  const handleDigitChange = (index: number, val: string) => {
    const char = val.slice(-1);
    const next = [...pinDigits];
    next[index] = char;
    setPinDigits(next);
    const fullCode = next.join('');
    setPairCode(fullCode);

    if (fullCode.length === 6 && fullCode.replace(/\s/g, '').length === 6) {
      triggerHaptic('success');
    } else if (char) {
      triggerHaptic('light');
    }

    // Auto advance focus
    if (char && index < 5) {
      const nextInput = document.getElementById(`pin-${index + 1}`);
      nextInput?.focus();
    }
  };

  const handleQrPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text');
    const parsed = PairingClient.parsePairingTarget(pasted);
    if (parsed) {
      triggerHaptic('success');
      setBaseUrl(parsed.baseUrl);
      setPairCode(parsed.code);
      setTab('pair');
    }
  };

  // Scanner modal state
  const [scannerOpen, setScannerOpen] = useState(false);

  const handleScanResult = (raw: string) => {
    triggerHaptic('success');
    setScannerOpen(false);
    const parsed = PairingClient.parsePairingTarget(raw);
    if (parsed) {
      setBaseUrl(parsed.baseUrl);
      if (parsed.code) {
        setPairCode(parsed.code);
        if (/^\d{6}$/.test(parsed.code)) {
          setPinDigits(parsed.code.split(''));
        }
        setTab('pair');
        // Auto connect immediately
        onPair(parsed.baseUrl, parsed.code, devName);
      }
    } else {
      const text = raw.trim();
      if (text.startsWith('http://') || text.startsWith('https://')) {
        setBaseUrl(text);
      } else if (/^\d{6}$/.test(text) || text.toLowerCase().startsWith('dshm')) {
        setPairCode(text);
        if (/^\d{6}$/.test(text)) {
          setPinDigits(text.split(''));
        }
        setTab('pair');
        onPair(baseUrl, text, devName);
      }
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#090a0f] text-[#f8fafc] mesh-glow-bg select-none" onPaste={handleQrPaste}>
      {/* Top Header */}
      <header className="sticky top-0 z-30 studio-glass border-b border-white/[0.08] px-4 py-3">
        <div className="flex items-center max-w-lg mx-auto w-full">
          {onBack && (
            <button
              onClick={onBack}
              type="button"
              className="w-8 h-8 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-[#e2e8f0] flex items-center justify-center mr-2.5 transition-colors cursor-pointer studio-tap shrink-0"
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#1e293b] to-[#0f172a] border border-white/10 shadow-inner flex items-center justify-center p-1.5 shrink-0">
              <DeepSeekLogo size={22} variant="brand" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold tracking-tight text-white truncate whitespace-nowrap">连接工作电脑</h1>
              <p className="text-[11px] text-[#94a3b8] truncate">局域网直连或内网穿透加密隧道</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            title="扫码配对"
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#3b82f6]/15 hover:bg-[#3b82f6]/25 border border-[#3b82f6]/30 text-[#38bdf8] text-[12px] font-semibold transition-colors studio-tap cursor-pointer shrink-0"
          >
            <ScanLine size={15} />
            <span>扫码</span>
          </button>
        </div>
      </header>

      {/* Main Form Body */}
      <div className="flex-1 overflow-y-auto p-4 max-w-lg w-full mx-auto pb-[calc(4rem+var(--sab))]">
        {/* Hero QR Scan Banner */}
        <div className="mb-4 p-3.5 rounded-2xl bg-gradient-to-r from-[#1e293b] via-[#0f172a] to-[#1e1b4b] border border-[#3b82f6]/30 shadow-lg flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-[#3b82f6] text-white flex items-center justify-center shadow-[0_0_15px_rgba(59,130,246,0.4)] shrink-0">
              <QrCode size={22} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-bold text-white tracking-tight">扫码一键连接</span>
                <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded-md bg-[#3b82f6]/20 border border-[#3b82f6]/40 text-[#60a5fa]">
                  推荐
                </span>
              </div>
              <p className="text-[11.5px] text-[#94a3b8] leading-tight mt-0.5 truncate">
                直接扫描电脑端二维码，无需手输
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="py-2 px-3.5 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[12.5px] font-semibold shadow-[0_0_15px_rgba(59,130,246,0.35)] flex items-center gap-1.5 shrink-0 transition-all studio-tap cursor-pointer hover:opacity-90"
          >
            <Camera size={14} />
            <span>扫码</span>
          </button>
        </div>

        {/* Segmented Control */}
        <div className="flex p-1 bg-[#141824] border border-white/[0.08] rounded-2xl mb-4">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('selection');
              setTab('login');
            }}
            className={`flex-1 py-1.5 text-[12.5px] font-semibold rounded-xl transition-all cursor-pointer studio-tap ${
              tab === 'login'
                ? 'bg-[#1e2538] text-white border border-white/10 shadow-xs'
                : 'text-[#94a3b8] hover:text-white'
            }`}
          >
            账号密码登录 (推荐)
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('selection');
              setTab('pair');
            }}
            className={`flex-1 py-1.5 text-[12.5px] font-semibold rounded-xl transition-all cursor-pointer studio-tap ${
              tab === 'pair'
                ? 'bg-[#1e2538] text-white border border-white/10 shadow-xs'
                : 'text-[#94a3b8] hover:text-white'
            }`}
          >
            一次性配对码
          </button>
        </div>

        {/* Error notification */}
        {error && (
          <div className="mb-4 p-3.5 rounded-2xl bg-[#1f0d14] border border-[#f43f5e]/30 text-[#fda4af] text-[13px] font-medium">
            {error}
          </div>
        )}

        {/* Form Container */}
        <div className="specular-card rounded-3xl border border-white/10 p-6 shadow-2xl space-y-4">
          {/* Base URL */}
          <div>
            <label className="block text-[12.5px] font-semibold text-white mb-1.5">
              网关地址 (Host URL)
            </label>
            <div className="relative">
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:4142 或内网穿透公网地址"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
              />
              {probing && (
                <div className="absolute right-3.5 top-3">
                  <Loader2 size={15} className="animate-spin text-[#3b82f6]" />
                </div>
              )}
            </div>
            {probedHost && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-[#10b981] font-medium mt-1.5">
                <CheckCircle2 size={13} />
                <span>已识别网关实例: {probedHost}</span>
              </div>
            )}
          </div>

          {tab === 'login' ? (
            <>
              <div>
                <label className="block text-[12.5px] font-semibold text-white mb-1.5">
                  账号 (Username)
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="用户名"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
                />
              </div>

              <div>
                <label className="block text-[12.5px] font-semibold text-white mb-1.5">
                  密码 (Password)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="访问密钥或网关密码"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12.5px] font-semibold text-white">
                    6 位配对码 (或粘贴配对字符串)
                  </label>
                  <button
                    type="button"
                    onClick={() => setScannerOpen(true)}
                    className="flex items-center gap-1 text-[11.5px] text-[#38bdf8] hover:text-[#60a5fa] font-medium transition-colors studio-tap cursor-pointer"
                  >
                    <ScanLine size={13} />
                    <span>扫码填入</span>
                  </button>
                </div>
                <div className="flex justify-between gap-1.5 my-2">
                  {pinDigits.map((d, i) => (
                    <input
                      key={i}
                      id={`pin-${i}`}
                      type="text"
                      maxLength={1}
                      value={d}
                      onChange={(e) => handleDigitChange(i, e.target.value)}
                      className="w-11 h-13 text-center text-xl font-mono font-bold bg-[#141824] border border-white/10 rounded-2xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6]/40 text-white shadow-inner"
                    />
                  ))}
                </div>
                <input
                  type="text"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  placeholder="或直接手输/粘贴 22 位配对码字符串"
                  className="w-full mt-2 px-3.5 py-2 text-[12.5px] font-mono bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] text-white placeholder:text-[#64748b]"
                />
              </div>
            </>
          )}

          {/* Device Name */}
          <div>
            <label className="block text-[12.5px] font-semibold text-white mb-1.5">
              随身设备名 (Device Name)
            </label>
            <input
              type="text"
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="例如：Studio Remote Client / Mac Studio"
              className="w-full px-3.5 py-2.5 text-[13px] bg-[#141824] border border-white/10 rounded-xl focus:outline-hidden focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/40 text-white placeholder:text-[#64748b]"
            />
          </div>

          {/* Submit */}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (tab === 'login') {
                onLogin(baseUrl, username, password, devName);
              } else {
                onPair(baseUrl, pairCode || '123456', devName);
              }
            }}
            className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-[#3b82f6] to-[#2563eb] text-white text-[14px] font-semibold shadow-[0_0_20px_rgba(59,130,246,0.35)] flex items-center justify-center gap-2 cursor-pointer studio-tap disabled:opacity-60"
          >
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>正在验证并建立双向流…</span>
              </>
            ) : (
              <>
                <KeyRound size={16} />
                <span>{tab === 'login' ? '立即登录并连接' : '完成配对'}</span>
              </>
            )}
          </button>
        </div>

        {/* Quick Tips */}
        <div className="mt-4 p-4 rounded-2xl specular-card border border-white/10 text-[12.5px] text-[#94a3b8] space-y-1.5">
          <div className="flex items-center gap-2 font-semibold text-white">
            <ShieldCheck size={16} className="text-[#3b82f6]" />
            <span>DeepSeek 安全遥控提示</span>
          </div>
          <p className="leading-relaxed">
            • 默认提供开箱即用的本地 Demo 模拟实例，无需事先配置远程桌面。
          </p>
          <p className="leading-relaxed">
            • 电脑端 DSH 安装插件：终端执行 <code className="text-[#38bdf8]">pwsh scripts\install-gateway.ps1</code>，访问 <code className="text-[#38bdf8]">/mobile-gateway/manage</code> 获取配对信息。
          </p>
        </div>
      </div>

      {/* QR Scanner Modal */}
      <QrScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanSuccess={handleScanResult}
      />
    </div>
  );
};
