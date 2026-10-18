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
 * 工具链路径由 `scripts/lib/gradle.mjs` 统一解析：优先仓库自带的 wrapper
 * （CI / 换机器可复现），其次本机固定安装目录，最后 PATH 上的 gradle。
 * 本机 Windows 开发机仍是固定的 android-toolchain 目录，行为不变。
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGradle, gradleEnv } from './lib/gradle.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(rootDir, 'android');

const gradle = resolveGradle();
const GRADLE_BIN = gradle.bin;

console.log('🤖 Android 原生单元测试（JVM）');
console.log('─'.repeat(52));

let hasGradle = false;
try {
  // 探测也要带上 JAVA_HOME：wrapper 自己需要 java，否则会误判成「没装 Gradle」
  // 而静默跳过原生测试（2026-10-19 踩过：wrapper 存在但探测返回 false）。
  execSync(`"${GRADLE_BIN}" -v`, { stdio: 'ignore', env: gradleEnv() });
  hasGradle = true;
} catch {
  hasGradle = false;
}

if (!hasGradle) {
  console.log(`⚠️  当前环境未检测到 Gradle 工具链（请设置 GRADLE_BIN 或安装 Gradle），已自动跳过 JVM 原生测试。`);
  process.exit(0);
}

console.log(`   使用 Gradle (${gradle.kind}): ${GRADLE_BIN}`);

execSync(`"${GRADLE_BIN}" testDebugUnitTest --console=plain`, {
  cwd: androidDir,
  env: gradleEnv(),
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