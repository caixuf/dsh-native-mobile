import jsQR from '../vendor/jsQR.js';

/**
 * Decode QR code from ImageData using native BarcodeDetector if available,
 * with pure offline jsQR fallback.
 */
export async function decodeQrFromImageData(imageData: ImageData): Promise<string | null> {
  // 1. Try native BarcodeDetector (supported in modern Chrome / Android WebView)
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const BarcodeDetectorClass = (window as unknown as { BarcodeDetector: any }).BarcodeDetector;
      const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
      if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(imageData);
        const results = await detector.detect(bitmap);
        bitmap.close();
        if (results && results.length > 0 && results[0]?.rawValue) {
          return results[0].rawValue;
        }
      }
    } catch {
      // Fallback to jsQR
    }
  }

  // 2. Offline jsQR engine
  try {
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (code && code.data) {
      return code.data;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Decode QR code from an image file (e.g. photo selected from album or captured via file picker).
 */
export async function decodeQrFromImageFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const res = await decodeQrFromImageData(imgData);
          resolve(res);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = reader.result as string;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}
