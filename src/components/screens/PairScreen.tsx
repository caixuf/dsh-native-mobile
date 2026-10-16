import React, { useState, useEffect } from 'react';
import {
  KeyRound,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  ScanLine,
  Camera,
  QrCode,
  ShieldCheck,
} from 'lucide-react';
import { QrScannerModal } from '../pairing/QrScannerModal';
import { triggerHaptic } from '../../utils/haptics';
import { DeepSeekMascot } from '../common/DeepSeekMascot';

interface Props {
  initialBaseUrl?: string;
  deviceName?: string;
  onPair: (baseUrl: string, pairCode: string, devName: string) => void;
  onLogin: (baseUrl: string, user: string, pass: string, devName: string) => void;
  busy: boolean;
  error?: string | null;
  onBack?: (() => void) | null;
}

export const PairScreen: React.FC<Props> = ({
  initialBaseUrl = 'http://127.0.0.1:4142',
  deviceName = 'MiniMax 随身端',
  onPair,
  onLogin,
  busy,
  error,
  onBack,
}) => {
  const [tab, setTab] = useState<'login' | 'pair'>('login');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [devName, setDevName] = useState(deviceName);
  const [probing, setProbing] = useState(false);
  const [probedHost, setProbedHost] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [pinDigits, setPinDigits] = useState(['', '', '', '', '', '']);

  useEffect(() => {
    if (tab === 'pair') {
      setTimeout(() => {
        document.getElementById('pin-0')?.focus();
      }, 100);
    }
  }, [tab]);

  const handleDigitChange = (index: number, val: string) => {
    const char = val.slice(-1);
    const newDigits = [...pinDigits];
    newDigits[index] = char;
    setPinDigits(newDigits);

    if (char && index < 5) {
      document.getElementById(`pin-${index + 1}`)?.focus();
    }

    const fullPin = newDigits.join('');
    setPairCode(fullPin);
    if (fullPin.length === 6 && !newDigits.includes('')) {
      triggerHaptic('success');
      onPair(baseUrl, fullPin, devName);
    }
  };

  const probe = async (url: string) => {
    if (!url || !url.startsWith('http')) return;
    try {
      setProbing(true);
      const res = await fetch(`${url.replace(/\/+$/, '')}/mobile-gateway/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        setProbedHost(data.instanceName || data.name || 'DSH 网关');
      } else {
        setProbedHost(null);
      }
    } catch {
      setProbedHost(null);
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      probe(baseUrl);
    }, 600);
    return () => clearTimeout(timer);
  }, [baseUrl]);

  const handleScanResult = (result: string) => {
    setScannerOpen(false);
    if (!result) return;
    try {
      const parsed = JSON.parse(result);
      if (parsed.baseUrl) setBaseUrl(parsed.baseUrl);
      if (parsed.pairCode) {
        setPairCode(parsed.pairCode);
        if (/^\d{6}$/.test(parsed.pairCode)) {
          setPinDigits(parsed.pairCode.split(''));
        }
        setTab('pair');
        onPair(parsed.baseUrl || baseUrl, parsed.pairCode, devName);
      }
    } catch {
      if (result.startsWith('http://') || result.startsWith('https://')) {
        setBaseUrl(result);
      } else if (/^\d{6}$/.test(result) || result.toLowerCase().startsWith('dshm')) {
        setPairCode(result);
        if (/^\d{6}$/.test(result)) {
          setPinDigits(result.split(''));
        }
        setTab('pair');
        onPair(baseUrl, result, devName);
      }
    }
  };

  const handleQrPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      if (parsed.baseUrl) setBaseUrl(parsed.baseUrl);
      if (parsed.pairCode) {
        setPairCode(parsed.pairCode);
        if (/^\d{6}$/.test(parsed.pairCode)) {
          setPinDigits(parsed.pairCode.split(''));
        }
        setTab('pair');
        onPair(parsed.baseUrl || baseUrl, parsed.pairCode, devName);
      }
    } catch {
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
    <div className="flex flex-col h-full bg-white/88 text-[#18181b] select-none" onPaste={handleQrPaste}>
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-gray-100 px-4 py-3">
        <div className="flex items-center max-w-lg mx-auto w-full">
          {onBack && (
            <button
              onClick={onBack}
              type="button"
              className="w-9 h-9 rounded-full bg-[#f4f4f6] hover:bg-gray-200 text-[#18181b] flex items-center justify-center mr-2.5 transition-colors cursor-pointer shrink-0 min-h-[44px]"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <DeepSeekMascot size={32} />
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold tracking-tight text-[#18181b] truncate whitespace-nowrap">连接工作电脑</h1>
              <p className="text-[11px] text-[#52525b] truncate">局域网直连或内网穿透加密隧道</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            title="扫码配对"
            className="ml-auto flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#f4f4f6] hover:bg-gray-200 border border-gray-200/80 text-[#18181b] text-[12px] font-medium transition-colors cursor-pointer shrink-0 min-h-[44px]"
          >
            <ScanLine size={15} />
            <span>扫码</span>
          </button>
        </div>
      </header>

      {/* Main Form Body */}
      <div className="flex-1 overflow-y-auto p-4 max-w-lg w-full mx-auto pb-[calc(4rem+var(--sab))]">
        {/* Hero QR Scan Banner */}
        <div className="mb-4 p-4 rounded-2xl bg-[#f4f4f6] border border-gray-200/60 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-black text-white flex items-center justify-center shrink-0">
              <QrCode size={22} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-bold text-[#18181b] tracking-tight">扫码一键连接</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">
                  推荐
                </span>
              </div>
              <p className="text-[11.5px] text-[#52525b] leading-tight mt-0.5 truncate">
                直接扫描电脑端二维码，无需手输
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="py-2 px-4 rounded-full bg-black text-white hover:bg-neutral-800 text-[12.5px] font-medium flex items-center gap-1.5 shrink-0 transition-all cursor-pointer min-h-[44px]"
          >
            <Camera size={14} />
            <span>扫码</span>
          </button>
        </div>

        {/* Segmented Control */}
        <div className="flex p-1 bg-[#f4f4f6] border border-gray-200/80 rounded-2xl mb-4">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('selection');
              setTab('login');
            }}
            className={`flex-1 py-2 text-[12.5px] font-medium rounded-xl transition-all cursor-pointer min-h-[44px] ${
              tab === 'login'
                ? 'bg-white text-[#18181b] shadow-xs font-semibold'
                : 'text-[#52525b] hover:text-black'
            }`}
          >
            账号密码登录
          </button>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('selection');
              setTab('pair');
            }}
            className={`flex-1 py-2 text-[12.5px] font-medium rounded-xl transition-all cursor-pointer min-h-[44px] ${
              tab === 'pair'
                ? 'bg-white text-[#18181b] shadow-xs font-semibold'
                : 'text-[#52525b] hover:text-black'
            }`}
          >
            一次性配对码
          </button>
        </div>

        {/* Error notification */}
        {error && (
          <div className="mb-4 p-3.5 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-[13px] font-medium">
            {error}
          </div>
        )}

        {/* Form Container */}
        <div className="bg-[#f4f4f6] rounded-2xl border border-gray-200/60 p-5 space-y-4">
          {/* Base URL */}
          <div>
            <label className="block text-[12.5px] font-semibold text-[#18181b] mb-1.5">
              网关地址 (Host URL)
            </label>
            <div className="relative">
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:4142 或内网穿透公网地址"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-white border border-gray-200 rounded-xl focus:outline-hidden focus:border-black focus:ring-1 focus:ring-black/20 text-[#18181b] placeholder:text-[#52525b]"
              />
              {probing && (
                <div className="absolute right-3.5 top-3">
                  <Loader2 size={15} className="animate-spin text-[#52525b]" />
                </div>
              )}
            </div>
            {probedHost && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-emerald-700 font-medium mt-1.5">
                <CheckCircle2 size={13} />
                <span>已识别网关实例: {probedHost}</span>
              </div>
            )}
          </div>

          {tab === 'login' ? (
            <>
              <div>
                <label className="block text-[12.5px] font-semibold text-[#18181b] mb-1.5">
                  账号 (Username)
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="用户名"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-white border border-gray-200 rounded-xl focus:outline-hidden focus:border-black focus:ring-1 focus:ring-black/20 text-[#18181b] placeholder:text-[#52525b]"
                />
              </div>

              <div>
                <label className="block text-[12.5px] font-semibold text-[#18181b] mb-1.5">
                  密码 (Password)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="访问密钥或网关密码"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-white border border-gray-200 rounded-xl focus:outline-hidden focus:border-black focus:ring-1 focus:ring-black/20 text-[#18181b] placeholder:text-[#52525b]"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12.5px] font-semibold text-[#18181b]">
                    6 位配对码 (或粘贴配对字符串)
                  </label>
                  <button
                    type="button"
                    onClick={() => setScannerOpen(true)}
                    className="flex items-center gap-1 text-[11.5px] text-blue-600 hover:text-blue-700 font-medium transition-colors cursor-pointer min-h-[44px]"
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
                      className="w-11 h-13 text-center text-xl font-mono font-bold bg-white border border-gray-200 rounded-2xl focus:outline-hidden focus:border-black focus:ring-2 focus:ring-black/20 text-[#18181b] shadow-2xs"
                    />
                  ))}
                </div>
                <input
                  type="text"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  placeholder="或直接手输/粘贴 22 位配对码字符串"
                  className="w-full mt-2 px-3.5 py-2 text-[12.5px] font-mono bg-white border border-gray-200 rounded-xl focus:outline-hidden focus:border-black text-[#18181b] placeholder:text-[#52525b]"
                />
              </div>
            </>
          )}

          {/* Device Name */}
          <div>
            <label className="block text-[12.5px] font-semibold text-[#18181b] mb-1.5">
              随身设备名 (Device Name)
            </label>
            <input
              type="text"
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="例如：Studio Remote Client / Mac Studio"
              className="w-full px-3.5 py-2.5 text-[13px] bg-white border border-gray-200 rounded-xl focus:outline-hidden focus:border-black focus:ring-1 focus:ring-black/20 text-[#18181b] placeholder:text-[#52525b]"
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
            className="w-full py-3.5 px-4 rounded-full bg-black text-white hover:bg-neutral-800 text-[14px] font-semibold shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60 min-h-[44px]"
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
        <div className="mt-4 p-4 rounded-2xl bg-[#f4f4f6] border border-gray-200/60 text-[12.5px] text-[#52525b] space-y-1.5">
          <div className="flex items-center gap-2 font-semibold text-[#18181b]">
            <ShieldCheck size={16} className="text-blue-600" />
            <span>安全连接提示</span>
          </div>
          <p className="leading-relaxed">
            • 默认提供开箱即用的本地 Demo 模拟实例，无需事先配置远程桌面。
          </p>
          <p className="leading-relaxed">
            • 电脑端 DSH 安装插件：终端执行 <code className="text-gray-900 font-medium">pwsh scripts\install-gateway.ps1</code>，访问 <code className="text-gray-900 font-medium">/mobile-gateway/manage</code> 获取配对信息。
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
