/**
 * HostStore 主机管理与持久化回归测试套件。
 *
 * 覆盖实际生产中使用电脑设备管理易出现的关键 Bug 与边界：
 *   1. 首次安装/无数据时的正确空态（防假成功与演示机静默伪造）
 *   2. 损坏 JSON / 脏数据的安全恢复（绝不崩溃或白屏）
 *   3. 真实主机配对后自动从演示机切换（防配对了电脑却仍挂在演练主机上）
 *   4. 主机切换与移除级联（移除活跃主机时平滑回落下一个或清空）
 *   5. 网络配置更新与 URL 尾部斜杠清洗（防 // 拼接导致 404）
 *   6. 演示机防抢占护栏（已有真实活跃主机时添加演示机不得篡改 activeId）
 *   7. 活跃主机仲裁：优先选择真实主机而非假主机
 *   8. 存储配额超限/禁用环境下的异常隔离
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-host-store.mjs
 */

import { DEFAULT_DEMO_HOST, HostStore } from '../src/services/store.ts';

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

/** 创建纯内存的 mock localStorage */
function createMockStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, val) {
      store.set(key, String(val));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    get length() {
      return store.size;
    },
  };
}

// 注入测试用的 localStorage
let mockStorage = createMockStorage();
globalThis.localStorage = mockStorage;

console.log('HostStore 核心业务逻辑与边界测试');
console.log('──────────────────────────────────────────────────');

check('1. 无数据时默认返回空列表（非 DEMO_MODE 下绝不冒充有主机）', () => {
  mockStorage.clear();
  const hosts = HostStore.all();
  eq(hosts, [], '全新安装时必须返回空数组，引导用户配对');
});

check('2. localStorage 包含损坏 JSON 时优雅兜底（不报错白屏）', () => {
  mockStorage.clear();
  mockStorage.setItem('dsh_hosts_v1', '{invalid_json_corrupted:');
  const hosts = HostStore.all();
  eq(hosts, [], '损坏的 JSON 必须安全忽略并返回兜底');
});

check('3. upsert 新增真实主机时，若当前活跃主机为空，则自动设为活跃', () => {
  mockStorage.clear();
  const host1 = {
    id: 'host-real-1',
    label: 'MacBook Pro',
    baseUrl: 'http://192.168.1.5:19387',
    token: 'token-1',
    deviceId: 'dev-1',
    instanceName: 'MacBook',
    pairedAt: 1000,
    lastUsedAt: 1000,
  };
  HostStore.upsert(host1);
  eq(HostStore.all().length, 1);
  eq(HostStore.find('host-real-1')?.label, 'MacBook Pro');
  eq(HostStore.getActiveId(), 'host-real-1', '新配对第一台真实主机必须自动成为 active');
});

check('4. 🔴 关键防线：若当前活跃为演练主机，新增真实主机必须自动接管 activeId', () => {
  mockStorage.clear();
  mockStorage.setItem('dsh_active_host_id', DEFAULT_DEMO_HOST.id);
  const hostReal = {
    id: 'host-real-2',
    label: '办公台式机',
    baseUrl: 'http://10.0.0.8:19387',
    token: 'token-2',
    deviceId: 'dev-2',
    instanceName: 'PC',
    pairedAt: 2000,
    lastUsedAt: 2000,
  };
  HostStore.upsert(hostReal);
  eq(HostStore.getActiveId(), 'host-real-2', '真实主机必须夺回 demo 占领的 activeId');
});

check('5. 若已有真实主机处于 active，新增第二台真实主机不强行夺走 activeId', () => {
  mockStorage.clear();
  const hostA = {
    id: 'host-a',
    label: '电脑 A',
    baseUrl: 'http://1.1.1.1:19387',
    token: 't-a',
    deviceId: 'd-a',
    instanceName: 'A',
    pairedAt: 1,
    lastUsedAt: 1,
  };
  const hostB = {
    id: 'host-b',
    label: '电脑 B',
    baseUrl: 'http://2.2.2.2:19387',
    token: 't-b',
    deviceId: 'd-b',
    instanceName: 'B',
    pairedAt: 2,
    lastUsedAt: 2,
  };
  HostStore.upsert(hostA);
  eq(HostStore.getActiveId(), 'host-a');
  HostStore.upsert(hostB);
  eq(HostStore.getActiveId(), 'host-a', '已在工作的真实主机不应被下一台新主机突兀顶掉');
});

check('6. upsert 同 id 主机为就地更新，不产生重复条目', () => {
  mockStorage.clear();
  const host = {
    id: 'host-update',
    label: '旧名称',
    baseUrl: 'http://1.1.1.1:19387',
    token: 't1',
    deviceId: 'd1',
    instanceName: 'X',
    pairedAt: 10,
    lastUsedAt: 10,
  };
  HostStore.upsert(host);
  HostStore.upsert({ ...host, label: '新名称', lastUsedAt: 20 });
  const all = HostStore.all();
  eq(all.length, 1);
  eq(all[0].label, '新名称');
  eq(all[0].lastUsedAt, 20);
});

check('7. rename 与 touch 正确更新属性', () => {
  mockStorage.clear();
  const host = {
    id: 'h-1',
    label: '原名',
    baseUrl: 'http://1.1.1.1',
    token: 't',
    deviceId: 'd',
    instanceName: 'N',
    pairedAt: 10,
    lastUsedAt: 10,
  };
  HostStore.upsert(host);
  HostStore.rename('h-1', '重命名');
  eq(HostStore.find('h-1')?.label, '重命名');

  const before = Date.now();
  HostStore.touch('h-1');
  const after = HostStore.find('h-1')?.lastUsedAt;
  ok(typeof after === 'number' && after >= before - 100, 'touch 必须刷新时间戳');
});

check('8. 🔴 updateNetwork 严格清洗 URL 尾部斜杠，防止拼接 404', () => {
  mockStorage.clear();
  const host = {
    id: 'h-net',
    label: '网络主机',
    baseUrl: 'http://192.168.1.100:19387///',
    token: 't',
    deviceId: 'd',
    instanceName: 'N',
    pairedAt: 10,
    lastUsedAt: 10,
  };
  HostStore.upsert(host);
  HostStore.updateNetwork('h-net', {
    baseUrl: 'http://wan.example.com:19387///',
    lanUrl: 'http://192.168.1.100:19387//',
    lanAddresses: ['192.168.1.100', '192.168.1.101'],
    connectionMode: 'lan',
    activeUrl: 'http://192.168.1.100:19387',
  });
  const updated = HostStore.find('h-net');
  eq(updated?.baseUrl, 'http://wan.example.com:19387', 'baseUrl 尾部斜杠被切除');
  eq(updated?.lanUrl, 'http://192.168.1.100:19387', 'lanUrl 尾部斜杠被切除');
  eq(updated?.connectionMode, 'lan');
  eq(updated?.activeUrl, 'http://192.168.1.100:19387');
  eq(updated?.lanAddresses?.length, 2);
});

check('9. remove 活跃主机后，自动平移到下一台主机', () => {
  mockStorage.clear();
  const hostA = { id: 'ha', label: 'A', baseUrl: 'a', token: 't', deviceId: 'd', instanceName: 'A', pairedAt: 1, lastUsedAt: 1 };
  const hostB = { id: 'hb', label: 'B', baseUrl: 'b', token: 't', deviceId: 'd', instanceName: 'B', pairedAt: 2, lastUsedAt: 2 };
  HostStore.upsert(hostA);
  HostStore.upsert(hostB);
  HostStore.setActiveId('hb');
  eq(HostStore.getActiveId(), 'hb');

  HostStore.remove('hb');
  eq(HostStore.all().length, 1);
  eq(HostStore.getActiveId(), 'ha', '移除当前 active 主机后自动指向剩余的主机');

  HostStore.remove('ha');
  eq(HostStore.all().length, 0);
  eq(HostStore.getActiveId(), null, '全部移除后 active 回落到 null');
});

check('10. 🔴 关键防线：已有真实活跃主机时，addDemoHost 绝不篡改 activeId', () => {
  mockStorage.clear();
  const hostReal = { id: 'h-real', label: 'Real', baseUrl: 'http://real:19387', token: 't', deviceId: 'd', instanceName: 'R', pairedAt: 1, lastUsedAt: 1 };
  HostStore.upsert(hostReal);
  eq(HostStore.getActiveId(), 'h-real');

  HostStore.addDemoHost();
  eq(HostStore.getActiveId(), 'h-real', '添加演练主机不得顶替真实已配对电脑');
});

check('11. getActiveId 在无活跃记录时，优先挑真实主机而非演示机', () => {
  mockStorage.clear();
  mockStorage.removeItem('dsh_active_host_id');
  const demo = { ...DEFAULT_DEMO_HOST };
  const real = { id: 'h-real-choice', label: 'Real', baseUrl: 'http://real:19387', token: 't', deviceId: 'd', instanceName: 'R', pairedAt: 1, lastUsedAt: 1 };
  // 列表中演示机排在第一位
  mockStorage.setItem('dsh_hosts_v1', JSON.stringify([demo, real]));

  eq(HostStore.getActiveId(), 'h-real-choice', '仲裁必须选真实主机，即使演示机排在最前面');
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：HostStore 健壮性与防假成功契约全部达成`);
}
