/**
 * DeviceStore 持久化测试。
 *
 * 🔴 覆盖一类特别难查的真实事故：**字段存了但读不回来**。
 *
 * 2026-10-14 重启后实测：管理面板用户名变空、手机端登录报 `no-credentials`，
 * 而**磁盘上的凭据完好无损** —— 文件看起来完全正常，所以从文件查不出问题。
 *
 * 根因：`load()` 里手写对象时只取了 `devices` / `pairing`，漏掉了 `credentials`。
 * persist 写四个字段、load 只读两个，重启即丢。
 *
 * 教训：state 的字段必须 **load 与 persist 成对**。这里用"全字段往返"测试锁死，
 * 以后新增字段只要忘了在 load 里接，就会立刻红。
 *
 * 运行：node packages/dsh-mobile-gateway/test/store-roundtrip.mjs
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../lib/store.mjs';

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? ''}\n  期望: ${e}\n  实际: ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-store-test-'));
  const file = join(dir, 'devices.json');
  const store = new DeviceStore(file, silentLog);
  await store.load();
  try {
    const result = await fn(store, file);
    // 🔴 必须等写盘落定再删临时目录。
    // persist 是链式异步的（部分调用点是 `void this.#persist()`），
    // 不等就会在写到一半时被 rm 掉，报 EPERM rename —— 那是测试的竞态，
    // 不是产品缺陷。flush() 暴露的正是这条写链。
    await store.flush().catch(() => {});
    return result;
  } finally {
    await store.flush().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

console.log('\n  DeviceStore 持久化往返测试');
console.log('  ' + '-'.repeat(52));

// ── 🔴 核心回归：凭据必须能跨 load 存活 ──────────────────────────────────

await check('credentials survive a reload (real regression)', async () => {
  await withStore(async (store, file) => {
    // 首次生成凭据。
    // ⚠️ 测试自身的坑：`ensureCredentials()` 只在**首次**返回明文密码，
    // 已存在时返回 null。连续调两次时第二次拿到 null，
    // 用空密码登录必然失败 —— 那是测试写错，不是产品缺陷。
    const created = store.ensureCredentials();
    ok(created && created.password, '首次调用应生成密码');
    await store.flush();

    // 模拟重启：新建 store 读同一个文件
    const reopened = new DeviceStore(file, silentLog);
    await reopened.load();

    const view = reopened.credentialsView();
    ok(view !== null, '🔴 重启后凭据不能丢（原 bug：load 漏读 credentials）');
    eq(view.username, 'dsh', '用户名应保留');
    eq(view.passwordSet, true, '应标记已设密码');

    // 更关键：能用原密码登录，说明 passwordHash 也真的读回来了
    const login = await reopened.login('dsh', created.password, {
      ttlMs: 60_000,
      deviceName: 'unit-test',
      platform: 'test',
    });
    eq(login.ok, true, '🔴 重启后必须仍能用原密码登录');
  });
});

await check('all state fields round-trip through the file', async () => {
  await withStore(async (store, file) => {
    const cred = store.ensureCredentials();
    await store.login('dsh', cred.password, {
      ttlMs: 60_000,
      deviceName: 'roundtrip',
      platform: 'test',
    });
    await store.flush();

    const before = JSON.parse(await readFile(file, 'utf8'));
    const keysBefore = Object.keys(before).sort();

    // 重新加载再落盘一次，字段集合必须完全一致（不能多也不能少）
    const reopened = new DeviceStore(file, silentLog);
    await reopened.load();
    await reopened.clearDevices(); // 触发一次 persist
    await reopened.flush();

    const after = JSON.parse(await readFile(file, 'utf8'));
    const keysAfter = Object.keys(after).sort();

    eq(keysAfter, keysBefore, '🔴 load→persist 往返后字段集合必须不变（防字段丢失）');
  });
});

// ── 设备去重：同一台设备只留一条 ────────────────────────────────────────

await check('same device reuses its record instead of adding a new one', async () => {
  await withStore(async (store, file) => {
    const cred = store.ensureCredentials();
    const opts = { ttlMs: 600_000, deviceName: 'Pixel 8', platform: 'android' };

    const first = await store.login('dsh', cred.password, opts);
    const second = await store.login('dsh', cred.password, opts);
    const third = await store.login('dsh', cred.password, opts);

    eq(first.ok && second.ok && third.ok, true, '三次登录都应成功');

    const devices = store.list();
    eq(devices.length, 1, '🔴 同一台设备只应有一条记录（原 bug：每次登录都新增）');
    eq(devices[0].id, first.device.id, 'id 应保持不变（是"又连上来了"而非新设备）');

    // token 必须每次都是新的
    ok(first.token !== second.token, '每次签发都应换新 token');
    ok(second.token !== third.token, 'token 应持续轮换');
  });
});

await check('different device names create separate records', async () => {
  await withStore(async (store) => {
    const cred = store.ensureCredentials();
    await store.login('dsh', cred.password, { ttlMs: 600_000, deviceName: 'Phone A', platform: 'android' });
    await store.login('dsh', cred.password, { ttlMs: 600_000, deviceName: 'Phone B', platform: 'android' });
    eq(store.list().length, 2, '不同设备名应是两条');
  });
});

await check('same name on different platforms is a different device', async () => {
  await withStore(async (store) => {
    const cred = store.ensureCredentials();
    await store.login('dsh', cred.password, { ttlMs: 600_000, deviceName: 'X', platform: 'android' });
    await store.login('dsh', cred.password, { ttlMs: 600_000, deviceName: 'X', platform: 'ios' });
    eq(store.list().length, 2, 'platform 不同应视为不同设备');
  });
});

await check('redeem also reuses the same device record', async () => {
  await withStore(async (store) => {
    const opts = { ttlMs: 600_000, deviceName: 'Paired', platform: 'android' };

    const p1 = await store.mintPairing({ ttlMs: 60_000 });
    const r1 = await store.redeem(p1.pin, opts);
    eq(r1.ok, true, '第一次配对码应能换取令牌');

    const p2 = await store.mintPairing({ ttlMs: 60_000 });
    const r2 = await store.redeem(p2.pin, opts);
    eq(r2.ok, true, '第二次配对码应能换取令牌');

    eq(store.list().length, 1, '🔴 同一设备用配对码也应复用记录');
    eq(r1.device.id, r2.device.id, 'id 应保持不变');
  });
});

// ── 清理与去重 ──────────────────────────────────────────────────────────

await check('clearDevices empties records but keeps credentials', async () => {
  await withStore(async (store, file) => {
    const cred = store.ensureCredentials();
    await store.login('dsh', cred.password, { ttlMs: 600_000, deviceName: 'A', platform: 'android' });
    await store.login('dsh', cred.password, { ttlMs: 600_000, deviceName: 'B', platform: 'android' });
    ok(store.list().length === 2, '应有两条');

    const res = await store.clearDevices();
    eq(res.removed, 2, '应报告移除 2 条');
    eq(store.list().length, 0, '设备应清空');

    // 凭据必须还在，否则用户会被锁在门外
    const reopened = new DeviceStore(file, silentLog);
    await reopened.load();
    ok(reopened.credentialsView() !== null, '🔴 清空设备不能连带删掉凭据');
  });
});

await check('dedupeDevices collapses duplicate records keeping the newest', async () => {
  await withStore(async (store, file) => {
    // 直接构造历史遗留：同一设备多条（模拟旧版本行为）
    const raw = {
      version: 3,
      devices: [
        { id: 'old', name: 'Phone', platform: 'android', tokenHash: 'a', createdAt: 1, lastSeenAt: 1000, expiresAt: Date.now() + 99999 },
        { id: 'new', name: 'Phone', platform: 'android', tokenHash: 'b', createdAt: 2, lastSeenAt: 5000, expiresAt: Date.now() + 99999 },
        { id: 'mid', name: 'Phone', platform: 'android', tokenHash: 'c', createdAt: 3, lastSeenAt: 3000, expiresAt: Date.now() + 99999 },
      ],
      pairing: null,
      credentials: { username: 'dsh', passwordHash: 'x', createdAt: 1 },
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(raw), 'utf8');

    const reopened = new DeviceStore(file, silentLog);
    await reopened.load();
    eq(reopened.list().length, 3, 'load 后应看到 3 条历史记录');

    const res = await reopened.dedupeDevices();
    eq(res.before, 3, '应报告去重前 3 条');
    eq(res.after, 1, '同设备应合并为 1 条');

    const left = reopened.list();
    eq(left[0].id, 'new', '🔴 必须保留 lastSeenAt 最新的那条（否则 token 指向失效设备）');
  });
});

// ── 健壮性 ──────────────────────────────────────────────────────────────

await check('missing file starts empty without throwing', async () => {
  await withStore(async (store) => {
    eq(store.list().length, 0, '空 store 应无设备');
    eq(store.credentialsView(), null, '空 store 应无凭据');
  });
});

await check('corrupt file does not throw', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-store-bad-'));
  try {
    const file = join(dir, 'devices.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{ this is not json', 'utf8');
    const store = new DeviceStore(file, silentLog);
    await store.load();
    eq(store.list().length, 0, '损坏文件应降级为空而不是崩溃');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await check('legacy file without credentials field loads cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-store-legacy-'));
  try {
    const file = join(dir, 'devices.json');
    const { writeFile } = await import('node:fs/promises');
    // 旧版本可能没有 credentials 字段
    await writeFile(file, JSON.stringify({ version: 2, devices: [], pairing: null }), 'utf8');
    const store = new DeviceStore(file, silentLog);
    await store.load();
    eq(store.credentialsView(), null, '无凭据字段时应为 null，不得抛异常');
    eq(store.list().length, 0, '设备应为空');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log('  ' + '-'.repeat(52));
for (const f of failures) {
  console.log(`  ✗ ${f.name}`);
  console.log(`    ${f.message.split('\n').join('\n    ')}`);
}
console.log(`  ${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
