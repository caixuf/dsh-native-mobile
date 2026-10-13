#!/usr/bin/env node
/**
 * @file scripts/check-app-methods.mjs
 * @description 门禁：校验 **App 调用的每个 RPC 方法名，都真实存在于主机上**。
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-10-13 的真实事故：App 调用 `session.history` 读会话，而**真实主机没有这个方法**
 * （真名 `session.page`）。这个错误：
 *   - 网关的 50 项 E2E 断言**全部通过** —— 因为那些测试测的是网关，不读 Kotlin 源码
 *   - 契约文档也没发现 —— 因为文档是从**客户端 bundle** 挖的，与主机不同步
 *   - 直到真机联调才暴露，代价是「进会话必失败」
 *
 * 也就是说，**App ↔ 主机的契约一致性此前没有任何自动化守护**。这个脚本补上它。
 *
 * ## 取证来源（按可信度）
 *
 *   1. 真实主机源码：app.asar 内 @deepseek-ai/dsh-api-<包>/lib/*.js
 *      （含 `@Remote(...)` 注册与 zod schema）
 *   2. 对运行中的主机发真实请求
 *   3. 客户端 bundle —— **最不可信**，已出现过 session.history 这类错误
 *
 * 本脚本用来源 1。若 app.asar 不在预期位置（例如换机器、或跑在 CI 上），
 * 脚本会**明确报「无法验证」并以非零码退出**，而不是假装通过 —— 静默跳过
 * 就等于把这道门禁变成摆设。
 *
 * 用法：
 *   node scripts/check-app-methods.mjs
 *   node scripts/check-app-methods.mjs --asar "D:\path\to\app.asar"
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const appSrc = join(repo, 'apps', 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'dshmobile', 'app');

const asarArgIndex = process.argv.indexOf('--asar');
const asarPath =
  asarArgIndex > 0
    ? process.argv[asarArgIndex + 1]
    : join(
        process.env.LOCALAPPDATA ?? '',
        'Programs',
        'DeepSeek Harness',
        'resources',
        'app.asar',
      );

// ---- 1. 收集 App 实际调用的方法名 ----------------------------------------
function collectKotlinFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectKotlinFiles(full));
    else if (entry.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

const appMethods = new Map(); // method -> [file:line, ...]
for (const file of collectKotlinFiles(appSrc)) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(repo.length + 1).replace(/\\/g, '/');
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    // 抓 .call("ns.method", ...) —— 只认形如 a.b 的点分方法名
    for (const m of lineText.matchAll(/\.call\(\s*"([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)"/g)) {
      const list = appMethods.get(m[1]) ?? [];
      list.push(`${rel}:${i + 1}`);
      appMethods.set(m[1], list);
    }
  });
}

if (appMethods.size === 0) {
  console.error('没从 App 源码里抽出任何 RPC 调用 —— 解析逻辑可能失效了，请检查。');
  process.exit(2);
}

console.log(`\nApp 调用的 RPC 方法（${appMethods.size} 个）：`);
for (const [method, sites] of [...appMethods].sort()) {
  console.log(`  ${method.padEnd(20)} ${sites.length} 处  ${sites[0]}`);
}

// ---- 2. 从真实主机 app.asar 里枚举已注册的方法名 -------------------------
if (!existsSync(asarPath)) {
  console.error(`\n🔴 无法验证：找不到 app.asar`);
  console.error(`   期望路径：${asarPath}`);
  console.error('   可用 --asar <路径> 指定。');
  console.error('   注意：这里刻意不「跳过并成功退出」—— 静默跳过等于这道门禁不存在。');
  process.exit(2);
}

/**
 * 读取 asar 内的单个文件。
 * 布局：[4B pickleLen][4B headerStringLen][headerJSON][data...]
 * ⚠️ header 字符串长度在**偏移 12**。写成偏移 4 会读出垃圾并让 JSON.parse 卡死（踩过）。
 */
function readAsarFile(fd, header, base, inner) {
  let node = header;
  for (const seg of inner.split('/')) {
    node = node?.files?.[seg];
    if (!node) return null;
  }
  if (!node || node.offset === undefined || node.size === undefined) return null;
  const size = Number(node.size);
  if (!Number.isFinite(size) || size <= 0 || size > 40e6) return null;
  const buf = Buffer.alloc(size);
  try {
    readFileSyncInto(fd, buf, base + Number(node.offset));
  } catch {
    return null;
  }
  return buf.toString('utf8');
}

// 用 fs.readSync 读入（readFileSync 不能带 offset，故单独包一层）
import { readSync, openSync, closeSync } from 'node:fs';
function readFileSyncInto(fd, buf, position) {
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, position + read);
    if (n <= 0) break;
    read += n;
  }
}

const fd = openSync(asarPath, 'r');
let hostMethodNames = new Set();
try {
  const sz = Buffer.alloc(16);
  readSync(fd, sz, 0, 16, 0);
  const headerSize = sz.readUInt32LE(12);
  const hb = Buffer.alloc(headerSize);
  readSync(fd, hb, 0, headerSize, 16);
  const header = JSON.parse(hb.toString('utf8'));
  const base = 16 + headerSize;

  // 收集所有文件路径
  const files = [];
  (function walk(node, path) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = `${path}/${name}`;
      if (child.files) walk(child, p);
      else if (!child.link && child.offset !== undefined) files.push(p);
    }
  })(header, '');

  // 只扫可能含 RPC 注册的包
  const targets = files.filter((f) =>
    /@deepseek-ai\/dsh-(api-|host-apiproxy|client-connection)/.test(f),
  );

  for (const f of targets) {
    const text = readAsarFile(fd, header, base, f.replace(/^\//, ''));
    if (!text) continue;
    // 收集形如 "session.page" / "workspace.create" 的字符串字面量
    for (const m of text.matchAll(/["'`]((?:session|workspace|host|subagents|commands|skills|goals|agentPreset|credentials|settings|llm)\.[a-zA-Z][\w.]*)["'`]/g)) {
      hostMethodNames.add(m[1]);
    }
    // 也收集 @Remote('name') 形式（需要与命名空间拼接，这里只记录裸名做粗筛）
    for (const m of text.matchAll(/@Remote\(\s*['"]([a-zA-Z][\w]*)['"]/g)) {
      hostMethodNames.add(`*@Remote:${m[1]}`);
    }
  }
} finally {
  closeSync(fd);
}

console.log(`\n从真实主机 app.asar 收集到 ${hostMethodNames.size} 个字面量方法名。`);

// ---- 3. 逐个比对 ---------------------------------------------------------
// @Remote('x') 的裸名要拼命名空间才能比对，这里只做「是否存在同名裸名」的粗筛。
const bareRemoteNames = new Set(
  [...hostMethodNames].filter((n) => n.startsWith('*@Remote:')).map((n) => n.slice('*@Remote:'.length)),
);

const missing = [];
const found = [];
for (const method of appMethods.keys()) {
  if (hostMethodNames.has(method)) {
    found.push(method);
    continue;
  }
  const leaf = method.split('.').pop();
  if (bareRemoteNames.has(leaf)) {
    found.push(method); // 通过 @Remote('leaf') 间接确认
    continue;
  }
  missing.push(method);
}

console.log('\n比对结果：');
for (const method of found.sort()) {
  console.log(`  ok ${method}`);
}
for (const method of missing) {
  console.log(`  🔴 ${method}  —— 真实主机上找不到`);
  for (const site of appMethods.get(method)) console.log(`       ${site}`);
}

if (missing.length > 0) {
  console.log(`\n发现 ${missing.length} 个方法名在真实主机上不存在。`);
  console.log('这类错误会让 App 的对应功能 100% 失败，且网关测试查不出来。');
  console.log('修法：核对 app.asar 内 @deepseek-ai/dsh-api-<包>/lib/*.js 的真实方法名。');
  process.exit(1);
}

console.log('\n全部方法名都在真实主机上存在。');
process.exit(0);
