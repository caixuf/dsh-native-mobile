/**
 * 验证"解码引擎"这一环：手机里用的是 vendored jsQR，这里用**同一份文件**解码，
 * 排除"引擎本身坏掉"这种可能。
 *
 * 不引新依赖：用 qrcode 的 create() 拿到原始模块矩阵，自己合成 ImageData。
 */
import QRCode from '../packages/dsh-mobile-gateway/node_modules/qrcode/lib/index.js';
import jsQR from '../src/vendor/jsQR.js';

const TEXT = 'http://192.168.1.23:19387/mobile-gateway/pair#K7M2QX';

/** 把 qrcode 的模块矩阵渲染成 RGBA 像素（含静区、每模块 scale 像素）。 */
function render(text, scale = 4, quiet = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const side = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (!qr.modules.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = ((y + quiet) * scale + dy) * side + ((x + quiet) * scale + dx);
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
          data[px * 4 + 3] = 255;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

console.log('\n  二维码解码引擎验证（用的是手机里同一份 jsQR）');
console.log('  ──────────────────────────────────────────────────');
let fail = 0;
for (const scale of [2, 3, 4, 6]) {
  const img = render(TEXT, scale);
  const t0 = process.hrtime.bigint();
  const out = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = out?.data === TEXT;
  if (!ok) fail += 1;
  console.log(`  ${ok ? '✓' : '✗'} 每模块 ${scale}px（${img.width}px 见方）耗时 ${ms.toFixed(0)}ms${ok ? '' : ' → 解不出'}`);
}

// 性能：视频扫描喂的是全帧，这个数据决定"半天识别不了"是不是性能问题
console.log('  ──────────────────────────────────────────────────');
const bench = (w, h, label) => {
  const buf = new Uint8ClampedArray(w * h * 4).fill(210);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 205; buf[i + 1] = 205; buf[i + 2] = 208;
  }
  const t = process.hrtime.bigint();
  jsQR(buf, w, h, { inversionAttempts: 'attemptBoth' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`  ${label} 耗时 ${ms.toFixed(0)}ms`);
  return ms;
};
const full = bench(1280, 720, '1280x720 整帧（当前实现直接喂这个）');
const mid = bench(640, 360, '640x360 降采样            ');
console.log(`\n  降采样后快 ${(full / mid).toFixed(1)} 倍 —— 而手机 CPU 约是本机的 3~6 倍，`);
console.log('  也就是说当前实现在手机上单帧可能就要 1~3 秒。');

console.log(fail === 0 ? '\n  ✓ 解码引擎本身正常，问题在喂给它的图/节奏\n' : '\n  ✗ 解码引擎有问题\n');
process.exit(fail === 0 ? 0 : 1);