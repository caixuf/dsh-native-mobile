import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const androidDir = path.join(rootDir, 'android');
const distDir = path.join(rootDir, 'dist');
const assetsWebDir = path.join(androidDir, 'app', 'src', 'main', 'assets', 'web');
const distApkDir = path.join(rootDir, 'dist-apk');

console.log('📦 1. 复制前端构建产物 (dist/ -> assets/web/)...');
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
const javaHome = 'C:\\Users\\20247\\Downloads\\android-toolchain\\jdk17';
const gradleBat = 'C:\\Users\\20247\\Downloads\\android-toolchain\\gradle-8.11.1\\bin\\gradle.bat';

execSync(`"${gradleBat}" assembleDebug`, {
  cwd: androidDir,
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
  },
  stdio: 'inherit',
});

console.log('🚀 3. 收集 APK 交付物...');
const outputApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const targetApk = path.join(distApkDir, 'dsh-mobile-v0.3.0.apk');

if (fs.existsSync(outputApk)) {
  fs.mkdirSync(distApkDir, { recursive: true });
  fs.copyFileSync(outputApk, targetApk);
  const sizeMb = (fs.statSync(targetApk).size / (1024 * 1024)).toFixed(2);
  console.log(`\n🎉 Android APK 构建成功！`);
  console.log(`   产物位置: ${targetApk}`);
  console.log(`   安装包大小: ${sizeMb} MB`);
} else {
  console.error('❌ 未找到生成的 APK 文件');
  process.exit(1);
}
