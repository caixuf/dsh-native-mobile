#!/usr/bin/env node
/**
 * 枚举真实主机**实际认领**的 endpoint 清单。
 *
 * 思路：拿一批候选 endpoint 逐个请求，凡是不返回 `404 not found` 的，就是被认领的。
 * `404 not found` 是 connection 的 endpointFromPath/claimsEndpoint 拒绝时的固定响应，
 * 用它做判据最可靠。
 *
 * 用法：node scripts/list-endpoints.mjs [base]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'probe', platform: 'android' }),
})).json();
const token = pair?.token;
if (!token) {
  console.error('拿不到 token');
  process.exit(1);
}

const namespaces = [
  'session',
  'workspace',
  'host',
  'subagent',
  'subagents',
  'command',
  'commands',
  'skill',
  'skills',
  'goal',
  'goals',
  'agentPreset',
  'agent-preset',
  'credential',
  'credentials',
  'setting',
  'settings',
  'llm',
  'account',
  'job',
  'jobs',
  'terminal',
  'terminals',
  'directoryPicker',
  'fileUploads',
  'speech',
  'speechController',
  'messageFeedback',
  'sessionFeedback',
  'sessionFileReferences',
  'workspaceFiles',
  'workspaceController',
  'sessionController',
];

const methods = [
  'list', 'describe', 'create', 'page', 'prompt', 'cancel', 'search', 'rename', 'fork',
  'models', 'selectModel', 'attachment', 'updateQueue', 'projections', 'follow',
  'history', 'open', 'close', 'stat', 'read', 'readBytes', 'changes', 'pick',
  'listDirectory', 'createDirectory', 'openPath', 'answer', 'catalog', 'record',
];

async function probe(endpoint) {
  try {
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
    // 固定的拒绝响应：HTTP 404 且 body 恰为 "not found"
    if (res.status === 404 && text.trim() === 'not found') return null;
    return text.slice(0, 150);
  } catch {
    return null;
  }
}

console.log('\n枚举真实主机认领的 endpoint（并发探测，可能稍慢）...\n');
const tasks = [];
for (const ns of namespaces) {
  for (const m of methods) tasks.push(`${ns}/${m}`);
}

const found = [];
const CHUNK = 20;
for (let i = 0; i < tasks.length; i += CHUNK) {
  const slice = tasks.slice(i, i + CHUNK);
  const results = await Promise.all(slice.map(async (e) => [e, await probe(e)]));
  for (const [e, r] of results) {
    if (r !== null) found.push([e, r]);
  }
}

console.log(`认领的 endpoint（${found.length} 个）：\n`);
for (const [e, sample] of found.sort()) {
  console.log(`  ✅ ${e}`);
  console.log(`       ${sample.replace(/\s+/g, ' ')}`);
}
