/**
 * 客户端通用文件与图片下载器 (Web / Android WebView 双向适配)
 */

export interface DownloadOptions {
  filename: string;
  mimeType?: string;
}

/**
 * 将 Base64 或文本或 Blob 下载到本地
 */
export async function downloadFile(
  content: string | Blob,
  filename: string,
  mimeType = 'text/plain'
): Promise<boolean> {
  try {
    // 1. 若运行在 Android 原生壳且注入了 DSHNative 桥接
    const bridge = (window as unknown as { DSHNative?: { saveFile?: (name: string, b64: string, mime: string) => string } }).DSHNative;
    if (bridge && typeof bridge.saveFile === 'function') {
      let base64 = '';
      if (typeof content === 'string') {
        if (content.startsWith('data:')) {
          const commaIdx = content.indexOf(',');
          base64 = content.slice(commaIdx + 1);
        } else {
          // UTF-8 string to base64
          base64 = btoa(unescape(encodeURIComponent(content)));
        }
      } else {
        base64 = await blobToBase64(content);
      }

      const resStr = bridge.saveFile(filename, base64, mimeType);
      try {
        const res = JSON.parse(resStr);
        if (res.ok) return true;
      } catch {
        // fall back to web download
      }
    }

    // 2. 移动端/桌面端标准 HTML5 Blob 下载
    let blob: Blob;
    if (content instanceof Blob) {
      blob = content;
    } else if (content.startsWith('data:')) {
      blob = dataUriToBlob(content);
    } else {
      blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    }

    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    window.setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 60000);

    return true;
  } catch (err) {
    console.error('[Downloader] 下载失败:', err);
    return false;
  }
}

/**
 * 尝试调用系统原生分享面板（常用于手机端保存或隔空发送）
 */
export async function shareFileIfSupported(
  content: string | Blob,
  filename: string,
  mimeType = 'text/plain'
): Promise<boolean> {
  if (!navigator.share || !navigator.canShare) return false;

  try {
    let blob: Blob;
    if (content instanceof Blob) {
      blob = content;
    } else if (content.startsWith('data:')) {
      blob = dataUriToBlob(content);
    } else {
      blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    }

    const file = new File([blob], filename, { type: mimeType });
    if (navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: filename,
        files: [file],
      });
      return true;
    }
  } catch (e) {
    // 用户取消分享或系统不支持文件分享
  }
  return false;
}

function dataUriToBlob(dataUri: string): Blob {
  const parts = dataUri.split(',');
  const mime = parts[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
  const binary = atob(parts[1]);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
