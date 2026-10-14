/**
 * 让 `node --experimental-strip-types` 能直接跑 `src/` 下的模块 —— **零依赖**。
 *
 * ## 为什么需要它（2026-10-14）
 *
 * 项目源码内部用的是**打包器风格的相对导入**（`import { X } from './envelopes'`、
 * `from '../types'`），扩展名和目录索引都省略了 —— Vite 能解析，**Node ESM 不能**：
 *
 *   - `./envelopes`  → ERR_MODULE_NOT_FOUND
 *   - `../types`     → ERR_UNSUPPORTED_DIR_IMPORT
 *
 * 后果：回归测试只能测**没有任何内部导入**的孤立模块（如 `lib/markdown.ts`），
 * 于是 `services/connection.ts` 这种真正承载协议契约的文件**完全无法测**。
 * 这正是「150 条测试被删后没补回来」的结构性原因之一。
 *
 * 这个 hook 用 Node 内置的 `module.registerHooks()`（同步、无子进程）补上
 * 打包器的解析规则：**解析不到就依次试 `.ts` `.tsx` `/index.ts` `/index.tsx`**。
 *
 * 用法（必须走 `--import`，因为 hook 要在入口模块解析前注册）：
 *
 *   node --experimental-strip-types \
 *        --import ./scripts/ts-resolve-hook.mjs \
 *        scripts/test-approval-contract.mjs
 *
 * ⚠️ 只做**解析**，不做**转换**：`.ts` 靠 Node 的 type stripping，
 * 但 `.tsx` 里的 JSX **不会被转换**，所以本 hook 不能用来导入 React 组件。
 * 组件层的断言请用源码级检查（见 test-approval-contract.mjs）。
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** 依次尝试的后缀，顺序即优先级：同名 `.ts` 优先于目录索引。 */
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 只接管相对导入；裸包名（react、ws…）保持 Node 原行为。
    if (specifier.startsWith('.') && context.parentURL) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      // 已有扩展名（.ts/.mjs/.json…）就不插手，避免破坏正常路径。
      if (!path.extname(base)) {
        for (const ext of CANDIDATES) {
          if (existsSync(base + ext)) {
            return { url: pathToFileURL(base + ext).href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});