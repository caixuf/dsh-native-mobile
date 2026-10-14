/**
 * 增量流式解析：正确性 + 性能验证。
 *
 * 正确性是第一位的 —— 缓存出错会给用户显示**过期的排版**，比慢严重得多。
 * 所以核心断言是：**逐字符流式增量解析的最终结果，必须与全量解析逐字节相同。**
 */
import {
  parseMarkdown,
  parseMarkdownIncremental,
  resetIncrementalCache,
} from '../src/lib/markdown.ts';

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.log('  ✗ ' + msg);
  }
}

/** 把 AST 序列化成可比对字符串（含全部字段，任何差异都会暴露）。 */
function canon(blocks) {
  return JSON.stringify(blocks);
}

const DOCS = {
  'plain text': `第一段。\n\n第二段。\n\n第三段。`,
  'mixed blocks': [
    '# 标题',
    '',
    '正文一段，含 **粗体** 与 `代码`。',
    '',
    '- 列表项 A',
    '- 列表项 B',
    '',
    '> 引用块',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const a = 1;',
    'const b = 2;',
    '```',
    '',
    '> [!WARNING]',
    '> 注意安全',
    '',
    '结尾段落。',
  ].join('\n'),
  'unclosed fence': '前言。\n\n```py\nprint(1)\nprint(2)',
  'task list': '- [x] 完成\n- [ ] 未完成\n\n后续段落。',
  'table then text': '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文。',
};

console.log('\n  增量流式解析验证');
console.log('  ' + '-'.repeat(52));

// ── 1. 逐字符流式：最终结果必须等于全量解析 ────────────────────────────────
for (const [name, doc] of Object.entries(DOCS)) {
  resetIncrementalCache();
  let last = null;
  for (let i = 1; i <= doc.length; i++) {
    last = parseMarkdownIncremental(doc.slice(0, i));
  }
  const full = parseMarkdown(doc);
  ok(canon(last) === canon(full), `${name}: 流式终态 != 全量解析`);
}
console.log(`  ✓ 逐字符流式终态一致性（${Object.keys(DOCS).length} 篇文档）`);

// ── 2. 关键：流式过程中每一步都不能显示「过期的错排版」 ────────────────────
// 逐步比对：每个前缀的增量结果必须等于该前缀的全量解析结果。
let stepMismatches = 0;
for (const [name, doc] of Object.entries(DOCS)) {
  resetIncrementalCache();
  for (let i = 1; i <= doc.length; i++) {
    const inc = parseMarkdownIncremental(doc.slice(0, i));
    const full = parseMarkdown(doc.slice(0, i));
    if (canon(inc) !== canon(full)) {
      stepMismatches++;
      if (stepMismatches <= 3) {
        console.log(`  ✗ ${name} @${i}: 增量 != 全量`);
        console.log(`      inc : ${canon(inc).slice(0, 160)}`);
        console.log(`      full: ${canon(full).slice(0, 160)}`);
      }
    }
  }
}
ok(stepMismatches === 0, `流式过程共 ${stepMismatches} 步与全量不一致`);

// ── 3. 内容回退（编辑/重试）不能复用过期缓存 ──────────────────────────────
resetIncrementalCache();
parseMarkdownIncremental('第一段。\n\n第二段。\n\n第三段。');
resetIncrementalCache();
const afterReset = parseMarkdownIncremental('完全不同的内容。\n\n另一个段落。');
const expectReset = parseMarkdown('完全不同的内容。\n\n另一个段落。');
ok(canon(afterReset) === canon(expectReset), 'reset 后仍复用了错误缓存');

// 不回退但换个短文本（前缀不匹配）
resetIncrementalCache();
parseMarkdownIncremental('AAA\n\nBBB\n\nCCC');
const swapped = parseMarkdownIncremental('XXX\n\nYYY\n\nZZZ');
ok(canon(swapped) === canon(parseMarkdown('XXX\n\nYYY\n\nZZZ')), '前缀不匹配时复用了错误缓存');

// ── 4. 多实例串扰：两个不同文档交替增量解析 ───────────────────────────────
resetIncrementalCache();
const d1 = 'A1\n\nA2\n\nA3\n\nA4';
const d2 = 'B1\n\nB2\n\nB3\n\nB4';
for (let i = 1; i <= d1.length; i++) parseMarkdownIncremental(d1.slice(0, i));
const r2 = parseMarkdownIncremental(d2);
ok(canon(r2) === canon(parseMarkdown(d2)), '交替文档时发生缓存串扰');

// ── 5. 性能：流式全过程的解析耗时必须显著优于全量 ─────────────────────────
// 模拟一条长回复逐 token 到达（每次追加 4 字符）。
const longDoc = Array.from({ length: 120 }, (_, i) =>
  `## 小节 ${i}\n\n这是第 ${i} 段的正文，含 **粗体** 和 \`code\`，长度足够。\n\n- 项 A\n- 项 B\n`
).join('\n');

const STEP = 4;

function benchIncremental() {
  resetIncrementalCache();
  const t0 = performance.now();
  for (let i = STEP; i <= longDoc.length; i += STEP) {
    parseMarkdownIncremental(longDoc.slice(0, i));
  }
  return performance.now() - t0;
}

function benchFull() {
  const t0 = performance.now();
  for (let i = STEP; i <= longDoc.length; i += STEP) {
    parseMarkdown(longDoc.slice(0, i));
  }
  return performance.now() - t0;
}

// 预热
benchIncremental();
benchFull();

const incMs = benchIncremental();
const fullMs = benchFull();
const speedup = fullMs / incMs;

console.log(`  文档规模: ${longDoc.length} 字符, 分 ${Math.floor(longDoc.length / STEP)} 次追加`);
console.log(`  全量解析累计: ${fullMs.toFixed(1)} ms`);
console.log(`  增量解析累计: ${incMs.toFixed(1)} ms`);
console.log(`  加速比:       ${speedup.toFixed(2)}x`);
ok(speedup > 1.5, `增量解析应有明显收益，实测仅 ${speedup.toFixed(2)}x`);

console.log('  ' + '-'.repeat(52));
console.log(`  ${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
