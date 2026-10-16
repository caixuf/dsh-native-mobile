/**
 * 浅色主题可读性护栏（WCAG 2.1 AA：正文 4.5:1）。
 *
 * ## 为什么要有这个
 *
 * 2026-10-16 深色→浅色主题改造后，有一批**深色主题的文字色被留在了浅色底上**：
 *
 *   - 会话列表顶部提示条：`text-[#bfdbfe]` on `bg-[#3b82f6]/10`  = 1.27:1
 *   - 错误态提示条：      `text-[#fda4af]` on `bg-[#f43f5e]/10`  = 1.66:1
 *   - 语音浮层胶囊：      `text-[#60a5fa]` on `bg-[#3b82f6]/15`  = 2.14:1
 *   - 「远端」徽标：      `text-[#c084fc]` on `bg-[#a855f7]/15`  = 2.21:1
 *   - 待发队列重试图标：  `text-[#fb7185]` on `bg-[#f43f5e]/10`  = 2.37:1
 *
 * 这些**不报错、不崩、e2e 全绿**（文本断言能取到字，只是人看不见），
 * 与项目里 `test-qr-scan-loop.mjs` 治的是同一类病：**静默的视觉失效**。
 * 所以用源码护栏把它钉住，而不是靠人记得。
 *
 * ## 判据（每条都是踩过假阳性后收紧的，别放宽）
 *
 * 1. 只认同一条 className 里**自带背景**的组合 —— 父背景静态不可知；
 * 2. 含三元 `?` 或模板 `${` 的串**跳过** —— 否则会把「激活态背景」配
 *    「未激活态文字」（第一版这样报出 45 条，绝大多数是错配）；
 * 3. **必须解析透明度**（`/10`、`/[0.06]`、`/70`）并把前后景合成到不透明 ——
 *    否则 `bg-[#f43f5e]/10` 被当成实心玫红（第二版这样把两个达标按钮报成 1.36:1）。
 *
 * ## 盲区（诚实声明，不静默跳过；脚本会把数量打出来）
 *
 * - Tailwind v4 调色板是 `oklch()`，正则看不见 → 计数上报；
 * - 父元素提供背景（如深色代码块里的浅灰字）→ 计数上报；
 * - 渐变 / 图片 / 半透明叠层之上无法精确计算 → 不在覆盖范围内。
 *
 * node scripts/test-contrast.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('src');
const WHITE = '#ffffff';

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

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const lum = (hex) => {
  const c = hex.replace('#', '').match(/\w\w/g).map((x) => parseInt(x, 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
function over(fg, alpha, bg) {
  const f = fg.replace('#', '').match(/\w\w/g).map((x) => parseInt(x, 16));
  const b = bg.replace('#', '').match(/\w\w/g).map((x) => parseInt(x, 16));
  return '#' + f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}
function alphaOf(raw) {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return n > 1 ? Math.min(n / 100, 1) : n;
}

const TOKEN = (kind) =>
  new RegExp(`${kind}-\\[(#[0-9a-fA-F]{6})\\](?:\\/\\[?([\\d.]+)\\]?)?`, 'g');
const TAILWIND_PALETTE = /\b(?:text|bg|border)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

let hexText = 0, skippedPalette = 0, crossBranch = 0, noBg = 0;
const violations = [];
const sources = new Map();

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);
  sources.set(rel.replace(/\\/g, '/'), src);
  const classRe = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m;
  while ((m = classRe.exec(src))) {
    const cls = m[1] || m[2] || '';
    const line = src.slice(0, m.index).split('\n').length;
    const texts = [...cls.matchAll(TOKEN('text'))].map((x) => ({ hex: x[1].toLowerCase(), a: alphaOf(x[2]) }));
    if (!texts.length) continue;
    hexText += texts.length;

    if (/\?/.test(cls) || /\$\{/.test(cls)) { crossBranch += texts.length; continue; }
    const bgs = [...cls.matchAll(TOKEN('bg'))].map((x) => ({ hex: x[1].toLowerCase(), a: alphaOf(x[2]) }));
    if (!bgs.length) { noBg += texts.length; continue; }

    for (const t of texts) {
      for (const b of bgs) {
        const bg = over(b.hex, b.a, WHITE);
        const fg = over(t.hex, t.a, bg);
        const r = ratio(fg, bg);
        if (r < 4.5) {
          violations.push({ file: rel, line, text: t.hex, bg, ratio: +r.toFixed(2) });
        }
      }
    }
  }
  for (const _ of src.matchAll(TAILWIND_PALETTE)) skippedPalette++;
}

console.log('\n  浅色主题可读性 · 源码护栏');
console.log('  ──────────────────────────────────────────────────');
console.log(`  覆盖: ${hexText} 处 hex 文字色声明`);
console.log(`  盲区: oklch 调色板 ${skippedPalette} 处 / 跨分支 ${crossBranch} 处 / 父背景不可知 ${noBg} 处`);

check('判据覆盖范围内没有低于 4.5:1 的文字色', () => {
  assert(
    violations.length === 0,
    `发现 ${violations.length} 处「浅色字 + 浅色底」（正文门槛 4.5:1）：\n      ` +
      violations
        .sort((a, b) => a.ratio - b.ratio)
        .map((v) => `${v.ratio}:1  ${v.text} on ${v.bg}  ${v.file}:${v.line}`)
        .join('\n      '),
  );
});

check('会话列表提示条不再用「浅色字 + 浅色底」', () => {
  const src = sources.get('src/components/screens/SessionsScreen.tsx') || '';
  assert(!/text-\[#bfdbfe\]/.test(src), '提示条又用回了 #bfdbfe（在浅蓝底上只有 1.27:1，等于看不见）');
  assert(!/text-\[#fda4af\]/.test(src), '错误提示条又用回了 #fda4af（1.66:1）');
});

check('全仓库不再有深色面残留在浅色主题里（#141824 作背景）', () => {
  const bad = [];
  for (const [rel, src] of sources) {
    if (/bg-\[#141824\]/.test(src)) bad.push(rel);
  }
  assert(bad.length === 0, `这些文件仍把 #141824 当背景（浅色主题下是块黑板）：${bad.join(', ')}`);
});

console.log('  ──────────────────────────────────────────────────');
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
