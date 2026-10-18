/**
 * Android 原生单元测试入口。
 *
 * ## 为什么要有这个包装
 *
 * 原生侧（审批中继、协议契约、JSON 解析）以前**一条测试都没有** ——
 * 150 条 Kotlin 单测随旧代码库一起被删了，而"代码删了"不等于"陷阱消失了"。
 * 这个脚本让它们回到验证链里：跑 gradle 单测，并把结果**逐条读出来**。
 *
 * 为什么不用 `gateway` 那套 node 测试跑原生逻辑：那些类是 Kotlin/JVM 的。
 * 契约逻辑刻意写成零 Android 依赖的纯 Kotlin（见 MiniJson.kt 注释），
 * 才能这样在 JVM 上直接测。
 *
 * 工具链路径与本仓库既有的 `scripts/build-apk.mjs` 保持一致（本机是 Windows + 固定
 * 安装目录）。换机器时改这两个常量即可。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(rootDir, 'android');

const defaultWinJava = 'C:\\Users\\20247\\Downloads\\android-toolchain\\jdk17';
const defaultWinGradle = 'C:\\Users\\20247\\Downloads\\android-toolchain\\gradle-8.11.1\\bin\\gradle.bat';

const JAVA_HOME = process.env.JAVA_HOME || (fs.existsSync(defaultWinJava) ? defaultWinJava : undefined);
const GRADLE_BIN = process.env.GRADLE_BIN || (fs.existsSync(defaultWinGradle) ? defaultWinGradle : 'gradle');

console.log('🤖 Android 原生单元测试（JVM）');
console.log('─'.repeat(52));

execSync(`"${GRADLE_BIN}" testDebugUnitTest --console=plain`, {
  cwd: androidDir,
  env: {
    ...process.env,
    ...(JAVA_HOME ? { JAVA_HOME } : {}),
  },
  stdio: 'inherit',
});

// ── 把 JUnit XML 汇总出来（"BUILD SUCCESSFUL" 本身不说明测了几条）──────────
const resultsDir = path.join(androidDir, 'app', 'build', 'test-results', 'testDebugUnitTest');
if (!fs.existsSync(resultsDir)) {
  console.error(`找不到测试结果目录：${resultsDir}`);
  process.exit(2);
}

const attr = (xml, name) => {
  const m = xml.match(new RegExp(`${name}="(\\d+)"`));
  return m ? Number(m[1]) : 0;
};

let tests = 0;
let failures = 0;
let errors = 0;
let skipped = 0;
const suites = [];

for (const file of fs.readdirSync(resultsDir).filter((f) => f.endsWith('.xml'))) {
  const xml = fs.readFileSync(path.join(resultsDir, file), 'utf8');
  const t = attr(xml, 'tests');
  tests += t;
  failures += attr(xml, 'failures');
  errors += attr(xml, 'errors');
  skipped += attr(xml, 'skipped');
  const name = (xml.match(/<testsuite[^>]*name="([^"]+)"/) || [, file])[1];
  suites.push(`  ${name.split('.').pop()}  ${t} 条`);
}

console.log('');
if (suites.length > 0) {
  console.log('  测试类：');
  suites.forEach((s) => console.log(s));
  console.log('');
}

const failed = failures + errors;
if (failed === 0 && tests > 0) {
  console.log(`  ✓ ${tests} passed${skipped ? `, ${skipped} skipped` : ''}, 0 failed`);
  console.log('');
  process.exit(0);
}

console.error(`  ✗ ${tests - failed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
console.error('  详情见 android/app/build/reports/tests/testDebugUnitTest/index.html');
console.error('');
process.exit(1);