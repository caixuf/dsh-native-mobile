import React, { useEffect, useState } from 'react';
import { X, Info, Shield, Smartphone, RefreshCw, CheckCircle2, Download } from 'lucide-react';
import { APP_VERSION, APP_VERSION_CODE, APP_BUILD_DATE, APP_NAME } from '../../version';
import { DeepSeekMascot } from './DeepSeekMascot';
import { triggerHaptic } from '../../utils/haptics';
import {
  canInstallPackages,
  checkForUpdate,
  hasPendingApk,
  installUpdate,
  onOtaProgress,
  openInstallSettings,
  otaSupported,
  startDownload,
} from '../../services/ota';
import type { UpdateInfo } from '../../services/ota';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<Props> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-xs transition-opacity" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in slide-in-from-bottom-6 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full theme-bg-light theme-text-accent flex items-center justify-center">
              <Info size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">关于软件</h3>
              <p className="text-[11px] text-gray-500">版本信息与系统架构</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 flex flex-col items-center text-center overflow-y-auto">
          {/* Logo */}
          <div className="w-20 h-20 rounded-3xl bg-blue-50/70 border border-blue-100 flex items-center justify-center p-2 mb-3 shadow-sm">
            <DeepSeekMascot size={64} />
          </div>

          <h2 className="text-lg font-bold text-gray-900">{APP_NAME}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="px-2.5 py-0.5 rounded-full theme-badge text-xs font-mono font-semibold">
              v{APP_VERSION} (Build {APP_VERSION_CODE})
            </span>
            <span className="text-xs text-gray-400 font-mono">{APP_BUILD_DATE}</span>
          </div>

          <p className="text-xs text-gray-600 mt-3 max-w-xs leading-relaxed">
            基于 DeepSeek 智能引擎与本地大模型打造的端到端安全遥控伴侣。
            手机与电脑直连，全程端到端加密，零云端中转。
          </p>

          {/* Architecture Features */}
          <div className="w-full mt-5 space-y-2 text-left">
            <div className="p-3 rounded-2xl bg-gray-50 border border-gray-200/80 flex items-center gap-3">
              <Shield size={18} className="theme-text-accent shrink-0" />
              <div className="text-xs">
                <div className="font-bold text-gray-900">端到端加密通道</div>
                <div className="text-gray-500 text-[11px]">局域网安全直连，指令与会话不经第三方服务器</div>
              </div>
            </div>

            <div className="p-3 rounded-2xl bg-gray-50 border border-gray-200/80 flex items-center gap-3">
              <Smartphone size={18} className="theme-text-accent shrink-0" />
              <div className="text-xs">
                <div className="font-bold text-gray-900">原生前台保活中继</div>
                <div className="text-gray-500 text-[11px]">息屏与切后台仍可接收远端通知与一键回执</div>
              </div>
            </div>
          </div>

          {/* OTA 自更新 */}
          <UpdatePanel onClose={onClose} />
        </div>

        <div className="p-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-3 rounded-xl theme-btn-primary font-semibold text-sm transition-all shadow-md shadow-blue-500/20 active:scale-[0.99] cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * OTA 更新面板。
 *
 * 🔴 这里替换掉了一个**假的**「检查更新」按钮：旧实现是
 * `setTimeout(() => setCheckedOk(true), 800)` —— 无论有没有新版本，
 * 800ms 后都显示「已是最新版本」。用户永远收不到更新，也永远看不出来。
 *
 * 现在的真实流程：
 *   1. 查 GitHub Releases（10 分钟内走缓存，避免匿名限流 60/h 打满）
 *   2. 用「装的是什么版本」比对（原生 versionName → 退回构建期常量）
 *   3. 有更新 → 下载（进度条）→ 校验 → 拉起系统安装器
 *   4. 未授权「安装未知应用」→ 露出一键去授权的入口
 *
 * 浏览器/桌面版没有原生桥 → 只给下载链接，不假装能自动装。
 */
const UpdatePanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [phase, setPhase] = useState<'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [percent, setPercent] = useState(0);
  const supported = otaSupported();

  // 原生下载进度回传
  useEffect(() => {
    return onOtaProgress((p) => {
      if (p.phase === 'downloading') {
        setPercent(typeof p.percent === 'number' ? p.percent : 0);
      } else if (p.phase === 'done') {
        setPercent(100);
        setPhase('ready');
        setMessage('下载完成，点击下方按钮安装');
        triggerHaptic('medium');
      } else if (p.phase === 'error') {
        setPhase('error');
        setMessage(p.message || '下载失败');
      }
    });
  }, []);

  // 打开时若已有下好的包，直接提示可安装（App 被杀过也不丢）
  useEffect(() => {
    if (supported && hasPendingApk()) {
      setPhase('ready');
      setMessage('已有下载好的更新包');
    }
  }, [supported]);

  const handleCheck = async () => {
    triggerHaptic('light');
    setPhase('checking');
    setMessage(null);
    const r = await checkForUpdate(true);
    if (!r.ok) {
      setPhase('error');
      setMessage(r.error || '检查失败');
      return;
    }
    setInfo(r.info || null);
    if (r.hasUpdate && r.info?.apk) {
      setPhase('available');
      triggerHaptic('medium');
    } else if (r.hasUpdate && !r.info?.apk) {
      setPhase('available');
      setMessage('发现新版本，但这个 Release 没有 APK 资产');
    } else {
      setPhase('latest');
      triggerHaptic('medium');
    }
  };

  const handleDownload = () => {
    if (!info?.apk) return;
    triggerHaptic('light');
    const r = startDownload(info.apk);
    if (!r.ok) {
      setPhase('error');
      setMessage(r.error || '无法开始下载');
      return;
    }
    setPhase('downloading');
    setPercent(0);
    setMessage('正在下载…');
  };

  const handleInstall = () => {
    triggerHaptic('medium');
    const r = installUpdate();
    if (r.needPermission) {
      setPhase('error');
      setMessage(r.message || '需要先允许安装应用');
      return;
    }
    if (!r.ok) {
      setPhase('error');
      setMessage(r.message || '拉起安装器失败');
      return;
    }
    setPhase('installing');
    setMessage('已打开系统安装页，按提示完成安装');
  };

  const installAllowed = canInstallPackages();

  return (
    <div className="w-full mt-4 space-y-2" data-testid="ota-panel">
      {/* 主按钮区 */}
      {phase === 'idle' || phase === 'checking' || phase === 'latest' || phase === 'error' ? (
        <button
          type="button"
          onClick={handleCheck}
          disabled={phase === 'checking'}
          className="w-full py-2.5 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 text-xs font-semibold flex items-center justify-center gap-2 shadow-2xs transition-colors cursor-pointer min-h-[44px] disabled:opacity-60"
        >
          {phase === 'checking' ? (
            <>
              <RefreshCw size={14} className="animate-spin text-blue-600" />
              <span>正在检查新版本…</span>
            </>
          ) : phase === 'latest' ? (
            <>
              <CheckCircle2 size={14} className="text-emerald-600" />
              <span>当前已是最新版本 (v{APP_VERSION})</span>
            </>
          ) : (
            <>
              <RefreshCw size={14} className="text-gray-500" />
              <span>检查版本更新</span>
            </>
          )}
        </button>
      ) : null}

      {/* 发现新版本 */}
      {phase === 'available' && info ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-blue-900">发现新版本 v{info.latestVersion}</span>
            <span className="text-[10.5px] text-blue-700 font-mono">
              {info.apk ? `${(info.apk.size / 1048576).toFixed(1)}MB` : '无 APK'}
            </span>
          </div>
          {info.notes ? (
            <p className="text-[11px] text-blue-800/80 leading-relaxed max-h-24 overflow-y-auto whitespace-pre-wrap">
              {info.notes.slice(0, 600)}
            </p>
          ) : null}
          {supported && info.apk ? (
            <button
              type="button"
              onClick={handleDownload}
              className="w-full min-h-[44px] py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold cursor-pointer active:scale-[0.99]"
            >
              下载并安装
            </button>
          ) : (
            <a
              href={info.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="block w-full min-h-[44px] py-2.5 rounded-lg bg-blue-600 text-center text-white text-[13px] font-semibold"
            >
              打开下载页（当前环境不支持自动安装）
            </a>
          )}
        </div>
      ) : null}

      {/* 下载中 */}
      {phase === 'downloading' ? (
        <div className="rounded-xl border border-gray-200 bg-white p-3 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-gray-600">
            <span>正在下载更新包…</span>
            <span className="font-mono">{percent}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${Math.max(2, percent)}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* 已下载，待安装 */}
      {phase === 'ready' || phase === 'installing' ? (
        <button
          type="button"
          onClick={handleInstall}
          disabled={phase === 'installing'}
          className="w-full min-h-[44px] py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-semibold flex items-center justify-center gap-2 cursor-pointer active:scale-[0.99] disabled:opacity-60"
        >
          <Download size={15} />
          <span>{phase === 'installing' ? '已打开安装页' : '立即安装'}</span>
        </button>
      ) : null}

      {/* 未授权「安装未知应用」→ 一键去授权 */}
      {supported && !installAllowed && (phase === 'ready' || phase === 'error') ? (
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light');
            openInstallSettings();
          }}
          className="w-full min-h-[44px] py-2.5 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 text-[12px] font-semibold cursor-pointer"
        >
          允许「DSH Remote」安装应用
        </button>
      ) : null}

      {/* 结果/错误提示 */}
      {message ? (
        <p
          className={`text-[11px] leading-relaxed px-1 ${
            phase === 'error' ? 'text-rose-600' : 'text-gray-500'
          }`}
          data-testid="ota-message"
        >
          {message}
        </p>
      ) : null}

      {!supported ? (
        <p className="text-[10.5px] text-gray-400 leading-relaxed px-1">
          当前环境（浏览器/桌面）不支持自动安装；手机上打开 App 可一键升级。
        </p>
      ) : null}
    </div>
  );
};
