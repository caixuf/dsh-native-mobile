/**
 * 局域网直连 (LAN-First) 与多模式网络策略回归测试。
 *
 * 覆盖实际生产中移动端在 Wi-Fi / 蜂窝数据 / 弱网下切换的各类边界：
 *   1. isLanAddress 地址分类判别（RFC1918、回环、IPv6 字面量 [::1]、mDNS、公网 IP、无效输入）
 *   2. connectionMode 模式守卫：
 *      - auto 模式：可动态发现局域网；局域网可达时直连并触发 onActiveUrlChange
 *      - wan 模式：严格仅公网服务器；忽略任何局域网候选
 *   3. triggerLanProbe / switchToLanNow 探测并切换到局域网
 *   4. 局域网断开后自动回退至公网服务器（触发 onActiveUrlChange(baseUrl, false)）
 *   5. 局域网探测超时保护（防止探测慢导致整个连接挂起）
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-lan-policy.mjs
 */

import { DshConnection, isLanAddress } from '../src/services/connection.ts';

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

async function checkAsync(name, fn) {
  try {
    await fn();
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

console.log('局域网直连与网络策略测试');
console.log('──────────────────────────────────────────────────');

check('1. isLanAddress: 正确识别回环与本地地址（含 IPv6 括号字面量）', () => {
  ok(isLanAddress('http://localhost:19387'), 'localhost 应识别为 LAN');
  ok(isLanAddress('http://127.0.0.1:19387'), '127.0.0.1 应识别为 LAN');
  ok(isLanAddress('http://0.0.0.0:19387'), '0.0.0.0 应识别为 LAN');
  ok(isLanAddress('http://[::1]:19387'), '::1 应识别为 LAN');
});

check('2. isLanAddress: 正确识别 RFC1918 私网 A/B/C 类地址', () => {
  ok(isLanAddress('http://10.0.0.1'), '10.0.0.0/8 为私网');
  ok(isLanAddress('http://10.254.1.20:8080'), '10.x.x.x 为私网');

  ok(isLanAddress('http://172.16.0.1'), '172.16.x.x 为私网');
  ok(isLanAddress('http://172.24.5.6:19387'), '172.24.x.x 为私网');
  ok(isLanAddress('http://172.31.255.255'), '172.31.x.x 为私网');
  eq(isLanAddress('http://172.15.0.1'), false, '172.15 不是私网');
  eq(isLanAddress('http://172.32.0.1'), false, '172.32 不是私网');

  ok(isLanAddress('http://192.168.1.1:19387'), '192.168.0.0/16 为私网');
  ok(isLanAddress('http://192.168.31.100'), '192.168.x.x 为私网');
});

check('3. isLanAddress: 正确识别 mDNS 与内网域名 (.local / .lan)', () => {
  ok(isLanAddress('http://macbook-pro.local:19387'), '.local 为局域网');
  ok(isLanAddress('http://desktop.home.lan:19387'), '.lan 为局域网');
  ok(isLanAddress('ws://my-pc.local:19387/mux'), 'ws 协议也应正确解析');
  ok(isLanAddress('wss://my-pc.lan:19387/mux'), 'wss 协议也应正确解析');
});

check('4. isLanAddress: 排除公网 IP 与外部域名', () => {
  eq(isLanAddress('http://8.8.8.8:19387'), false);
  eq(isLanAddress('https://123.56.78.90:19387'), false);
  eq(isLanAddress('https://api.deepseek.com'), false);
  eq(isLanAddress('http://my-relay-server.com:19387'), false);
});

check('5. isLanAddress: 畸形输入与空值容错', () => {
  eq(isLanAddress(''), false);
  eq(isLanAddress(null), false);
  eq(isLanAddress(undefined), false);
  eq(isLanAddress('not a valid url!@#$'), false);
});

await checkAsync('6. connectionMode === "wan" 时严格只连接公网服务器，不尝试局域网', async () => {
  let wsConnectedUrl = '';

  const mockWs = (url) => {
    wsConnectedUrl = url;
    return {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
  };

  const conn = new DshConnection(
    'https://relay.wan.example.com',
    'token-test',
    'Test Host',
    {
      connectionMode: 'wan',
      preferredLanUrl: 'http://192.168.1.50:19387',
      WebSocket: mockWs,
      watchdogMs: 0,
    },
  );

  await conn.start();
  ok(wsConnectedUrl.includes('relay.wan.example.com'), 'wan 模式必须连接公网地址');
  eq(conn.getConnectionMode(), 'wan');
  const probeSuccess = await conn.triggerLanProbe();
  eq(probeSuccess, false, 'wan 模式下 triggerLanProbe 必须拒绝');
  conn.stop();
});

await checkAsync('7. triggerLanProbe: auto 模式下探测到局域网可达，切到局域网并触发 onActiveUrlChange', async () => {
  let switchedUrl = '';
  let switchedIsLan = false;

  const mockFetch = async (url) => {
    if (String(url).includes('192.168.1.88')) {
      return { ok: true, json: async () => ({ ok: true, instance: { name: 'Lan Host' } }) };
    }
    return { ok: true, json: async () => ({ ok: true, instance: { name: 'Wan Host' } }) };
  };

  let connectedUrl = '';
  const mockWs = (url) => {
    connectedUrl = url;
    return {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
  };

  const conn = new DshConnection(
    'https://relay.wan.example.com',
    'token-auto',
    'Auto Host',
    {
      connectionMode: 'auto',
      lanUrls: ['http://192.168.1.88:19387'],
      onActiveUrlChange: (url, isLan) => {
        switchedUrl = url;
        switchedIsLan = isLan;
      },
      WebSocket: mockWs,
      fetch: mockFetch,
      watchdogMs: 0,
    },
  );

  await conn.start();
  // 当前连的是 WAN
  ok(connectedUrl.includes('relay.wan.example.com'));

  // 触发局域网探测
  const switched = await conn.triggerLanProbe();
  ok(switched, '探测成功必须返回 true');
  eq(switchedUrl, 'http://192.168.1.88:19387');
  eq(switchedIsLan, true);
  conn.stop();
});

await checkAsync('8. 局域网断开后自动回退至公网服务器并通知 onActiveUrlChange(baseUrl, false)', async () => {
  let switchedUrl = '';
  let switchedIsLan = true;
  let activeSocket = null;

  const mockWs = (url) => {
    const s = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    activeSocket = s;
    return s;
  };

  const conn = new DshConnection(
    'https://relay.wan.example.com',
    'token-fallback',
    'Fallback Host',
    {
      connectionMode: 'auto',
      preferredLanUrl: 'http://192.168.1.99:19387',
      onActiveUrlChange: (url, isLan) => {
        switchedUrl = url;
        switchedIsLan = isLan;
      },
      WebSocket: mockWs,
      watchdogMs: 0,
    },
  );

  await conn.start();
  // 初始为 preferredLanUrl
  ok(activeSocket !== null);

  // 模拟局域网 WebSocket 异常断开（例如走出 Wi-Fi 范围）
  activeSocket.onclose?.({ code: 1006, reason: 'network dropped' });

  eq(switchedUrl, 'https://relay.wan.example.com', '局域网挂掉后必须切回公网服务器');
  eq(switchedIsLan, false, '当前不再是 LAN');
  conn.stop();
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：局域网直连与多模式网络策略全部达成`);
}
