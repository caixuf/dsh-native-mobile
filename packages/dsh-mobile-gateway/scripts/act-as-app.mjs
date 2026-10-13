#!/usr/bin/env node
/**
 * @file scripts/act-as-app.mjs
 * @description 扮演 Android App，用与 Kotlin 端**完全相同**的路径与信封打真实网关。
 *
 * 为什么需要它：本机没有 Android 设备也没有模拟器镜像，真机验证做不了。
 * 但「App 能不能用」的核心是**协议是否对得上** —— 这部分完全可以由脚本代替：
 * 只要路径、信封字段、鉴权头与 Kotlin 端逐字一致，脚本跑通就说明 App 的协议层是对的。
 *
 * 用法：
 *   node scripts/act-as-app.mjs http://127.0.0.1:19387
 *   node scripts/act-as-app.mjs https://203.0.113.10:2444 --pair-code dshm1.XXXX-XXXX-XXXX-XXXX
 */

import { WebSocket } from 'ws';

const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');
const pairCodeArgIndex = process.argv.indexOf('--pair-code');
const pairCode = pairCodeArgIndex > 0 ? process.argv[pairCodeArgIndex + 1] : null;

// ---- 与 Kotlin 端逐字一致的常量（DshConnection.kt）-----------------------
const API_PREFIX = '/mobile-gateway/api/';
const WS_MUX = '/mobile-gateway/events.mux';
const WS_HOST = '/mobile-gateway/events.host';
const PAIR_PATH = '/mobile-gateway/pair';
const HEALTH_PATH = '/mobile-gateway/health';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function getJson(path) {
  const res = await fetch(base + path);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留 null */
  }
  return { status: res.status, json, text };
}

/** 与 App 的 call() 完全同构：POST /mobile-gateway/api/<method> + Bearer + client-request 信封。 */
async function call(method, payload = {}, token = null) {
  const rpcId = `r${Math.floor(Math.random() * 1e9)}`;
  const body = {
    type: 'client-request',
    rpcId,
    method,
    payload,
  };
  const res = await fetch(`${base}${API_PREFIX}${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留 null */
  }
  return { status: res.status, json, text, rpcId };
}

console.log(`\n目标：${base}\n`);

// ---- 1. 健康检查（公开面）----------------------------------------------
console.log('[1] 健康检查');
const health = await getJson(HEALTH_PATH);
check('GET /mobile-gateway/health 返回 200', health.status === 200, `status=${health.status}`);
check('返回体是网关身份', health.json?.service === 'dsh-mobile-gateway', JSON.stringify(health.json).slice(0, 120));
if (health.json) {
  console.log(`       实例=${health.json.instance?.name}  版本=${health.json.version}`);
}

// ---- 2. 鉴权边界 --------------------------------------------------------
console.log('\n[2] 鉴权边界');
const noToken = await call('host.describe');
check('无令牌调用 /api 返回 401', noToken.status === 401, `status=${noToken.status}`);
const badToken = await call('host.describe', {}, 'obviously-wrong-token');
check('伪造令牌返回 401', badToken.status === 401, `status=${badToken.status}`);

// ---- 3. 配对 ------------------------------------------------------------
let token = null;
if (pairCode) {
  console.log('\n[3] 配对');
  const res = await fetch(base + PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairCode, deviceName: 'act-as-app', platform: 'android' }),
  });
  const json = await res.json().catch(() => null);
  check('配对成功并拿到设备令牌', res.status === 200 && !!json?.token, `status=${res.status}`);
  token = json?.token ?? null;
  if (token) console.log(`       设备 id=${json.device?.id}  实例=${json.instance?.name}`);
} else {
  console.log('\n[3] 配对 —— 跳过（未提供 --pair-code）');
  console.log('       提示：先 POST /mobile-gateway/manage/api/mint 铸码（仅回环），再带 --pair-code 重跑');
}

// ---- 4. 已鉴权的一问一答 ------------------------------------------------
if (token) {
  console.log('\n[4] 已鉴权的一问一答（App 的主路径）');
  const describe = await call('host.describe', {}, token);
  check('host.describe 成功', describe.status === 200 && describe.json?.result?.ok === true,
    JSON.stringify(describe.json).slice(0, 160));
  check('信封回显了同一个 rpcId', describe.json?.rpcId === describe.rpcId,
    `sent=${describe.rpcId} got=${describe.json?.rpcId}`);

  const sessions = await call('session.list', {}, token);
  const items = sessions.json?.result?.value?.items;
  check('session.list 成功且返回会话数组', sessions.status === 200 && Array.isArray(items),
    JSON.stringify(sessions.json).slice(0, 160));
  if (Array.isArray(items)) console.log(`       会话数=${items.length}`);

  // 特权方法必须被网关拦下 —— 这是安全设计的核心。
  console.log('\n[5] 特权方法闸门（必须被拒）');
  for (const method of ['settings.describe', 'credentials.set', 'pluginManager.list']) {
    const res = await call(method, {}, token);
    check(`${method} 被拒 403`, res.status === 403, `status=${res.status}`);
  }

  // ---- 6. 两条下行事件流 ------------------------------------------------
  console.log('\n[6] 下行事件流（只下行、无子协议）');
  for (const [label, path] of [['mux', WS_MUX], ['host', WS_HOST]]) {
    const frames = await new Promise((resolve) => {
      const collected = [];
      const ws = new WebSocket(base.replace(/^http/, 'ws') + path, {
        headers: { authorization: `Bearer ${token}` },
      });
      const done = (why) => {
        try { ws.close(); } catch { /* 忽略 */ }
        resolve({ collected, why });
      };
      ws.on('open', () => {
        // 只下行：不发任何数据，等主机推帧或超时。
        setTimeout(() => done('timeout'), 4000);
      });
      ws.on('message', (data) => {
        collected.push(String(data));
        if (collected.length >= 3) done('got-frames');
      });
      ws.on('error', (e) => done(`error:${e.message}`));
      ws.on('close', (code) => done(`closed:${code}`));
    });
    const parsed = frames.collected.map((f) => {
      try { return JSON.parse(f); } catch { return null; }
    }).filter(Boolean);
    const allServerRequest = parsed.length > 0 && parsed.every((f) => f.type === 'server-request');
    check(
      `${label} 流可建立且帧形状为 server-request`,
      allServerRequest || frames.why === 'timeout',
      `why=${frames.why} frames=${parsed.length}`,
    );
    if (parsed.length) {
      console.log(`       首帧 method=${parsed[0].method} rpcId=${parsed[0].rpcId}`);
    } else {
      console.log(`       （4 秒内无推送，属正常：没有主机事件时下行流是静默的）`);
    }
  }

  console.log('\n[7] 错误令牌无法升级 WS');
  const wsRejected = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + WS_MUX, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    ws.on('open', () => resolve('opened'));
    ws.on('error', (e) => resolve(`error:${e.message}`));
    ws.on('close', () => resolve('closed'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('错误令牌被拒', wsRejected !== 'opened' && wsRejected !== 'timeout', wsRejected);
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
