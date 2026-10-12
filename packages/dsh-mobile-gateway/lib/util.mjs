/**
 * @file lib/util.mjs
 * @description 日志、路径与小工具。所有运行时数据落在 `$DSH_HOME/dsh-mobile-gateway/`。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 解析 $DSH_HOME（与 DSH 自身一致：环境变量优先，其次 ~/.dsh）。 */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME && env.DSH_HOME.trim();
  if (raw) return raw;
  return join(homedir(), '.dsh');
}

/** 把可能是相对路径的配置项解析成绝对路径；留空则回落到默认目录。 */
export function resolvePath(configured, base) {
  const value = (configured ?? '').trim();
  if (!value) return base;
  return isAbsolute(value) ? value : join(base, value);
}

/**
 * 极简 JSONL 日志器。后端 stderr 对桌面用户不可见，
 * 这是插件作者惯例留下的定位入口（dsh-bot-gateway 的 boot.log 同理）。
 */
export function createLogger(logFile, { minLevel = 'info', console: useConsole = true } = {}) {
  const threshold = LEVELS[minLevel] ?? LEVELS.info;
  let queue = Promise.resolve();

  function write(level, message, fields) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      logger: 'dsh-mobile-gateway',
      message,
      ...(fields ? { fields } : {}),
    });
    if (useConsole) {
      const sink = level === 'error' ? process.stderr : process.stdout;
      sink.write(`[dsh-mobile-gateway] ${message}\n`);
    }
    queue = queue.then(async () => {
      try {
        await mkdir(join(logFile, '..'), { recursive: true });
        await appendFile(logFile, line + '\n', 'utf8');
      } catch {
        /* 日志失败不得影响业务 */
      }
    });
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    flush: () => queue,
  };
}

/** 安全比较两个等长字符串，避免时序侧信道。 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 是否回环来源（管理面只在回环应答）。 */
export function isLoopbackAddress(address) {
  if (!address) return false;
  const addr = address.replace(/^::ffff:/i, '');
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}

/** 读取请求头（Node IncomingMessage 兼容）。 */
export function header(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}