/**
 * 多语言与文案本地化（localizedText / i18n）回归测试与静态源码护栏。
 *
 * 覆盖在真实主机交互中导致严重体验恶化的缺陷：
 *   1. 多语言对象 `{zh, en}` 解析：zh 优先、en 回退、其他语种候选兜底
 *   2. 空白字符串清洗（避免包含全空格的 zh 字段导致 en 被吞噬）
 *   3. 🔴 关键防线：杜绝任何输入导致 `"[object Object]"` 乱码展示到用户界面
 *   4. 非法类型（null、undefined、数字、布尔、数组、空对象）的零崩溃安全回退
 *   5. 静态源码护栏：断言 App.tsx 审批链路全部经过 localizedText 过滤
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-i18n-localization.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localizedText } from '../src/utils/i18n.ts';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err });
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

console.log('多语言与文案本地化防御测试');
console.log('──────────────────────────────────────────────────');

check('1. 纯字符串输入直接原样返回', () => {
  eq(localizedText('执行终端命令'), '执行终端命令');
  eq(localizedText('Read file /etc/hosts'), 'Read file /etc/hosts');
  eq(localizedText(''), '');
});

check('2. 中英多语言对象：中文优先，英文回退', () => {
  eq(localizedText({ zh: '读取文件', en: 'Read file' }), '读取文件');
  eq(localizedText({ en: 'Execute bash command' }), 'Execute bash command');
});

check('3. 中文为空白字符时，自动回退到非空的英文', () => {
  eq(localizedText({ zh: '   \n\t ', en: 'Run tests' }), 'Run tests');
});

check('4. 其他语言候选兜底：取第一个非空字符串', () => {
  eq(localizedText({ ja: 'ファイルを読み込む' }), 'ファイルを読み込む');
  eq(localizedText({ fr: 'Exécuter la commande' }), 'Exécuter la commande');
});

check('5. 🔴 关键防线：任何输入绝不产出 "[object Object]"', () => {
  const testCases = [
    {},
    { foo: 'bar' },
    { zh: {} },
    { en: null },
    { count: 123 },
    Object.create(null),
    new Date(),
  ];

  for (const tc of testCases) {
    const res = localizedText(tc);
    ok(!res.includes('[object Object]'), `发现 [object Object] 乱码泄漏: input=${JSON.stringify(tc)} res=${res}`);
  }
});

check('6. 非对象与异常类型安全返回空串（不抛错）', () => {
  eq(localizedText(null), '');
  eq(localizedText(undefined), '');
  eq(localizedText(12345), '');
  eq(localizedText(true), '');
  eq(localizedText(false), '');
  eq(localizedText(Symbol('test')), '');
});

check('7. 静态源码护栏：App.tsx 必须引入并使用 localizedText 过滤审批说明', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const appSrc = readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');

  ok(
    /import\s*\{\s*localizedText\s*\}\s*from\s*['"].\/utils\/i18n['"]/.test(appSrc),
    'App.tsx 必须从 ./utils/i18n 导入 localizedText',
  );
  ok(
    !/String\(.*\.displayReason\)/.test(appSrc),
    'App.tsx 绝不得出现 String(...displayReason) 的危险原生字符串转换',
  );
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：多语言与文案本地化防御契约全部达成`);
}
