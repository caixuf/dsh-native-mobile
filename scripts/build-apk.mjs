import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveGradle, gradleEnv } from './lib/gradle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const androidDir = path.join(rootDir, 'android');
const distDir = path.join(rootDir, 'dist');
const assetsWebDir = path.join(androidDir, 'app', 'src', 'main', 'assets', 'web');
const distApkDir = path.join(rootDir, 'dist-apk');

console.log('📦 1. 复制前端构建产物 (dist/ -> assets/web/)...');

/**
 * 🔴 陈旧 dist 守卫（2026-10-14 踩过）。
 *
 * 这个脚本**只复制** `dist/`，不负责生成它（生成在 `pnpm build:apk` 的前半段
 * `vite build`）。所以有人直接 `gradle assembleDebug`、或者单独 `node scripts/build-apk.mjs`
 * 时，APK 里会打进**上一次的网页** —— 表现是「原生改动生效了、网页改动没生效」，
 * 极难归因（实测：native 桥的调用端没进包，导致后台审批通道永远拿不到凭据）。
 *
 * 所以这里显式比对 mtime：源码比产物新就**直接失败**，而不是安静地打出一个旧包。
 */
function newestMtime(dir, filter) {
  let newest = 0;
  let newestFile = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtime(full, filter);
      if (sub.mtime > newest) {
        newest = sub.mtime;
        newestFile = sub.file;
      }
    } else if (filter(entry.name)) {
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        newestFile = full;
      }
    }
  }
  return { mtime: newest, file: newestFile };
}

const distIndex = path.join(distDir, 'index.html');
if (!fs.existsSync(distIndex)) {
  console.error('❌ dist/index.html 不存在 —— 先跑 vite build（或直接用 pnpm build:apk）。');
  process.exit(1);
}

const srcNewest = newestMtime(path.join(rootDir, 'src'), (n) => /\.(ts|tsx|css)$/.test(n));
const shellNewest = newestMtime(rootDir, (n) => n === 'index.html' || n === 'vite.config.ts');
const newestSource = Math.max(srcNewest.mtime, shellNewest.mtime);
const distMtime = fs.statSync(distIndex).mtimeMs;

if (newestSource > distMtime) {
  const offender = srcNewest.mtime >= shellNewest.mtime ? srcNewest.file : shellNewest.file;
  console.error('❌ dist/ 比源码旧 —— 直接打包会把**旧网页**塞进 APK。');
  console.error(`   最新源码: ${path.relative(rootDir, offender)}`);
  console.error('   请改用 `pnpm build:apk`（= tsc -b && vite build && node scripts/build-apk.mjs）。');
  console.error('   单独跑 gradle assembleDebug 不会重建网页，只会复用 assets/web/ 里的旧产物。');
  process.exit(1);
}

if (fs.existsSync(assetsWebDir)) {
  fs.rmSync(assetsWebDir, { recursive: true, force: true });
}
fs.mkdirSync(assetsWebDir, { recursive: true });

function copyRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
copyRecursive(distDir, assetsWebDir);
console.log('   ✓ 网页资产已就绪');

console.log('🔨 2. 执行 Gradle 打包 Android APK...');
const gradle = resolveGradle();
console.log(`   使用 Gradle (${gradle.kind}): ${gradle.bin}`);

execSync(`"${gradle.bin}" assembleDebug`, {
  cwd: androidDir,
  env: gradleEnv(),
  stdio: 'inherit',
});

console.log('🚀 3. 收集 APK 交付物...');
const outputApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

// 版本号从 build.gradle.kts 读，而不是写死在脚本里 ——
// 否则改了 Gradle 的 versionName 而产物名还是旧的，交付物与版本号就对不上了。
const gradleKts = fs.readFileSync(path.join(androidDir, 'app', 'build.gradle.kts'), 'utf8');
const versionName = (gradleKts.match(/versionName\s*=\s*"([^"]+)"/) || [, 'unknown'])[1];
const versionCode = (gradleKts.match(/versionCode\s*=\s*(\d+)/) || [, '?'])[1];
const targetApk = path.join(distApkDir, `dsh-mobile-v${versionName}.apk`);

if (fs.existsSync(outputApk)) {
  fs.mkdirSync(distApkDir, { recursive: true });
  fs.copyFileSync(outputApk, targetApk);
  const sizeMb = (fs.statSync(targetApk).size / (1024 * 1024)).toFixed(2);
  console.log(`\n🎉 Android APK 构建成功！`);
  console.log(`   产物位置: ${targetApk}`);
  console.log(`   版本: v${versionName} (versionCode ${versionCode})`);
  console.log(`   安装包大小: ${sizeMb} MB`);
} else {
  console.error('❌ 未找到生成的 APK 文件');
  process.exit(1);
}
