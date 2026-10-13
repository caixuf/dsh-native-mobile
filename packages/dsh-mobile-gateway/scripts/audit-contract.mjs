#!/usr/bin/env node
/**
 * @file scripts/audit-contract.mjs
 * @description 把 App 实际调用的方法名与参数，对照契约文档做**辅助检查**。
 *
 * ⚠️ 定位说明（很重要，别把它当门禁）：
 *
 *   1. 它用正则解析 Kotlin 源码，**无法可靠处理多行/嵌套构造**。参数若由 helper
 *      函数拼装（例如 ChatViewModel.pageRequest()），正则会漏掉，产生误报。
 *   2. 它**发现不了「方法名在真实主机上不存在」** —— 而这正是本项目踩过的最严重的坑
 *      （App 曾调用不存在的 `session.history`）。那类问题必须靠核对真实主机源码：
 *      app.asar 内 @deepseek-ai/dsh-api-<包名>/lib 下的 js，或对运行中的主机发真实请求。
 *
 *   因此：本脚本只用来提示「可能漏了必填参数」，结论必须人工复核。
 *   方法名是否存在，一律以真实主机为准（见 docs/api-contract.md 顶部警告）。
 *
 * 用法：node scripts/audit-contract.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const appSrc = join(repo, 'apps', 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'dshmobile', 'app');
const contractPath = join(repo, 'docs', 'api-contract.md');

/** 已知的、可安全跳过的调用点（参数由 helper 构造，正则抓不全）。 */
const KNOWN_HELPER_CALLS = new Set(['session.page']);

// ---- 1. 从 App 源码里抽出所有 RPC 调用 -----------------------------------
function collectKotlinFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectKotlinFiles(full));
    else if (entry.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

const callSites = [];
for (const file of collectKotlinFiles(appSrc)) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(repo.length + 1).replace(/\\/g, '/');
  const re = /\.call\(\s*"([a-zA-Z][\w.]*)"\s*,([\s\S]{0,800}?)\)\s*[.\n]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    callSites.push({ file: rel, line, method: m[1], argsRaw: m[2] });
  }
}

console.log(`\n从 App 源码抽出 ${callSites.length} 处 RPC 调用（正则解析，仅作提示）：\n`);

// ---- 2. 解析契约文档里的方法表 -------------------------------------------
const contract = readFileSync(contractPath, 'utf8');
const contractMethods = new Map();
for (const line of contract.split('\n')) {
  const m = line.match(/^\|\s*`([a-zA-Z][\w.]*)`\s*\|\s*([^|]*)\|\s*([^|]*)\|/);
  if (m) contractMethods.set(m[1], { params: m[2].trim(), returns: m[3].trim() });
}

// ---- 3. 逐条比对（只查必填参数）------------------------------------------
let ok = 0;
let skipped = 0;
let unknown = 0;
const suspicious = [];

for (const site of callSites) {
  const spec = contractMethods.get(site.method);
  const where = `${site.file}:${site.line}`;

  if (!spec) {
    unknown += 1;
    console.log(`  ?  ${site.method.padEnd(24)} 契约文档里没有 —— ${where}`);
    console.log(`       ⚠️ 必须去真实主机核对方法名是否存在（见文件头说明）`);
    continue;
  }
  if (KNOWN_HELPER_CALLS.has(site.method)) {
    skipped += 1;
    console.log(`  -- ${site.method.padEnd(24)} 参数由 helper 构造，正则抓不全，跳过 ${where}`);
    continue;
  }

  const keys = [...site.argsRaw.matchAll(/put\(\s*"([^"]+)"/g)].map((x) => x[1]);

  const requiredKeys = [];
  const optionalKeys = [];
  for (const m2 of spec.params.matchAll(/`([a-zA-Z][\w]*)(\?)?`/g)) {
    if (m2[2] === '?') optionalKeys.push(m2[1]);
    else requiredKeys.push(m2[1]);
  }
  for (const m2 of spec.params.matchAll(/([a-zA-Z][\w]*)\s*:\s*/g)) {
    const name = m2[1];
    if (!requiredKeys.includes(name) && !optionalKeys.includes(name)) requiredKeys.push(name);
  }

  const missingRequired = requiredKeys.filter((k) => !keys.includes(k));
  if (missingRequired.length === 0) {
    ok += 1;
    console.log(`  ok ${site.method.padEnd(24)} 必填参数齐全 [${keys.join(', ')}]`);
  } else {
    suspicious.push({ method: site.method, where, missingRequired });
    console.log(`  !! ${site.method.padEnd(24)} 可能缺必填: ${missingRequired.join(', ')}  ${where}`);
    console.log(`       契约: ${spec.params}`);
    console.log(`       实参: [${keys.join(', ')}]  ← 人工复核，可能是正则漏抓`);
  }
}

console.log(`\n汇总：齐全 ${ok} / 跳过 ${skipped} / 契约无记录 ${unknown} / 待人工复核 ${suspicious.length}`);
console.log('注意：本脚本查不出「方法名在真实主机上不存在」，那类问题必须核对 app.asar 内的主机源码。');

// ---- 4. 信封形状专项检查 -------------------------------------------------
console.log('\n信封形状专项：');
const envelopes = readFileSync(join(appSrc, 'net', 'Envelopes.kt'), 'utf8');
const checks = [
  ['client-request 含 type/rpcId/method/payload', ['"type"', '"rpcId"', '"method"', '"payload"'].every((k) => envelopes.includes(k))],
  ['client-response 含 type/rpcId/result', ['TYPE_CLIENT_RESPONSE', '"rpcId"', '"result"'].every((k) => envelopes.includes(k))],
  // 官方契约 §1.4：result 必须是 { ok, value }，不是裸业务对象。
  ['client-response 的 result 包了 { ok, value } 信封', envelopes.includes('put("ok", true)') && envelopes.includes('put("value", value)')],
];
for (const [label, pass] of checks) {
  console.log(`  ${pass ? 'ok' : '!!'} ${label}`);
}

// 信封形状是**结构性**的（不含正则解析），所以可以当硬门禁：
// 只有它失败才让脚本以非零码退出。
const envelopeFailed = checks.some(([, pass]) => !pass);
if (envelopeFailed) {
  console.log('\n信封形状检查失败 —— 这是结构性错误，必须修。');
  process.exit(1);
}
console.log('\n信封形状全部通过。');
console.log('（「待人工复核」项不影响退出码：正则解析不可靠，请人工看上面列出的调用点。）');
process.exit(0);
