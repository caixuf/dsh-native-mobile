import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, Image as ImageIcon, X, RefreshCw, AlertCircle, Sparkles, Clipboard, CheckCircle2, Settings } from 'lucide-react';
import { decodeQrFromImageData, decodeQrFromImageFile } from '../../utils/qrScanner';
import { NativeBridge } from '../../services/native-bridge';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (rawResult: string) => void;
}

export const QrScannerModal: React.FC<Props> = ({ isOpen, onClose, onScanSuccess }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [scanning, setScanning] = useState(false);
  const [scannedResult, setScannedResult] = useState<string | null>(null);

  /**
   * 🔴 流必须放在 ref 里，不能只放 state。
   *
   * 之前的写法：`stopCamera` 依赖 state 的 `stream` → `startCamera` 依赖 `stopCamera`
   * → 挂载相机的 effect 依赖 `[isOpen, startCamera, stopCamera]`。
   * 于是形成死循环：相机起来 → `stream` 变化 → `stopCamera` 换了身份 →
   * effect 重跑 → cleanup **把刚开的流关掉** → 再起来……
   * 现象就是真机上报的"授权后一直闪烁那个播放按钮背景"：视频永远停在未播放态，
   * canvas 也永远抓不到帧，扫不出任何东西。
   */
  const streamRef = useRef<MediaStream | null>(null);

  // Stop current camera stream
  const stopCamera = useCallback(() => {
    const current = streamRef.current;
    if (current) {
      current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
    }
  }, []);

  // Start camera stream
  const startCamera = useCallback(async () => {
    stopCamera();
    setCameraError(null);
    setScannedResult(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('当前运行环境不支持实时相机取景，请通过相册选择二维码图片。');
      return;
    }

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = mediaStream;
      setStream(mediaStream);
      // 等 React 把 <video> 真正挂上来再挂流，并显式设置 muted 属性
      // （WebView 的自动播放策略看的是 muted **属性**，只写 muted JSX 属性不够）
      await new Promise((r) => setTimeout(r, 60));
      const video = videoRef.current;
      if (video) {
        video.muted = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.srcObject = mediaStream;
        try {
          await video.play();
        } catch {
          // 有些 WebView 要等 loadedmetadata 才肯播
          video.addEventListener('loadedmetadata', () => void video.play().catch(() => {}), { once: true });
        }
      }
      setScanning(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        setCameraError('相机权限未开启。点下面的按钮直接跳到系统设置里打开；也可以从相册选二维码图片。');
      } else if (msg.includes('NotFoundError') || msg.includes('DevicesNotFound')) {
        setCameraError('这台设备上没有找到可用相机。可以从相册选二维码图片。');
      } else {
        setCameraError('未能启动相机：' + msg + '。可以先从相册选二维码图片。');
      }
    }
  }, [facingMode, stopCamera]);

  // Start camera when modal opens
  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
      setScanning(false);
      setScannedResult(null);
      setCameraError(null);
    }
    return () => {
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  // Handle successful scan
  const triggerSuccess = useCallback(
    (result: string) => {
      if (scannedResult) return;
      setScannedResult(result);
      setScanning(false);
      if (navigator.vibrate) {
        try {
          navigator.vibrate([40, 60, 40]);
        } catch {
          // ignore
        }
      }
      stopCamera();
      setTimeout(() => {
        onScanSuccess(result);
      }, 350);
    },
    [onScanSuccess, scannedResult, stopCamera]
  );

  // Scanning loop on video frames
  useEffect(() => {
    if (!scanning || !videoRef.current || !canvasRef.current) return;

    let animId: number;
    let lastScanTime = 0;
    // 看门狗：真机上出现过"授权通过但视频永远不播"的 ROM 组合，
    // 表现是取景框一直闪、扫不出东西 —— 那必须**如实报错**，而不是无声空转。
    const startedAt = Date.now();
    let reported = false;

    const scanFrame = async (timestamp: number) => {
      // 🔴 这里必须是 `!scanning`。
      // v1.0.3 误写成 `if (scanning) return` —— 于是循环一进来就退出、
      // 而且再也不排下一帧，**一帧都没解码过**：画面照常显示，却永远识别不出码。
      if (!scanning) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // Scan every 180ms to save CPU & battery
        if (timestamp - lastScanTime > 180) {
          lastScanTime = timestamp;
          const width = video.videoWidth;
          const height = video.videoHeight;

          if (width > 0 && height > 0) {
            // 降采样到长边 ≤720 再解码：实测整帧 720p 解码比 640x360 慢 4 倍，
            // 而手机 CPU 只有本机零头 —— 降采样后识别反而更快。
            const MAX_SIDE = 720;
            const ratio = Math.min(1, MAX_SIDE / Math.max(width, height));
            const dw = Math.round(width * ratio);
            const dh = Math.round(height * ratio);
            canvas.width = dw;
            canvas.height = dh;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, dw, dh);
              const imgData = ctx.getImageData(0, 0, dw, dh);
              let decoded = await decodeQrFromImageData(imgData);
              // 兜底：万一系统只给了**前摄**（画面是镜像的），jsQR 对镜像码识别率很低，
              // 水平翻转再试一次。
              if (!decoded) {
                ctx.save();
                ctx.translate(dw, 0);
                ctx.scale(-1, 1);
                ctx.drawImage(video, 0, 0, dw, dh);
                ctx.restore();
                decoded = await decodeQrFromImageData(ctx.getImageData(0, 0, dw, dh));
              }
              if (decoded) {
                triggerSuccess(decoded);
                return;
              }
            }
          } else if (!reported && Date.now() - startedAt > 8000) {
            reported = true;
            setScanning(false);
            setCameraError('相机已授权，但这台手机没能把取景画面显示出来（视频一直不播放）。可以改用「相册选取图片」扫码，或重启一次 App 再试。');
          }
        }
      } else if (!reported && Date.now() - startedAt > 8000) {
        reported = true;
        setScanning(false);
        setCameraError('相机已授权，但取景画面没能启动。可以改用「相册选取图片」扫码，或重启一次 App 再试。');
      }

      animId = requestAnimationFrame(scanFrame);
    };

    animId = requestAnimationFrame(scanFrame);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [scanning, triggerSuccess]);

  // Handle image file picked from album or camera file input
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const res = await decodeQrFromImageFile(file);
    if (res) {
      triggerSuccess(res);
    } else {
      setCameraError('所选图片中未识别到有效二维码，请重试或拍摄更清晰的屏幕照片。');
    }
  };

  // Handle clipboard paste
  const handlePasteClipboard = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
          triggerSuccess(text.trim());
        } else {
          setCameraError('剪贴板中未找到文本内容');
        }
      }
    } catch {
      setCameraError('无法读取系统剪贴板，请手动粘贴至配对输入框');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 pt-[calc(1rem+var(--sat))] pb-[calc(1rem+var(--sab))] animate-in fade-in duration-200">
      <div className="relative w-full max-w-sm bg-[#0d111a] border border-white/10 rounded-3xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#3b82f6]/20 border border-[#3b82f6]/30 flex items-center justify-center text-[#3b82f6]">
              <Camera size={16} />
            </div>
            <div>
              <h2 className="text-[15px] font-bold text-white tracking-tight">扫码一键连接</h2>
              <p className="text-[11px] text-[#94a3b8]">扫描电脑端 /mobile-gateway/manage 二维码</p>
            </div>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-[#94a3b8] hover:text-white flex items-center justify-center transition-colors studio-tap"
          >
            <X size={17} />
          </button>
        </div>

        {/* Viewfinder Area */}
        <div className="relative aspect-square w-full bg-black overflow-hidden flex items-center justify-center">
          {/* Hidden Canvas for Decoding */}
          <canvas ref={canvasRef} className="hidden" />

          {/* Video Stream —— autoPlay + 显式 muted：WebView 里少一个都不播 */}
          <video
            ref={videoRef}
            className={`w-full h-full object-cover ${cameraError ? 'hidden' : 'block'}`}
            autoPlay
            muted
            playsInline
            disablePictureInPicture
          />

          {/* Scanned Success Overlay */}
          {scannedResult && (
            <div className="absolute inset-0 z-30 bg-[#052e16]/80 backdrop-blur-xs flex flex-col items-center justify-center text-white animate-in zoom-in-95 duration-200">
              <CheckCircle2 size={56} className="text-[#10b981] mb-2 animate-bounce" />
              <div className="text-[15px] font-bold">识别成功</div>
              <div className="text-[11px] text-[#a7f3d0] font-mono mt-1 px-4 text-center line-clamp-2">
                {scannedResult}
              </div>
            </div>
          )}

          {/* Target Scanner Overlay */}
          {!cameraError && !scannedResult && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
              {/* Outer shadow / mask */}
              <div className="relative w-56 h-56 rounded-2xl border-2 border-white/20">
                {/* 4 Glowing Corner brackets */}
                <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-[#3b82f6] rounded-tl-lg shadow-[0_0_10px_#3b82f6]" />
                <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-[#3b82f6] rounded-tr-lg shadow-[0_0_10px_#3b82f6]" />
                <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-[#3b82f6] rounded-bl-lg shadow-[0_0_10px_#3b82f6]" />
                <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-[#3b82f6] rounded-br-lg shadow-[0_0_10px_#3b82f6]" />

                {/* Animated Laser Scanning Line */}
                <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-[#38bdf8] to-transparent shadow-[0_0_12px_#38bdf8] animate-pulse absolute top-1/2 -translate-y-1/2" />
              </div>
              <span className="mt-4 px-3 py-1 rounded-full bg-black/60 backdrop-blur-md text-white/80 text-[11.5px] font-medium border border-white/10">
                将取景框对准电脑屏幕二维码
              </span>
            </div>
          )}

          {/* Camera Error / Fallback State */}
          {cameraError && (
            <div className="p-6 text-center flex flex-col items-center justify-center max-w-xs">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-3">
                <AlertCircle size={26} />
              </div>
              <div className="text-[13.5px] font-semibold text-white mb-1.5">相机取景暂不可用</div>
              <p className="text-[11.5px] text-[#94a3b8] leading-relaxed mb-4">{cameraError}</p>
              <div className="flex items-center gap-2 flex-wrap justify-center">
                <button
                  type="button"
                  onClick={startCamera}
                  className="px-3.5 py-1.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-white text-[12px] font-medium flex items-center gap-1.5 transition-colors studio-tap"
                >
                  <RefreshCw size={13} />
                  <span>重试启动相机</span>
                </button>
                {/* 🔴 权限被"不再询问"永久拒绝时，网页侧只会拿到 NotAllowedError，
                    没有重试的意义 —— 必须给一个能跳系统设置的入口。 */}
                <button
                  type="button"
                  data-testid="qr-open-app-settings"
                  onClick={() => {
                    NativeBridge.openAppSettings();
                  }}
                  className="px-3.5 py-1.5 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 text-[12px] font-medium flex items-center gap-1.5 transition-colors studio-tap"
                >
                  <Settings size={13} />
                  <span>打开应用设置</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-[#111624] border-t border-white/[0.08] flex items-center gap-2">
          {/* File Picker for Album / Screenshot */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 py-2.5 px-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-white text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors studio-tap"
          >
            <ImageIcon size={15} className="text-[#38bdf8]" />
            <span>相册选取图片</span>
          </button>

          {/* Switch Camera if camera active */}
          {!cameraError && (
            <button
              type="button"
              onClick={() => {
                setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
              }}
              title="切换前后摄像头"
              className="w-10 h-10 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-white flex items-center justify-center transition-colors studio-tap"
            >
              <RefreshCw size={15} />
            </button>
          )}

          {/* Paste Clipboard */}
          <button
            type="button"
            onClick={handlePasteClipboard}
            title="从剪贴板粘贴"
            className="flex-1 py-2.5 px-3 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-white text-[12.5px] font-medium flex items-center justify-center gap-1.5 transition-colors studio-tap"
          >
            <Clipboard size={15} className="text-[#a78bfa]" />
            <span>粘贴剪贴板</span>
          </button>
        </div>
      </div>
    </div>
  );
};
