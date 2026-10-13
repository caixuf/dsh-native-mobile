#!/usr/bin/env node
/**
 * 用**原始 socket** 向真实 DSH 发未归一化的请求路径，验证特权闸门是否被绕过。
 *
 * 为什么必须用原始 socket：Node 的 http server 会在收到请求前就归一化 req.url
 * （实测 `/a/./b` → `/a/b`、`/a/%2e/b` → `/a/b`），所以用 fetch/curl 测不出
 * 「路径归一化差异」这类漏洞 —— 客户端与服务端两侧都会折叠，漏洞被掩盖。
 * 只有手写请求行才能看到「闸门拿到的字符串」与「上游执行的端点」是否一致。
 *
 * 用法：node scripts/verify-gate-raw.mjs [port]
 */
import net from 'node:net';

const port = Number(process.argv[2] ?? 19387);
const base = `http://127.0.0.1:${port}`;

// 先拿一个有效 token
const mint = await (await fetch(`${base}/mobile-gateway/manage/api/mint`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const pair = await (await fetch(`${base}/mobile-gateway/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: mint?.pairing?.display, deviceName: 'raw-probe', platform: 'android' }),
})).json();
const token = pair?.token;
if (!token) {
  console.error('拿不到 token');
  process.exit(2);
}

/** 手写请求行，不做任何客户端归一化。 */
function rawRequest(path) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: 'r1',
        method: 'x',
        payload: { args: {} },
      });
      sock.write(
        `POST ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Authorization: Bearer ${token}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n` +
          body,
      );
    });
    let data = '';
    sock.on('data', (d) => {
      data += d.toString();
    });
    sock.on('end', () => resolve(data));
    sock.on('error', (e) => resolve(`ERR ${e.message}`));
  });
}

const paths = [
  ['基准（应被拦）', '/mobile-gateway/api/settings.describe'],
  ['./ 绕过', '/mobile-gateway/api/./settings.describe'],
  ['x/../ 绕过', '/mobile-gateway/api/x/../settings.describe'],
  ['%2e 编码绕过', '/mobile-gateway/api/%2e/settings.describe'],
  ['%252e 双重编码', '/mobile-gateway/api/%252e/settings.describe'],
  ['// 双斜杠', '/mobile-gateway/api//settings.describe'],
  ['大小写', '/mobile-gateway/api/SETTINGS/DESCRIBE'],
  ['credentials ./', '/mobile-gateway/api/./credentials.set'],
  ['正常方法（应放行）', '/mobile-gateway/api/session/list'],
];

console.log('\n原始 socket 绕过探测（403 = 闸门拦下；404 not found = 宿主拒绝）：\n');
let bypassed = 0;
for (const [label, path] of paths) {
  const resp = await rawRequest(path);
  const statusLine = resp.split('\r\n')[0] ?? '';
  const bodyStart = resp.indexOf('\r\n\r\n') + 4;
  const body = resp.slice(bodyStart, bodyStart + 130).replace(/\s+/g, ' ');

  // 三种结局都算「没被绕过」：
  //   403 + loopback_only → 我们的闸门拦下（最理想）
  //   404 + not found     → 宿主在路由匹配前拒绝（同样安全，但不是我们的功劳）
  //   200                 → 请求到达主机（只有非特权方法才允许）
  const blockedByGate = /403/.test(statusLine) && /loopback_only/.test(body);
  const blockedByHost = /404/.test(statusLine) && /not found/.test(body);
  const reachedHost = /200/.test(statusLine);
  const isNormalMethod = label.includes('应放行');

  let mark;
  if (blockedByGate) mark = '✅ 闸门拦住';
  else if (blockedByHost) mark = '✅ 宿主拦住';
  else if (reachedHost && isNormalMethod) mark = '✅ 正常放行';
  else {
    mark = '🔴 绕过!';
    bypassed += 1;
  }

  console.log(`  ${mark} ${label.padEnd(20)} ${statusLine}`);
  console.log(`         ${body.slice(0, 110)}`);
}

console.log('');
if (bypassed === 0) {
  console.log('未发现绕过。');
  console.log('注意区分两种拦截：');
  console.log('  「闸门拦住」= 我们的 isDenied 生效（首选，语义明确）');
  console.log('  「宿主拦住」= DSH 在路由匹配前就拒绝（安全，但不依赖它 —— ');
  console.log('                换一个归一化行为不同的宿主版本就可能穿透）');
} else {
  console.log(`发现 ${bypassed} 处绕过`);
}
process.exit(bypassed === 0 ? 0 : 1);
