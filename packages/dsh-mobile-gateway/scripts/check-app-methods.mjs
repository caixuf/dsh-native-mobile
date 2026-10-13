#!/usr/bin/env node
/**
 * @file scripts/check-app-methods.mjs
 * @description 门禁：校验 **App 调用的每个 RPC 方法，在真实主机上确实存在**。
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-10-13 的真实事故：App 调用 `session.history` 读会话，而真实主机**没有这个方法**。
 * 这个错误：
 *   - 网关的 50 项 E2E 断言**全部通过** —— 那些测试测的是网关，不读 Kotlin 源码
 *   - 契约文档也没发现 —— 文档挖自**客户端 bundle**，与主机不同步
 *   - 直到真机联调才暴露
 *
 * 更严重的是**同一批错误还有三处**，都是后来才发现的：
 *   1. endpoint 要用**斜杠**（`session/list`），不是点号（`session.list`）
 *   2. payload 必须包成 `{ args: { … } }`，不是裸对象
 *   3. args 的键名是**服务端形参名**（`_request` / `request`），不是业务字段名
 *
 * ## 取证方式：直接问运行中的主机（最权威）
 *
 * 早期版本从 app.asar 静态扫描字符串，结果**漏掉了「斜杠 vs 点号」这个致命差异** ——
 * 静态扫描只能证明「这个名字出现过」，证明不了「这个 endpoint 被认领」。
 *
 * 现在改为向运行中的主机发**真实探测请求**：主机对未认领的 endpoint 固定回
 * `404 not found`，对认领的则回业务错误或成功。这是唯一可靠的判据。
 *
 * 若主机不可达，脚本**明确报无法验证并非零退出**，不静默跳过 ——
 * 静默跳过等于这道门禁不存在。
 *
 * 用法：
 *   node scripts/check-app-methods.mjs [baseUrl]
 *   node scripts/check-app-methods.mjs http://127.0.0.1:19387
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const appSrc = join(repo, 'apps', 'android', 'app', 'src', 'main', 'java', 'io', 'github', 'dshmobile', 'app');
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

// ---- 1. 收集 App 实际调用的方法（点号形式）--------------------------------
function collectKotlinFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectKotlinFiles(full));
    else if (entry.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

const appMethods = new Map();
for (const file of collectKotlinFiles(appSrc)) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(repo.length + 1).replace(/\\/g, '/');
  text.split('\n').forEach((lineText, i) => {
    for (const m of lineText.matchAll(/\.call\(\s*"([a-z][a-zA-Z]*\.[a-zA-Z][\w.]*)"/g)) {
      const list = appMethods.get(m[1]) ?? [];
      list.push(`${rel}:${i + 1}`);
      appMethods.set(m[1], list);
    }
  });
}

if (appMethods.size === 0) {
  console.error('没从 App 源码里抽出任何 RPC 调用 —— 解析逻辑可能失效了。');
  process.exit(2);
}

console.log(`\nApp 调用的 RPC 方法（${appMethods.size} 个，点号形式）：`);
for (const [method, sites] of [...appMethods].sort()) {
  console.log(`  ${method.padEnd(20)} ${sites.length} 处  ${sites[0]}`);
}

// ---- 2. 向真实主机确认可达性 ----------------------------------------------
/** 与 Kotlin 端 Envelopes.toEndpoint 一致。 */
function toEndpoint(dotted) {
  const i = dotted.indexOf('.');
  return i < 0 ? dotted : `${dotted.slice(0, i)}/${dotted.slice(i + 1)}`;
}

// 先配对拿 token（管理面仅回环，本脚本默认打本机）。
let token = null;
try {
  const mintRes = await fetch(`${base}/mobile-gateway/manage/api/mint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!mintRes.ok) throw new Error(`mint HTTP ${mintRes.status}`);
  const mint = await mintRes.json();
  const code = mint?.pairing?.display;
  const pairRes = await fetch(`${base}/mobile-gateway/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'check-app-methods', platform: 'android' }),
  });
  token = (await pairRes.json())?.token ?? null;
} catch (error) {
  console.error(`\n🔴 无法验证：连不上网关或拿不到设备令牌（${base}）`);
  console.error(`   ${String(error.message ?? error)}`);
  console.error('   这道门禁需要一台**运行中的**主机来问「这个 endpoint 认不认」。');
  console.error('   刻意不「跳过并成功退出」—— 静默跳过等于门禁不存在。');
  process.exit(2);
}

if (!token) {
  console.error('\n🔴 无法验证：配对未返回令牌。');
  process.exit(2);
}

/** 主机的固定拒绝响应：HTTP 404 且 body 恰为 "not found"。 */
async function isClaimed(endpoint) {
  const res = await fetch(`${base}/mobile-gateway/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: endpoint,
      payload: { args: {} },
    }),
  });
  const text = await res.text();
  if (res.status === 404 && text.trim() === 'not found') return false;
  if (res.status === 403) return 'denied'; // 被网关特权闸门拦住 —— 也算「存在但不可达」
  return true;
}

// ---- 3. 逐个确认 ----------------------------------------------------------
const missing = [];
const found = [];
const denied = [];
for (const method of [...appMethods.keys()].sort()) {
  const endpoint = toEndpoint(method);
  const claimed = await isClaimed(endpoint);
  if (claimed === true) found.push({ method, endpoint });
  else if (claimed === 'denied') denied.push({ method, endpoint });
  else missing.push({ method, endpoint });
}

console.log('\n比对结果（判据：向运行中的主机发真实探测请求）：');
for (const { method, endpoint } of found) {
  console.log(`  ok   ${method.padEnd(20)} → ${endpoint}`);
}
for (const { method, endpoint } of denied) {
  console.log(`  ⛔   ${method.padEnd(20)} → ${endpoint}  （被网关特权闸门拦下，App 不应调用）`);
}
for (const { method, endpoint } of missing) {
  console.log(`  🔴   ${method.padEnd(20)} → ${endpoint}  —— 真实主机不认领`);
  for (const site of appMethods.get(method)) console.log(`         ${site}`);
}

if (denied.length > 0) {
  console.log(`\n🔴 有 ${denied.length} 个方法是特权方法，App 调用它们只会拿到 403。`);
  console.log('这些命名空间（settings / credentials / pluginManager / agentPreset / directoryPicker）');
  console.log('被网关刻意钉在本机回环，App 不应依赖它们。');
}

if (missing.length > 0) {
  console.log(`\n发现 ${missing.length} 个 endpoint 在真实主机上不存在。`);
  console.log('这类错误会让对应功能 100% 失败，且网关测试查不出来。');
  console.log('修法：用 scripts/list-endpoints.mjs 枚举主机真正认领的 endpoint。');
}

// denied 与 missing 都算失败：前者是设计上不可用（App 依赖它必然坏），
// 后者是根本不存在。只有「全部被认领且无特权依赖」才算通过。
if (missing.length > 0 || denied.length > 0) {
  process.exit(1);
}

console.log('\nApp 调用的全部 endpoint 都被真实主机认领，且没有依赖特权方法。');
process.exit(0);
