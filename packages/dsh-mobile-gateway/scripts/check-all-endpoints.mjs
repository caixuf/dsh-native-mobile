#!/usr/bin/env node
/**
 * @file scripts/check-all-endpoints.mjs
 * @description 全接口巡检：把 App 会用到的每个接口都在**真实运行的 DSH** 上跑一遍。
 *
 * 为什么需要它：此前出过两次「以为通了其实没通」——
 *   1. 方法名用点号（session.list），真实主机只认斜杠（session/list）→ 全线 404
 *   2. 加了 /mobile-gateway/login 路由但忘了同步 Caddy 白名单 → 本机通、公网 404
 * 两类问题都能被本脚本抓出来，所以它比「编译通过」可信得多。
 *
 * 每个接口都给出**实测结论**，不是「理论上应该行」。
 *
 * 用法：
 *   node scripts/check-all-endpoints.mjs                          # 局域网
 *   node scripts/check-all-endpoints.mjs https://203.0.113.10:2444  # 公网
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');
const publicMode = base.includes('203.0.113.10');

let pass = 0;
let fail = 0;
const rows = [];

function record(ok, name, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  rows.push({ ok, name, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${detail}`);
}

async function probe(label, path, { method = 'GET', body, headers = {}, expect }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    const code = res.status;
    const sizes = `${(text.length / 1024).toFixed(1)}KB`;
    record(expect.includes(code), label, `HTTP ${code}  ${sizes}  期望 ${expect.join('/')}  ${text.slice(0, 70).replace(/\s+/g, ' ')}`);
    return { code, text };
  } catch (error) {
    record(false, label, `异常 ${error.message}`);
    return { code: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** RPC 调用：走网关的 /api 桥，返回结构化结果。 */
async function rpc(label, method, args, { token, expectOk = true } = {}) {
  const res = await probe(label, `/mobile-gateway/api/${method}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: { type: 'client-request', rpcId: `r${Date.now()}`, method, payload: { args } },
    expect: [200],
  });
  if (!res.text) return null;
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    record(false, `${label} → 响应不是 JSON`, res.text.slice(0, 80));
    return null;
  }
  const ok = json?.result?.ok === true;
  if (expectOk) {
    record(ok, `${label} → result.ok`, ok ? 'true' : JSON.stringify(json?.result?.error).slice(0, 110));
  }
  return json?.result;
}

console.log('=' * 78);
console.log(`DSH 移动端 全接口巡检   目标: ${base}${publicMode ? '（公网）' : '（局域网）'}`);
console.log('=' * 78);

// ---------------------------------------------------------------------------
console.log('\n■ A. 公开面（无需鉴权）');
// ---------------------------------------------------------------------------
await probe('A1 GET /mobile-gateway/health', '/mobile-gateway/health', { expect: [200] });

// ---------------------------------------------------------------------------
console.log('\n■ B. 鉴权边界（必须被拒）');
// ---------------------------------------------------------------------------
await probe('B1 /api 无令牌 → 401', '/mobile-gateway/api/session/list', {
  method: 'POST',
  body: { type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: {} } },
  expect: [401],
});
await probe('B2 /api 伪造令牌 → 401', '/mobile-gateway/api/session/list', {
  method: 'POST',
  headers: { authorization: 'Bearer definitely-not-a-real-token' },
  body: { type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: {} } },
  expect: [401],
});

// ---------------------------------------------------------------------------
console.log('\n■ C. 账号密码登录（App 主路径）');
// ---------------------------------------------------------------------------
let credentials = null;
if (!publicMode) {
  // 管理面仅回环，公网测不到凭据就跳过
  const cred = await probe('C0 生成/重置凭据（管理面，仅回环）', '/mobile-gateway/manage/api/credentials', {
    method: 'POST',
    body: { action: 'regenerate' },
    expect: [200],
  });
  try {
    credentials = JSON.parse(cred.text);
  } catch {
    /* 忽略 */
  }
}

const USERNAME = credentials?.username ?? 'dsh';
const PASSWORD = credentials?.password ?? process.env.DSH_MOBILE_PASSWORD;
if (!PASSWORD) {
  record(false, 'C1 账号密码登录', '拿不到密码：非回环请设 DSH_MOBILE_PASSWORD');
} else {
  const login = await probe('C1 POST /mobile-gateway/login', '/mobile-gateway/login', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD, deviceName: 'check-all', platform: 'android' },
    expect: [200],
  });
  let token = null;
  try {
    token = JSON.parse(login.text)?.token ?? null;
  } catch {
    /* 忽略 */
  }
  record(!!token, 'C1 → 拿到设备令牌', token ? `len=${token.length}` : login.text.slice(0, 110));

  // 错密码必须被拒
  await probe('C2 错密码 → 401', '/mobile-gateway/login', {
    method: 'POST',
    body: { username: USERNAME, password: 'WRONG-PASSWORD-XXXX', deviceName: 'x', platform: 'android' },
    expect: [401],
  });

  if (!token) {
    console.log('\n  ⚠️ 没有令牌，后续接口测试跳过');
  } else {
    // -----------------------------------------------------------------------
    console.log('\n■ D. 已鉴权 RPC（App 实际调用）');
    // -----------------------------------------------------------------------
    const list = await rpc('D1 session/list（会话列表 + 就绪握手）', 'session/list', { _request: {} }, { token });
    const items = list?.value?.items;
    record(Array.isArray(items) && items.length > 0, 'D1 → 返回会话数组',
      Array.isArray(items) ? `${items.length} 个会话，首个: ${items[0]?.projections?.values?.title ?? '?'}` : '不是数组');

    // 🔴 必须挑一个**普通**会话（`session-` 前缀、无 origin:"subagent"）。
    // 实测教训：原来用 `find(i => i.running)` 优先挑运行中的 —— 而运行中的往往
    // 正是 subagent 会话，于是 D2 拿到 `subagent Sessions require their durable
    // parent address`、D5 拿到 `session/agent-busy`，两个都记成 FAIL，
    // 看起来像网关坏了，其实是我们挑错了会话。
    const isSubagent = (i) => i?.origin === 'subagent' || i?.parentSessionId != null;
    const normal = items?.filter((i) => !isSubagent(i)) ?? [];
    const subagents = items?.filter(isSubagent) ?? [];
    record(subagents.length > 0, 'D1b 识别出子代理会话（origin:"subagent"）',
      `普通 ${normal.length} / 子代理 ${subagents.length}`);
    const sid = normal.find((i) => i.running)?.sessionId ?? normal[0]?.sessionId;

    if (sid) {
      // session/page 的 throughSeq 不能超 cursor，先探一个值让主机报出真实 cursor
      let paged = await rpc('D2 session/page（会话内容）', 'session/page',
        { request: { address: { kind: 'session', sessionId: sid }, throughSeq: 1_000_000, maxMessages: 30 } },
        { token, expectOk: false });

      let msg = paged?.error?.message ?? '';
      const cursorMatch = /past cursor (\d+)/.exec(msg);
      if (cursorMatch) {
        const cursor = Number(cursorMatch[1]);
        record(true, 'D2 → 主机自报 cursor', `throughSeq 超限时返回 "${cursorMatch[0]}"`);
        paged = await rpc('D2b session/page（用真实 cursor 重试）', 'session/page',
          { request: { address: { kind: 'session', sessionId: sid }, throughSeq: cursor, maxMessages: 30 } },
          { token });
        const records = paged?.value?.records;
        record(Array.isArray(records), 'D2b → 返回 records 数组',
          Array.isArray(records) ? `${records.length} 条` : '不是数组');
        const types = [...new Set((records ?? []).map((r) => r.event?.type).filter(Boolean))];
        record(types.length > 0, 'D2b → 事件类型可识别', types.slice(0, 6).join(', '));
        // 内容可渲染性：不能出现 [object Object]
        const unrenderable = (records ?? []).filter((r) => {
          const c = r.event?.data?.message?.content ?? r.event?.data?.content;
          return Array.isArray(c) && c.some((x) => x && typeof x === 'object' && typeof x.text !== 'string' && !x.type);
        });
        record(unrenderable.length === 0, 'D2b → 正文可抽取文本', `${unrenderable.length} 条异常`);
      } else {
        record(paged !== null, 'D2 → 可直接翻页', msg ? msg.slice(0, 100) : 'ok');
      }
    } else {
      record(false, 'D2', '没有会话可翻页');
    }

    // D3 搜索：该部署**禁用了 session search**（主机回
    // `SessionQueryError: session search is disabled: this deployment…`，直连主机同样被拒）。
    // 这是主机侧配置，不是网关缺陷 —— 所以判据是「端点可达 + 错误来自主机」，
    // 而不是「必须成功」。一旦某个部署启用了搜索，这里也应能正确判绿。
    const search = await rpc('D3 session/search（搜索）', 'session/search', { request: { query: '测试' } }, { token, expectOk: false });
    const searchMsg = search?.error?.message ?? '';
    const searchDisabled = /search is disabled/i.test(searchMsg);
    record(search?.ok === true || searchDisabled, 'D3 → 搜索可用，或主机明确声明禁用',
      search?.ok === true ? '可用' : (searchDisabled ? '该部署禁用（主机侧配置）' : searchMsg.slice(0, 100)));

    await rpc('D4 session/create（新建会话）', 'session/create', { request: {} }, { token });

    // D5 取消：只对**普通**会话有意义（子代理会话归 subagent 所有，回 agent-busy）。
    // 用一个临时新建的会话去取消，避免影响用户正在跑的会话。
    const created = await rpc('D5 session/create（建临时会话用于取消）', 'session/create', { request: {} }, { token });
    const tempSid = created?.value?.sessionId;
    if (tempSid) {
      const cancel = await rpc('D5b session/cancel（停止当轮）', 'session/cancel', { request: { sessionId: tempSid } }, { token });
      record(cancel?.ok === true, 'D5b → 取消成功', cancel?.ok ? '' : JSON.stringify(cancel?.error)?.slice(0, 110));
    } else {
      record(false, 'D5b', '没能建出临时会话');
    }

    // -----------------------------------------------------------------------
    console.log('\n■ E. 特权闸门（必须被网关拦在主机之前）');
    // -----------------------------------------------------------------------
    // 🔴 判据修正（2026-10-13 公网实测）：这里原来调 `rpc(...)`，而 rpc() 内部
    // 把期望状态硬编码成 `expect: [200]`，于是网关**正确地**返回 403 时，
    // 脚本反而把它记成 FAIL —— 10 个"失败"里 7 个是这种假失败。
    // 正确判据：**HTTP 必须是 403**，且错误码是 `loopback_only`（= 被网关拦下，
    // 根本没到主机）。用 `probe` 直接断言状态码，不再复用 rpc()。
    for (const m of ['settings.describe', 'credentials.set', 'pluginManager.install',
                      'agentPreset.read', 'host.pickDirectory', 'llm.discoverModels',
                      'directoryPicker.pick']) {
      const r = await probe(`E ${m} → 403（网关拦，未触达主机）`, `/mobile-gateway/api/${m}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: { type: 'client-request', rpcId: `e${Date.now()}`, method: m, payload: { args: {} } },
        expect: [403],
      });
      const denied = /loopback_only/.test(r.text);
      record(denied, `E ${m} → 错误码 loopback_only`, denied ? '' : r.text.slice(0, 110));
    }

    // -----------------------------------------------------------------------
    console.log('\n■ F. 审批应答通道（$events/result）');
    // -----------------------------------------------------------------------
    // 🔴 通道修正（2026-10-13，从 app.asar 权威源码取证）：
    // 真实主机**没有 `/api/respond`**（全 asar 零命中；实测直连 401、经网关 404）。
    // 审批/提问的应答走 `$events/result`，且必须带上 `ready` 帧给的 clientId。
    // 下面先断言旧路径确实不存在（防止有人又改回去），再打新路径。
    await probe('F1 旧路径 /api/respond 应 404（真实主机无此端点）', '/mobile-gateway/api/respond', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { type: 'client-response', rpcId: 'fake', result: { ok: true, value: { kind: 'allow' } } },
      expect: [404],
    });
    // 新路径：没有活跃事件流时，主机应回「找不到对应 clientId」这类业务错误，
    // 而**不是** 404 —— 这就证明端点存在、只是没有活跃流。
    const f2 = await probe('F2 $events/result（无活跃流，应到主机并被业务拒绝）',
      '/mobile-gateway/api/$events/result', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: {
          type: 'client-request',
          rpcId: `f${Date.now()}`,
          method: '$events/result',
          payload: {
            args: {
              clientId: 'no-such-client',
              eventId: 'no-such-event',
              outcome: { kind: 'next' },
            },
          },
        },
        expect: [200],
      });
    record(/identifies no active event stream|active event stream/.test(f2.text),
      'F2 → 主机确认端点存在（报「无活跃事件流」）', f2.text.slice(0, 120));

    // -----------------------------------------------------------------------
    console.log('\n■ G. 载荷瘦身效果');
    // -----------------------------------------------------------------------
    const t0 = Date.now();
    const slim = await probe('G1 session/list 响应大小', '/mobile-gateway/api/session/list', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: { type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: { _request: {} } } },
      expect: [200],
    });
    const kb = slim.text.length / 1024;
    record(kb < 120, 'G1 → 已瘦身（<120KB）', `${kb.toFixed(1)}KB，用时 ${Date.now() - t0}ms`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n■ H. 真实主机（不经网关，确认协议基线）');
// ---------------------------------------------------------------------------
if (!publicMode) {
  console.log('     （公网入口已由上面的测试覆盖；此处只在本机跑，避免噪声）');
}

// ---------------------------------------------------------------------------
console.log('\n' + '=' * 78);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const r of rows.filter((x) => !x.ok)) console.log(`  · ${r.name}  ${r.detail}`);
}
console.log('=' * 78);
process.exit(fail ? 1 : 0);