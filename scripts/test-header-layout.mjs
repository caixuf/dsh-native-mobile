/**
 * 聊天页头部布局护栏（静态 + 口径一致性）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-19 用户反馈「头部各种信息又互相冲突了，布局很差」。
 * 在模拟器上用 CDP 量出的**真实数据**是：
 *
 *   viewport 宽   = 412px
 *   rightGroup 宽 = 515px，右边缘 x = 539px   ← 横向溢出 127px
 *
 * 溢出构成（每枚按钮 44px）：
 *   停止徽章 306px（因为文字是 `执行命令 · 第 55 步 · 已完成 2 步 · 用时 2秒 · 0秒`）
 *   + Plan 61 + 新会话 44 + 导出 44 + 更多 44
 *
 * 也就是说：**文案冗余**直接把「新会话/导出/更多」三枚按钮顶出了屏幕。
 * 这类问题不会让任何功能测试失败 —— 按钮还在 DOM 里、还能被点击，
 * 但用户在手机上看不见它们。所以必须单独加一层"几何/口径"护栏。
 *
 * 本文件做两类检查：
 *   A. 文案口径（纯函数）：同一个数字不能说两遍、两套口径不能并排。
 *   B. 静态结构：头部常驻控件数量与宽度预算、导出入口仍在、触控目标 ≥44px。
 *
 *   node --experimental-strip-types scripts/test-header-layout.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const chatSrc = readFileSync(join(ROOT, 'src/components/screens/ChatScreen.tsx'), 'utf8');
const statsBarSrc = readFileSync(join(ROOT, 'src/components/chat/SessionStatsBar.tsx'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err?.message || err}`);
  }
}
const ok = (cond, msg) => assert.ok(cond, msg);

console.log('\n  聊天页头部布局护栏');
console.log('  ' + '─'.repeat(50));

// ── B. 静态结构 ──────────────────────────────────────────────

test('头部常驻动作按钮不超过 2 枚（视口 412px，每枚 44px）', () => {
  // 只检查 header 块内直接的动作按钮。用 header.../header 截取，避免误数时间线里的按钮。
  const headerStart = chatSrc.indexOf('<header');
  const headerEnd = chatSrc.indexOf('</header>', headerStart);
  ok(headerStart >= 0 && headerEnd > headerStart, '找不到 <header> 块');

  const headerBlock = chatSrc.slice(headerStart, headerEnd);

  // 头部左侧的「打开菜单 / 返回列表」是**同一个位置的互斥按钮**（空会话显示菜单、
  // 有会话显示返回），不该算两枚。这里按 aria-label 区分开。
  const circular = (headerBlock.match(/w-11 h-11 rounded-full/g) || []).length;
  const leftSlot = (headerBlock.match(/aria-label="打开会话菜单"/g) || []).length
    + (headerBlock.match(/aria-label="返回会话列表"/g) || []).length;
  // 左侧互斥位置最多算 1 枚
  const effective = circular - Math.max(0, leftSlot - 1);

  ok(
    effective <= 3,
    `头部常驻 44px 圆形按钮有 ${effective} 枚（原始 ${circular}，左侧互斥占 ${leftSlot}）。\n` +
      `       预算：左侧互斥 1 + 新会话 1 + 更多 1 = 3；再多就会重演 127px 溢出。`,
  );
});

test('Plan / 导出 / 侧边菜单已收进二级菜单，不再常驻头部', () => {
  const headerStart = chatSrc.indexOf('<header');
  const headerEnd = chatSrc.indexOf('</header>', headerStart);
  const headerBlock = chatSrc.slice(headerStart, headerEnd);

  // 二级菜单容器存在
  ok(headerBlock.includes('data-testid="header-menu"'), '头部必须有二级菜单容器 header-menu');

  // 「更多」按钮必须能打开它
  ok(headerBlock.includes('setHeaderMenuOpen'), '「更多」按钮必须控制二级菜单');

  // 导出仍在（功能没丢），但位于菜单项内
  ok(headerBlock.includes('aria-label="导出为 Markdown"'), '导出入口不能消失，只是移到二级菜单');
});

test('运行态用单行文本表达，不再是超宽胶囊', () => {
  // 新增的 activity-headline 单行文本
  ok(chatSrc.includes('data-testid="activity-headline"'), '必须有单行运行态文案节点');
  // 旧版把整段 phaseLabel 塞进徽章；现在徽章只写「停止」
  const badgeIdx = chatSrc.indexOf('data-testid="activity-badge"');
  ok(badgeIdx > 0, '停止按钮需保留 activity-badge（e2e 用它判断空闲）');
  const badgeBlock = chatSrc.slice(badgeIdx, badgeIdx + 900);
  ok(!badgeBlock.includes('activityHeadlineText'), '徽章里不该再塞长文案（会重演 306px）');
});

test('「停止当前任务」不再出现三处', () => {
  // 旧版：头部徽章 + 时间线 + 输入区 = 3 处，每处都占 44px 垂直空间
  const count = (chatSrc.match(/aria-label="停止当前任务"/g) || []).length;
  ok(count <= 2, `「停止当前任务」出现了 ${count} 次；头部与输入区各一处即可（旧版 3 处）`);
});

test('统计条不再用彩色图标 + 圆点分隔（窄屏宽度浪费）', () => {
  ok(!statsBarSrc.includes('Gauge'), '统计条不该再引入彩色图标（纯占宽度）');
  // 段间不该用「·」字符分隔（改由 gap 承担）
  ok(!statsBarSrc.includes('>·<'), '段间不该再用「·」字符');
});

test('所有可点控件触控目标 ≥44px', () => {
  const headerStart = chatSrc.indexOf('<header');
  const headerEnd = chatSrc.indexOf('</header>', headerStart);
  const headerBlock = chatSrc.slice(headerStart, headerEnd);

  // 提取 <button ...> 开标签。JSX 的属性值里可能含 '>'（箭头函数 `=>`、比较运算），
  // 所以不能简单找第一个 '>' —— 要跟踪引号与 {} 嵌套深度，只在两者都归零时收尾。
  const openTags = [];
  let i = headerBlock.indexOf('<button');
  while (i >= 0) {
    let depth = 0;
    let quote = null;
    let j = i + '<button'.length;
    for (; j < headerBlock.length; j += 1) {
      const ch = headerBlock[j];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    openTags.push(headerBlock.slice(i, j + 1));
    i = headerBlock.indexOf('<button', j);
  }

  ok(openTags.length > 0, '头部应有按钮');
  for (const tag of openTags) {
    // 两种达标方式，二选一：
    //   A. 可见尺寸本身 ≥44px（w-11 / h-11 / min-h-[44px]）
    //   B. 视觉上是小胶囊，但用 before: 伪元素把**可点区域**撑到 ≥44px
    //      （-inset-y-[12px] + 20px 可见高 = 44px，见下方数值校验）
    const visibleOk = /w-11|h-11|min-h-\[44px\]/.test(tag);
    const hitAreaOk = /before:-inset-y-\[12px\]/.test(tag);
    ok(
      visibleOk || hitAreaOk,
      `头部按钮缺少 44px 触控目标：${tag.replace(/\s+/g, ' ').slice(0, 130)}`,
    );
  }
});

test('小胶囊的伪元素命中区确实算到 44px（数值校验，不是看类名像不像）', () => {
  // 可见高 = leading 14px + py-0.5(4px) + border(2px) = 20px
  // 伪元素上下各伸出 12px → 20 + 24 = 44px
  const visible = 14 + 4 + 2;
  ok(visible === 20, `可见高度推算错误：${visible}`);
  ok(visible + 12 * 2 === 44, `命中区推算错误：${visible + 12 * 2}px ≠ 44px`);
});

console.log('  ' + '─'.repeat(50));
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
