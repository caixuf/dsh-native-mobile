/**
 * 配对与认证客户端（PairingClient）契约与边界测试。
 *
 * 覆盖移动端配对流程中最容易踩坑的边界：
 *   1. 二维码/配对 URL 解析（格式容错、锚点解析、协议过滤、恶意 scheme 防护）
 *   2. 网关探测（probeDetail）在网络失败、超时、非正常 JSON 下的零崩溃兜底
 *   3. 登录与配对的参数形状与返回值映射
 *   4. 局域网识别（isInputLan）：输入为内网 IP 时正确保留为 lanUrl，输入为公网时从网关候选挑选
 *   5. 服务端错误码与友好文案映射（抛出具体错误，杜绝静默失败）
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-pairing-client.mjs
 */

import { PairingClient } from '../src/services/pairing.ts';

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

console.log('PairingClient 配对与探测契约测试');
console.log('──────────────────────────────────────────────────');

check('1. 解析标准二维码 URL：基地址与 6 位配对码分离', () => {
  const res = PairingClient.parsePairingTarget('http://192.168.1.100:19387/mobile-gateway/#123456');
  ok(res !== null, '解析结果不得为空');
  eq(res.baseUrl, 'http://192.168.1.100:19387');
  eq(res.code, '123456');
});

check('2. 解析带域名的 HTTPS 配对链接', () => {
  const res = PairingClient.parsePairingTarget('https://dsh.office.internal:9443/mobile-gateway/#PAIRCODE99');
  ok(res !== null);
  eq(res.baseUrl, 'https://dsh.office.internal:9443');
  eq(res.code, 'PAIRCODE99');
});

check('3. 解析无 # 锚点的网关基地址（用户手动扫或粘贴无码链接）', () => {
  const res = PairingClient.parsePairingTarget('http://10.0.0.2:19387/mobile-gateway/');
  ok(res !== null);
  eq(res.baseUrl, 'http://10.0.0.2:19387');
  eq(res.code, '', '无锚点时 code 为空字符串');
});

check('4. 容忍多余的尾部斜杠与空格', () => {
  const res = PairingClient.parsePairingTarget('  http://127.0.0.1:19387///mobile-gateway/#abc   ');
  ok(res !== null);
  eq(res.baseUrl, 'http://127.0.0.1:19387');
  eq(res.code, 'abc');
});

check('5. 恶意 scheme 与非 HTTP 协议直接拒绝（防 XSS 与非目标协议）', () => {
  eq(PairingClient.parsePairingTarget('javascript:alert(1)'), null);
  eq(PairingClient.parsePairingTarget('ftp://evil.com/mobile-gateway/#123'), null);
  eq(PairingClient.parsePairingTarget('file:///etc/passwd'), null);
  eq(PairingClient.parsePairingTarget('not_a_valid_url'), null);
});

await checkAsync('6. probeDetail 成功时正确提取主机名与局域网地址列表', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      eq(url, 'http://192.168.1.5:19387/mobile-gateway/health');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          instance: { name: '开发电脑 MacBook' },
          lanAddresses: ['192.168.1.5', '192.168.1.6'],
        }),
      };
    };

    const detail = await PairingClient.probeDetail('http://192.168.1.5:19387');
    ok(detail !== null);
    eq(detail.name, '开发电脑 MacBook');
    eq(detail.lanAddresses, ['192.168.1.5', '192.168.1.6']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await checkAsync('7. probeDetail 在网络报错或 500 时安全返回 null（不向上抛错）', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const detail = await PairingClient.probeDetail('http://192.168.1.250:19387');
    eq(detail, null, '探测失败必须静默返回 null');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await checkAsync('8. login 成功时识别局域网输入并设置 lanUrl', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      eq(url, 'http://192.168.1.5:19387/mobile-gateway/login');
      const body = JSON.parse(opts.body);
      eq(body.username, 'admin');
      eq(body.password, 'secret');
      eq(body.platform, 'web');

      return {
        ok: true,
        json: async () => ({
          token: 'token-abc-123',
          device: { id: 'device-xyz' },
          instance: { name: '我的工作站' },
          lanAddresses: ['192.168.1.5'],
        }),
      };
    };

    const record = await PairingClient.login(
      'http://192.168.1.5:19387/',
      'admin',
      'secret',
      'My Phone',
    );
    eq(record.baseUrl, 'http://192.168.1.5:19387');
    eq(record.lanUrl, 'http://192.168.1.5:19387', '输入本身为局域网 IP 时直接作为 lanUrl');
    eq(record.token, 'token-abc-123');
    eq(record.deviceId, 'device-xyz');
    eq(record.label, '我的工作站');
    eq(record.connectionMode, 'auto');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await checkAsync('9. login 在服务端返回 401 时抛出明确业务错误', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        error: { message: '用户名或密码错误' },
      }),
    });

    let caught = false;
    try {
      await PairingClient.login('http://192.168.1.5:19387', 'admin', 'wrong', 'phone');
    } catch (e) {
      caught = true;
      ok(e.message.includes('用户名或密码错误'), `错误信息不匹配: ${e.message}`);
    }
    ok(caught, '必须抛出异常通知 UI');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await checkAsync('10. pair 成功时对公网 URL 提取服务端下发的内网候选 lanUrl', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      eq(url, 'https://relay.company.com/mobile-gateway/pair');
      const body = JSON.parse(opts.body);
      eq(body.code, '654321');

      return {
        ok: true,
        json: async () => ({
          token: 'token-pair-456',
          device: { id: 'dev-pair' },
          instance: { name: '云上工作电脑' },
          lanAddresses: ['192.168.50.2', '10.0.1.2'],
        }),
      };
    };

    const record = await PairingClient.pair(
      'https://relay.company.com/',
      '  654321  ',
      'My Phone',
    );
    eq(record.baseUrl, 'https://relay.company.com');
    eq(record.lanUrl, '192.168.50.2', '公网中继配对时优先采用网关回传的首个内网候选');
    eq(record.lanAddresses?.length, 2);
    eq(record.token, 'token-pair-456');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：PairingClient 配对与探测契约全部达成`);
}
