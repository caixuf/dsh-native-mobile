/**
 * 会话统计（session/projections）单元测试。
 * 样本是**真主机实测原文**（2026-10-15，session-c84c85cc…）：
 *   session/projections {request:{sessionId}} → {asOfSeq, values:{sessionStats, tokenUsage, contextPressure, contextBreakdown}}
 *
 *   node --experimental-strip-types scripts/test-session-stats.mjs
 */
import {
  averageTtftMs,
  billedInputTokens,
  buildReadouts,
  formatCacheHitPercent,
  formatContextPercent,
  formatMs,
  formatTokens,
  formatTokensPerSecond,
  pickProjections,
  totalTokens,
} from '../src/lib/session-stats.ts';

// 真主机实测原文（一个跑了很多轮的会话）
const REAL = {
  asOfSeq: 1234,
  values: {
    sessionStats: {
      turns: 20,
      steps: 906,
      llmMs: 11530541,
      toolMs: 11950923,
      ttftMs: 9334524,
      ttftSteps: 904,
      decodeMs: 2196017,
      decodeTokens: 641389,
    },
    tokenUsage: {
      uncachedInputTokens: 19038075,
      outputTokens: 645071,
      cacheReadTokens: 314698576,
      cacheWriteTokens: 0,
    },
    contextPressure: { pressureTokens: 373959, projectedTokens: 374055, contextWindow: 1048576 },
    contextBreakdown: { systemTokens: 3122, toolsTokens: 19172, messageTokens: 273182 },
  },
};

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
function eq(a, b, msg = '') {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}\n      expected: ${y}\n      actual:   ${x}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || '期望为真');
}

console.log('\n  会话统计（session/projections）单元测试');
console.log('  ──────────────────────────────────────────────────');

check('能从 {asOfSeq, values} 里挑出四个投影（也容忍直接给 values）', () => {
  const p = pickProjections(REAL);
  eq(p.sessionStats?.steps, 906);
  eq(p.tokenUsage?.cacheReadTokens, 314698576);
  eq(p.contextPressure?.contextWindow, 1048576);
  eq(p.contextBreakdown?.messageTokens, 273182);
  const flat = pickProjections(REAL.values);
  eq(flat.sessionStats?.turns, 20, '直接给 values 也要能取');
  eq(pickProjections(null), {});
  eq(pickProjections('nope'), {});
  eq(pickProjections({}), {});
});

check('tok/s 与桌面版同口径：decodeTokens / (decodeMs/1000)', () => {
  // 641389 / 2196.017 = 292.06… 桌面版截图当时显示 295 tok/s（同一公式，会话在跑所以数字在变）
  eq(formatTokensPerSecond(REAL.values.sessionStats), '292 tok/s');
  eq(formatTokensPerSecond({ decodeTokens: 100, decodeMs: 1000 }), '100 tok/s');
  eq(formatTokensPerSecond({ decodeTokens: 150, decodeMs: 1000 }), '150 tok/s');
  // 没有解码时长就**没有读数**，不能显示 0
  eq(formatTokensPerSecond({ decodeTokens: 0, decodeMs: 0 }), null);
  eq(formatTokensPerSecond({ decodeTokens: 100 }), null);
  eq(formatTokensPerSecond(null), null);
  eq(formatTokensPerSecond(undefined), null);
});

check('计费输入 = 三个互斥桶之和', () => {
  eq(billedInputTokens(REAL.values.tokenUsage), 19038075 + 314698576);
  eq(billedInputTokens({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 }), 6);
  eq(billedInputTokens(null), 0);
  eq(totalTokens(REAL.values.tokenUsage), 19038075 + 314698576 + 645071);
});

check('缓存命中率（实测这条会话 ≈94%，与桌面截图一致）', () => {
  const hit = formatCacheHitPercent(REAL.values.tokenUsage);
  ok(hit === '94.3' || hit === '94.4', `实测算出 ${hit}`);
  eq(formatCacheHitPercent({ cacheReadTokens: 100, uncachedInputTokens: 0, cacheWriteTokens: 0 }), '100', '满命中是 100');
  eq(formatCacheHitPercent({ cacheReadTokens: 0, uncachedInputTokens: 100 }), null, '没命中不显示 0%');
  eq(formatCacheHitPercent({}), null, '没有输入不显示');
  eq(formatCacheHitPercent(null), null);
});

check('上下文占用（实测 ≈35.7%）', () => {
  eq(formatContextPercent(REAL.values.contextPressure), '35.7');
  eq(formatContextPercent({ pressureTokens: 500, contextWindow: 1000 }), '50');
  eq(formatContextPercent({ pressureTokens: 600, contextWindow: 1000 }), '60');
  eq(formatContextPercent({ contextWindow: 0 }), null, '窗口未知不猜');
  eq(formatContextPercent({ pressureTokens: 0, contextWindow: 1000 }), null);
  eq(formatContextPercent(null), null);
  // 没有 pressureTokens 时退回 projectedTokens
  eq(formatContextPercent({ projectedTokens: 250, contextWindow: 1000 }), '25');
});

check('平均首字延迟', () => {
  // 9334524 / 904 = 10325.9ms
  eq(averageTtftMs(REAL.values.sessionStats), 10326);
  eq(averageTtftMs({ ttftMs: 100, ttftSteps: 0 }), null, '没样本不显示');
  eq(averageTtftMs(null), null);
});

check('时长格式：<60s 一位小数，超过用 m/s', () => {
  eq(formatMs(45200), '45.2s');
  eq(formatMs(162000), '2m42s');
  eq(formatMs(0), '');
  eq(formatMs(-1), '');
});

check('token 紧凑格式与桌面版一致（K/M）', () => {
  eq(formatTokens(517), '517');
  eq(formatTokens(12200), '12.2K');
  eq(formatTokens(517000), '517K');
  eq(formatTokens(1200000), '1.2M');
  eq(formatTokens(0), '0');
});

check('三个读数拼装成状态栏文案', () => {
  const r = buildReadouts(pickProjections(REAL));
  ok(r.activity && r.activity.includes('20 轮 906 步'), `activity=${r.activity}`);
  ok(r.activity && r.activity.includes('292 tok/s'), `activity=${r.activity}`);
  ok(r.usage && r.usage.includes('缓存命中'), `usage=${r.usage}`);
  ok(r.usage && r.usage.includes('334M'), `usage=${r.usage}（>=100 时按桌面版口径取整）`);
  eq(r.context, '35.7%');
  // 明细里应有模型/工具耗时、首字延迟、缓存桶、上下文构成
  const labels = r.detail.map((d) => d.label);
  for (const want of ['模型耗时', '工具耗时', '首字延迟', '输出速度', '缓存命中', '缓存读取', '上下文']) {
    ok(labels.includes(want), `明细缺少「${want}」，现有：${JSON.stringify(labels)}`);
  }
});

check('数据缺失时读数为 null（UI 必须隐藏，绝不显示 0 冒充真实值）', () => {
  const empty = buildReadouts({});
  eq(empty.activity, null);
  eq(empty.usage, null);
  eq(empty.context, null);
  eq(empty.detail, []);

  const partial = buildReadouts({ sessionStats: { turns: 0, steps: 0, decodeMs: 0, decodeTokens: 0 } });
  eq(partial.activity, null, '全 0 视为没有数据');
  eq(partial.usage, null);

  const noSpeed = buildReadouts({ sessionStats: { turns: 3, steps: 7 } });
  ok(noSpeed.activity === '3 轮 7 步', `没有速度时应只剩计数：${noSpeed.activity}`);
  ok(!noSpeed.activity?.includes('tok/s'), '没有速度就不该出现 tok/s');
});

console.log('  ──────────────────────────────────────────────────');
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);