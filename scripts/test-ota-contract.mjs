/**
 * OTA 自更新 + 官方归档同步的护栏。
 *
 * ## 为什么需要它
 *
 * 这两块都有「看起来做了、其实没生效」的风险，而且症状都是静默的：
 *
 * · **OTA**：旧版「检查更新」是 `setTimeout(…, 800)` 后无脑显示「已是最新版本」，
 *   永远收不到更新也永远看不出来。要钉死的是「必须真的比对版本」。
 * · **归档**：旧实现是手机 localStorage 的假归档，UI 写着「仅本机」。
 *   2026-10-19 实测证明 `workspace/*` 有官方归档且可双向同步。
 *
 * 本文件检查的是**契约**，不是实现细节：
 *   1. 版本比较必须按数字段（1.10.0 > 1.9.0），不能按字符串；
 *   2. 不得再出现假的定时器式「检查更新」；
 *   3. OTA 只允许下载受信域名（防注入装任意 APK）；
 *   4. 归档必须走官方 workspace 端点，不得退回本地假归档；
 *   5. 原生侧必须有 FileProvider + REQUEST_INSTALL_PACKAGES（缺任一个都是静默失败）。
 *
 *   node --experimental-strip-types scripts/test-ota-contract.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err?.message || err}`);
  }
}
const ok = (cond, msg) => assert.ok(cond, msg);


/**
 * 去掉注释后的代码（护栏只盯**实际代码**，不误报解释性注释）。
 *
 * 这几条护栏原本用全文匹配，结果被"注释里说明历史原因"误伤：
 * 例如 AboutModal 的注释写着旧的假实现长什么样、file_paths.xml 的注释说
 * "不要写 root-path"、session-groups 的注释说"旧的『仅本机』说法已过时"。
 * 注释不是行为，不该被当成违规。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/^\s*\/\/.*$/gm, '')            // 行注释
    .replace(/<!--[\s\S]*?-->/g, '')        // XML 注释
    .replace(/^\s*\*.*$/gm, '');             // JSDoc 续行残留
}

console.log('\n  OTA 与归档同步护栏');
console.log('  ' + '─'.repeat(50));

// ── OTA 前端契约 ──────────────────────────────────────────────

test('版本比较按数字段（1.10.0 > 1.9.0），不能按字符串比', () => {
  const ota = read('src/services/ota.ts');
  // 必须有自己的比较函数，且不能出现 "a > b" 这种字符串比较版本号
  ok(/export function compareVersions/.test(ota), '必须有 compareVersions');
  ok(/parseInt\(x, 10\)/.test(ota), '版本段必须 parseInt，否则 1.10 < 1.9');
  ok(!/versionName\s*>\s*latest|latestVersion\s*>\s*versionName/.test(ota), '不得直接比较版本字符串');
});

test('不得再有假的「检查更新」（setTimeout 后台改状态）', () => {
  const about = codeOnly(read('src/components/common/AboutModal.tsx'));
  ok(!/setTimeout\(\s*\(\)\s*=>\s*\{[^}]*setCheckedOk/.test(about), '旧的假检查逻辑必须彻底删除');
  ok(!/setCheckedOk/.test(about), '不得保留 setCheckedOk 这类假状态');
  // 必须真的调用 OTA 服务
  ok(/checkForUpdate\(/.test(about), '必须真的查 Release');
});

test('OTA 下载只允许受信域名（防止被注入后装任意 APK）', () => {
  const kt = read('android/app/src/main/java/io/github/dshmobile/app/relay/UpdateManager.kt');
  ok(/TRUSTED_PREFIXES/.test(kt), '必须有受信域名白名单');
  ok(/isTrustedUrl/.test(kt), '必须有 isTrustedUrl 校验');
  ok(/github\.com\/caixuf\/dsh-native-mobile/.test(kt), '白名单必须限定本仓库');
  // 校验必须在下载前执行
  ok(/if \(!isTrustedUrl\(url\)\)/.test(kt), '不受信的 URL 必须直接拒绝');
});

test('APK 资产按后缀挑选，不写死文件名', () => {
  const ota = read('src/services/ota.ts');
  ok(/endsWith\('\.apk'\)/.test(ota), '必须按 .apk 后缀挑资产');
  ok(!/dsh-mobile-v\d+\.\d+\.\d+\.apk/.test(ota), '不得写死某个具体版本的资产名');
});

// ── OTA 原生契约（缺任何一条都是静默失败）───────────────────

test('原生侧：REQUEST_INSTALL_PACKAGES 权限（缺了安装页被静默吞掉）', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  ok(manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'), '必须声明安装未知来源权限');
});

test('原生侧：FileProvider 已注册且路径只暴露 cache/ota', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  ok(/androidx\.core\.content\.FileProvider/.test(manifest), '必须注册 FileProvider');
  ok(manifest.includes('${applicationId}.ota'), 'authority 必须带 .ota 后缀');
  const paths = codeOnly(read('android/app/src/main/res/xml/file_paths.xml'));
  ok(paths.includes('<cache-path'), '必须声明 cache-path');
  ok(paths.includes('path="ota/"'), '必须限定到 ota/ 子目录');
  ok(!paths.includes('<root-path'), '不得暴露整个存储');
  ok(!paths.includes('<external-path'), '不得暴露外部存储');
});

test('原生侧：安装走 PackageInstaller 会话，不用 ACTION_VIEW 弹应用选择器', () => {
  const kt = read('android/app/src/main/java/io/github/dshmobile/app/relay/UpdateManager.kt');
  // 实测（模拟器）：ACTION_VIEW + MIME 会弹「Open with…」选择器，
  // 连其它应用都出现在候选里，用户得先选一次才能进安装页。
  ok(/PackageInstaller/.test(kt), '必须用 PackageInstaller 会话');
  ok(/createSession\(/.test(kt), '必须创建安装会话');
  ok(/session\.commit\(/.test(kt), '必须 commit 会话');
  // ACTION_VIEW 只能作为兜底（PackageInstaller 失败后），不能在它之前
  const piIdx = kt.indexOf('PackageInstaller.SessionParams');
  const viewIdx = kt.indexOf('Intent.ACTION_VIEW');
  ok(piIdx > 0, '缺少 PackageInstaller 主路径');
  ok(viewIdx > piIdx, 'ACTION_VIEW 必须排在 PackageInstaller 之后（仅兜底）');
});

test('原生侧：安装结果有接收器（否则失败完全无提示）', () => {
  const kt = read('android/app/src/main/java/io/github/dshmobile/app/relay/InstallResultReceiver.kt');
  ok(/STATUS_FAILURE|STATUS_SUCCESS|EXTRA_STATUS/.test(kt), '必须处理安装结果状态');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  ok(/InstallResultReceiver/.test(manifest), 'manifest 必须注册接收器');
  ok(/android:exported="false"/.test(manifest), '接收器必须不导出（防伪造结果）');
});

test('原生侧：安装走 content:// 而非 file://（7.0+ 会抛 FileUriExposedException）', () => {
  const kt = read('android/app/src/main/java/io/github/dshmobile/app/relay/UpdateManager.kt');
  ok(/FileProvider\.getUriForFile/.test(kt), '必须用 FileProvider 取 URI');
  ok(/FLAG_GRANT_READ_URI_PERMISSION/.test(kt), '必须授予读权限，否则安装器读不到');
  ok(!/Uri\.fromFile/.test(kt), '不得用 file:// URI');
});

test('原生侧：安装前检查「未知来源」授权（未授权时不报错、直接无反应）', () => {
  const kt = read('android/app/src/main/java/io/github/dshmobile/app/relay/UpdateManager.kt');
  ok(/canRequestPackageInstalls/.test(kt), '必须检查安装权限');
  ok(/ACTION_MANAGE_UNKNOWN_APP_SOURCES/.test(kt), '必须能引导用户去授权');
  ok(/needPermission/.test(kt), '未授权时必须回传 needPermission');
});

test('原生侧：下载不在主线程（否则 NetworkOnMainThreadException）', () => {
  const kt = read('android/app/src/main/java/io/github/dshmobile/app/relay/UpdateManager.kt');
  ok(/Executors\.newSingleThreadExecutor/.test(kt), '下载必须放到后台线程');
  ok(/executor\.execute/.test(kt), '必须真的投递到后台线程');
});

// ── 官方归档同步契约 ─────────────────────────────────────────

test('归档走官方 workspace 端点，不再用本地假归档', () => {
  const sync = read('src/services/workspace-sync.ts');
  for (const ep of ['workspace/archiveSession', 'workspace/unarchiveSession', 'workspace/pinSession', 'workspace/unpinSession', 'workspace/follow']) {
    ok(sync.includes(ep), `缺少官方端点 ${ep}`);
  }
  // 订阅必须是流（openStream），不能当 RPC
  ok(/openStream\(\s*'workspace\/follow'/.test(sync), 'workspace/follow 必须用 openStream 订阅');
});

test('App 的归档动作调用官方端点', () => {
  const app = read('src/App.tsx');
  ok(/archiveSession\(conn/.test(app), '归档必须调用 archiveSession');
  ok(/unarchiveSession\(conn/.test(app), '取消归档必须调用 unarchiveSession');
  ok(/subscribeWorkspaceState/.test(app), '必须订阅 workspace 状态');
  ok(/setArchivedIds\(state\.archivedSessionIds\)/.test(app), '订阅结果必须落到界面状态');
});

test('归档文案表达「与电脑同步」，不再声称仅本机', () => {
  const groups = codeOnly(read('src/lib/session-groups.ts'));
  ok(!/仅本机/.test(groups), '分组模块的**代码**不得再出现"仅本机"字样');
  ok(/同步/.test(groups), '文案必须表达同步');
});

test('workspace/follow 的 args 不重复包装（openStream 已包 args）', () => {
  const sync = read('src/services/workspace-sync.ts');
  // 必须是扁平 {}，不能是 {args:{}}，否则主机回 gateway/arguments-invalid
  ok(!/openStream\(\s*'workspace\/follow',\s*\{\s*args:/.test(sync), '不得再包一层 args');
});

console.log('  ' + '─'.repeat(50));
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
