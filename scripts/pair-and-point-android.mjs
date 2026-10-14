#!/usr/bin/env node
/**
 * 把 Android 设备/模拟器**直接指向真主机上的网关**，走一次真配对。
 *
 * ## 为什么需要它
 *
 * 端到端验证有两种做法，缺一不可：
 *
 * 1. **假主机**（`packages/dsh-mobile-gateway/scripts/fake-host.mjs`）——
 *    解决「真主机不会因为我想测就发一条审批出来」这个问题，让**触发可控**；
 * 2. **真主机**（本脚本）—— 证明「真网关接受这个中继的连接与鉴权方式」。
 *    假主机是自写的，它接受什么**不能代表真网关接受什么**。尤其：
 *    原生中继把令牌放在 `Authorization` 头里（不是 `?token=`），
 *    这条路径只有真网关才能证明。
 *
 * ## 它做什么
 *
 * 1. 用**回环专属**的管理接口铸一枚配对码；
 * 2. 用真配对接口 `POST /mobile-gateway/pair` 换长期设备令牌；
 * 3. `adb reverse` 把设备端口指回本机网关；
 * 4. 用 `am start` 的 extra（**debug 构建专属**）把主机地址 + 令牌交给 App，
 *    由原生中继服务连上真网关。
 *
 * ⚠️ 令牌**不会打印到终端**，只写进设备上的私有 SharedPreferences。
 *    这正是这个脚本存在的原因之一 —— 30 天完全控制凭据不该出现在 shell 历史里。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/pair-and-point-android.mjs                    # 默认本机 19387
 * node scripts/pair-and-point-android.mjs --base https://xxx:2444
 * node scripts/pair-and-point-android.mjs --revoke-device <deviceId>   # 用完吊销
 * ```
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_ADB = 'C:\\Users\\20247\\Downloads\\android-toolchain\\android-sdk\\platform-tools\\adb.exe';
const APP_ID = 'io.github.dshmobile.app';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = (arg('base', 'http://127.0.0.1:19387')).replace(/\/+$/, '');
const deviceName = arg('device', 'Android 模拟器 (dsh_test)');
const adb = arg('adb', DEFAULT_ADB);

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留 null */
  }
  return { status: res.status, json, text };
}

// ── 吊销模式：验证完就把这枚令牌收掉，不留 30 天的完全控制凭据 ──────────────
const revokeId = arg('revoke-device');
if (revokeId) {
  const res = await postJson(`${base}/mobile-gateway/manage/api/revoke`, { deviceId: revokeId });
  console.log(res.status === 200 ? `✓ 已吊销设备 ${revokeId}` : `✗ 吊销失败：HTTP ${res.status} ${res.text.slice(0, 200)}`);
  process.exit(res.status === 200 ? 0 : 1);
}

// ── 1. 铸码（仅回环可用）────────────────────────────────────────────────────
console.log('🔑 1. 铸一枚配对码…');
const mint = await postJson(`${base}/mobile-gateway/manage/api/mint`);
if (mint.status !== 200 || !mint.json?.pairing?.display) {
  console.error(`✗ 铸码失败：HTTP ${mint.status} ${mint.text.slice(0, 300)}`);
  console.error('  管理接口只应答回环来源；确认 base 指向本机，且 DSH 正在运行。');
  process.exit(2);
}
const code = mint.json.pairing.display;
console.log(`   ✓ 配对码有效期至 ${new Date(mint.json.pairing.expiresAt).toLocaleString()}`);

// ── 2. 真配对 ───────────────────────────────────────────────────────────────
console.log('📱 2. 用配对码换设备令牌…');
const pair = await postJson(`${base}/mobile-gateway/pair`, {
  code,
  deviceName,
  platform: 'android',
});
if (pair.status !== 200 || !pair.json?.token) {
  console.error(`✗ 配对失败：HTTP ${pair.status} ${pair.text.slice(0, 300)}`);
  process.exit(3);
}
const token = pair.json.token;
const deviceId = pair.json.device?.id;
console.log(`   ✓ 设备已配对 id=${deviceId} name=${pair.json.device?.name}（令牌不打印）`);

// ── 3. adb reverse + 启动 App ───────────────────────────────────────────────
const port = new URL(base).port || (base.startsWith('https') ? '443' : '80');

/**
 * 包一层：**绝不让原始命令行出现在错误里**。
 *
 * `adb shell` 会经由设备上的 sh 解析，`--es dsh_relay_label "Android 模拟器 (dsh_test)"`
 * 里的空格与括号会直接炸成 `syntax error: unexpected '('`；而 execFileSync 的异常
 * 消息会**回显整条命令**，把 30 天令牌打到终端和日志里。
 * 所以：label 只传 ASCII 安全字符，错误一律只报退出码。
 */
const run = (args) => {
  try {
    return execFileSync(adb, args, { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`adb 退出码 ${err.status ?? '未知'}（命令内容不打印：可能包含设备令牌）`);
  }
};

/** adb shell 的安全 label：空格/括号/中文都会被设备端 sh 解析坏。 */
const safeLabel = deviceName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'android-device';

console.log(`🔌 3. adb reverse tcp:${port} → 本机 ${port}…`);
try {
  run(['reverse', `tcp:${port}`, `tcp:${port}`]);
  console.log('   ✓ 已建立反向端口');
} catch (err) {
  console.error(`✗ adb reverse 失败：${err.message}`);
  console.error('  确认设备已连接（adb devices）且 adb 路径正确（--adb）。');
  process.exit(4);
}

console.log('🚀 4. 启动 App 并把真主机凭据交给原生中继…');
// 必须先 force-stop：否则 am start 会复用已有实例，extra 送不到（实测踩过）。
try {
  run(['shell', 'am', 'force-stop', APP_ID]);
  run([
    'shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`,
    '--es', 'dsh_relay_base_url', base,
    '--es', 'dsh_relay_token', token,
    '--es', 'dsh_relay_label', safeLabel,
  ]);
  console.log(`   ✓ 已启动（label=${safeLabel}）`);
} catch (err) {
  console.error(`✗ 启动失败：${err.message}`);
  console.error(`  设备侧的令牌已经写进去了，但它现在没被用起来；请先吊销：`);
  console.error(`    node scripts/pair-and-point-android.mjs --revoke-device ${deviceId}`);
  process.exit(5);
}

console.log('');
console.log('接下来看设备侧日志（应当出现 ready 帧带回的**真 clientId**）：');
console.log('  adb logcat -s DshRelay');
console.log('');
console.log(`验证完记得吊销这枚令牌（release 构建会忽略 --es extra，仅 debug 可用）：`);
console.log(`  node scripts/pair-and-point-android.mjs --revoke-device ${deviceId}`);