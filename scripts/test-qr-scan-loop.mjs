/**
 * 扫码扫描循环的源码护栏。
 *
 * 为什么要有这个：v1.0.3 把 `if (!scanning) return;` 误写成 `if (scanning) return;`，
 * 循环一进来就退出且不再排下一帧 —— **一帧都没解码过**，而画面照常显示、
 * 不报任何错，只有真人拿手机对着码试才会发现。这类"控制流反转"没有任何运行时
 * 报错，纯人工回归极难防。
 *
 * node --experimental-strip-types scripts/test-qr-scan-loop.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join('src', 'components', 'pairing', 'QrScannerModal.tsx');
const src = fs.readFileSync(FILE, 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

console.log('\n  扫码扫描循环 · 源码护栏');
console.log('  ──────────────────────────────────────────────────');

check('scanFrame 的退出条件必须是「没在扫描才退出」', () => {
  const fnStart = src.indexOf('const scanFrame = async (timestamp: number) => {');
  assert(fnStart > 0, '找不到 scanFrame 函数');
  const body = src.slice(fnStart, fnStart + 400);
  // 只看签名之后的第一段：必须出现 !scanning，且**不能**出现写反的条件
  assert(
    /if \(!scanning\) return;/.test(body),
    `scanFrame 的第一个退出条件不是 if (!scanning) return —— 这正是 v1.0.3 扫不出码的原因。实际开头是：\n      ${body.slice(0, 160).replace(/\n/g, '\n      ')}`,
  );
  assert(
    !/\n\s*if \(scanning\) return;/.test(body),
    'scanFrame 里出现了写反的条件 if (scanning) return; —— 循环一进来就退出，永远不扫',
  );
});

check('退出后仍要排下一帧，否则循环只跑一次', () => {
  const fnStart = src.indexOf('const scanFrame = async (timestamp: number) => {');
  const body = src.slice(fnStart, src.indexOf('return () => {', fnStart));
  assert(
    /requestAnimationFrame\(scanFrame\)/.test(body),
    'scanFrame 里没有 requestAnimationFrame(scanFrame)，循环无法持续',
  );
});

check('相机流放在 ref 里（避免 effect 依赖死循环）', () => {
  assert(/const streamRef = useRef<MediaStream \| null>\(null\)/.test(src), '缺少 streamRef');
  // stopCamera 必须是空依赖，否则每次 stream 变化都会重挂 effect、把自己刚开的流关掉
  const stopAt = src.indexOf('const stopCamera = useCallback(() => {');
  assert(stopAt > 0, '找不到 stopCamera');
  const stopBody = src.slice(stopAt, src.indexOf('const startCamera', stopAt));
  assert(/\},\s*\[\]\);/.test(stopBody), 'stopCamera 的依赖数组不是空的 —— 会再次触发挂载相机的 effect 死循环');
});

check('WebView 播放所需的 muted / playsinline 都在', () => {
  assert(/autoPlay/.test(src), '<video> 缺少 autoPlay');
  assert(/video\.muted = true/.test(src), '没有显式设置 video.muted = true（WebView 只认属性）');
  assert(/webkit-playsinline/.test(src), "没有设置 webkit-playsinline");
});

check('降采样后再解码，避免手机上单帧就要一两秒', () => {
  assert(/MAX_SIDE/.test(src) && /getImageData\(0, 0, dw, dh\)/.test(src), '扫描前没有降采样');
});

check('卡住 8 秒要如实报错，而不是无声空转', () => {
  assert(/startedAt \+ 8000|startedAt > 8000/.test(src), '缺少看门狗');
  assert(/setCameraError\(/.test(src), '看门狗没有产出错误提示');
});

console.log('  ──────────────────────────────────────────────────');
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);