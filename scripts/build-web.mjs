import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const tempDir = path.join(rootDir, '.scratch', 'temp');

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

console.log('🔍 正在执行 TypeScript 类型检查...');
execSync('node ./node_modules/typescript/bin/tsc -b', { cwd: rootDir, stdio: 'inherit' });

console.log('⚡ 正在执行 Vite 生产构建...');
execSync('node ./node_modules/vite/bin/vite.js build', {
  cwd: rootDir,
  env: {
    ...process.env,
    TEMP: tempDir,
    TMP: tempDir,
  },
  stdio: 'inherit',
});
