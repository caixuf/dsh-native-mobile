import React, { useState, useEffect } from 'react';
import { ArrowLeft, KeyRound, Monitor, QrCode, Loader2, CheckCircle2 } from 'lucide-react';
import { PairingClient } from '../../services/pairing';
import { DeepSeekLogo } from '../common/DeepSeekLogo';

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
  const [devName, setDevName] = useState(deviceName || 'iPhone 16 Pro (Web Remote)');

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
    setPairCode(next.join(''));

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
      setBaseUrl(parsed.baseUrl);
      setPairCode(parsed.code);
      setTab('pair');
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#f2f2f7]" onPaste={handleQrPaste}>
      {/* Top Header */}
      <header className="sticky top-0 z-30 ios-glass border-b border-[rgba(60,60,67,0.12)] px-4 py-3">
        <div className="flex items-center max-w-lg mx-auto w-full">
          {onBack && (
            <button
              onClick={onBack}
              type="button"
              className="w-8 h-8 rounded-full bg-[rgba(118,118,128,0.12)] hover:bg-[rgba(118,118,128,0.2)] text-[#000000] flex items-center justify-center mr-2.5 transition-colors cursor-pointer ios-spring-tap shrink-0"
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] shadow-2xs flex items-center justify-center p-1">
              <DeepSeekLogo size={20} variant="brand" />
            </div>
            <div>
              <h1 className="text-[16px] font-bold tracking-tight text-[#000000]">连接工作电脑</h1>
              <p className="text-[11px] text-[#8e8e93]">局域网直连或内网穿透加密隧道</p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Form Body (iOS Grouped Layout) */}
      <div className="flex-1 overflow-y-auto p-4 max-w-lg w-full mx-auto pb-16">
        {/* iOS Segmented Control */}
        <div className="flex p-1 bg-[rgba(118,118,128,0.14)] rounded-2xl mb-4">
          <button
            type="button"
            onClick={() => setTab('login')}
            className={`flex-1 py-1.5 text-[12.5px] font-semibold rounded-xl transition-all cursor-pointer ios-spring-tap ${
              tab === 'login'
                ? 'bg-[#ffffff] text-[#000000] shadow-xs'
                : 'text-[#8e8e93] hover:text-[#000000]'
            }`}
          >
            账号密码登录 (推荐)
          </button>
          <button
            type="button"
            onClick={() => setTab('pair')}
            className={`flex-1 py-1.5 text-[12.5px] font-semibold rounded-xl transition-all cursor-pointer ios-spring-tap ${
              tab === 'pair'
                ? 'bg-[#ffffff] text-[#000000] shadow-xs'
                : 'text-[#8e8e93] hover:text-[#000000]'
            }`}
          >
            一次性配对码
          </button>
        </div>

        {/* Error notification */}
        {error && (
          <div className="mb-4 p-3.5 rounded-2xl bg-[#ffe5e5] border border-[rgba(255,59,48,0.2)] text-[#ff3b30] text-[13px] font-medium">
            {error}
          </div>
        )}

        {/* Form Container (iOS Grouped White Card) */}
        <div className="bg-[#ffffff] rounded-3xl border border-[rgba(60,60,67,0.08)] p-6 shadow-xs space-y-4">
          {/* Base URL */}
          <div>
            <label className="block text-[12.5px] font-semibold text-[#000000] mb-1.5">
              网关地址 (Host URL)
            </label>
            <div className="relative">
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:4142 或内网穿透公网地址"
                className="w-full px-3.5 py-2.5 text-[13px] font-mono bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30 text-[#000000]"
              />
              {probing && (
                <div className="absolute right-3.5 top-3">
                  <Loader2 size={15} className="animate-spin text-[#3964fe]" />
                </div>
              )}
            </div>
            {probedHost && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-[#34c759] font-medium mt-1.5">
                <CheckCircle2 size={13} />
                <span>已识别网关实例: {probedHost}</span>
              </div>
            )}
          </div>

          {tab === 'login' ? (
            <>
              <div>
                <label className="block text-[12.5px] font-semibold text-[#000000] mb-1.5">
                  账号 (Username)
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="用户名"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30 text-[#000000]"
                />
              </div>

              <div>
                <label className="block text-[12.5px] font-semibold text-[#000000] mb-1.5">
                  密码 (Password)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="访问密钥或网关密码"
                  className="w-full px-3.5 py-2.5 text-[13px] bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30 text-[#000000]"
                />
              </div>
            </>
          ) : (
            <>
              {/* 6-Digit PIN or Code */}
              <div>
                <label className="block text-[12.5px] font-semibold text-[#000000] mb-1.5">
                  6 位配对码 (或粘贴配对字符串)
                </label>
                <div className="flex justify-between gap-1.5 my-2">
                  {pinDigits.map((d, i) => (
                    <input
                      key={i}
                      id={`pin-${i}`}
                      type="text"
                      maxLength={1}
                      value={d}
                      onChange={(e) => handleDigitChange(i, e.target.value)}
                      className="w-11 h-13 text-center text-xl font-mono font-bold bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-2xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/40 text-[#000000]"
                    />
                  ))}
                </div>
                <input
                  type="text"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  placeholder="或直接手输/粘贴 22 位配对码字符串"
                  className="w-full mt-2 px-3.5 py-2 text-[12.5px] font-mono bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30"
                />
              </div>
            </>
          )}

          {/* Device Name */}
          <div>
            <label className="block text-[12.5px] font-semibold text-[#000000] mb-1.5">
              随身设备名 (Device Name)
            </label>
            <input
              type="text"
              value={devName}
              onChange={(e) => setDevName(e.target.value)}
              placeholder="例如：iPhone 16 Pro / iPad Remote"
              className="w-full px-3.5 py-2.5 text-[13px] bg-[#f2f2f7] border border-[rgba(60,60,67,0.1)] rounded-xl focus:outline-hidden focus:bg-[#ffffff] focus:ring-2 focus:ring-[#3964fe]/30 text-[#000000]"
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
            className="w-full py-3 px-4 rounded-2xl bg-[#3964fe] hover:bg-[#2b4ec9] text-white text-[14px] font-semibold transition-transform shadow-sm flex items-center justify-center gap-2 cursor-pointer ios-spring-tap disabled:opacity-60"
          >
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>正在验证并连接…</span>
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
        <div className="mt-4 p-4 rounded-2xl bg-[#ffffff] border border-[rgba(60,60,67,0.08)] text-[12.5px] text-[#8e8e93] space-y-1.5">
          <div className="flex items-center gap-2 font-semibold text-[#000000]">
            <DeepSeekLogo size={16} variant="brand" />
            <span>DeepSeek 遥控快速提示</span>
          </div>
          <p className="leading-relaxed">
            • 默认提供开箱即用的本地 Demo 模拟实例，无需事先配置远程桌面。
          </p>
          <p className="leading-relaxed">
            • 电脑端 DSH 安装插件：终端执行 <code className="text-[#3964fe]">pwsh scripts\install-gateway.ps1</code>，访问 <code className="text-[#3964fe]">/mobile-gateway/manage</code> 获取配对信息。
          </p>
        </div>
      </div>
    </div>
  );
};
