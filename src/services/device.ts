/**
 * 客户端设备标识 —— **纯函数 + 可注入存储**，零内部依赖（Node 测试可直接 import）。
 *
 * ## 为什么需要它（2026-10-14 用户实测）
 *
 * 网关的身份键是 `platform + name`（`packages/dsh-mobile-gateway/lib/store.mjs`：
 * `#issueDevice()` 按 `d.platform === cleanPlatform && d.name === cleanName` **复用设备记录**，
 * 复用时只换 token）。而网页端此前所有手机的 `deviceName` 都硬编码成
 * `"Web Remote Client"`（App.tsx 里 PairScreen 的 `deviceName` prop）——
 * 于是**第二台手机登录会复用第一台的设备记录并轮换掉它的 token**，
 * 第一台随即被 403 踢下线。用户看到的现象是「两台手机互相顶下线」。
 *
 * 正确做法不是改网关（改 `packages/**` 要重启 DSH，会杀掉正在跑的会话），
 * 而是让每台设备自带一个**稳定的短 id**，把 `deviceName` 变成唯一名：
 *
 *     "Web Remote Client · a1b2c3"
 *
 * 在网关既有的 `platform + name` 判据下天然分开，无需协议变更。
 * 网关对 name 的处理是 `trim().slice(0, 64)`，所以唯一名必须 ≤ 64 字符（本文件保证）。
 */

/** localStorage 键（带版本号：将来格式升级时可以并存读取，不会炸旧数据）。 */
export const DEVICE_ID_KEY = 'dsh_device_id_v1';

/** 设备名基数（App 里原本硬编码的那一个）。 */
export const DEFAULT_DEVICE_BASE_NAME = 'Web Remote Client';

/** 唯一后缀长度。6 位 base36 ≈ 2.2e9 种；同一个人手上几台设备碰撞概率可忽略。 */
export const DEVICE_ID_LENGTH = 6;

/** 网关侧 `name.trim().slice(0, 64)` —— 唯一名不得超过这个长度，否则后缀会被截掉。 */
export const DEVICE_NAME_MAX_LENGTH = 64;

/** 唯一名分隔符（前后各一个空格，与 `"Web Remote Client · a1b2c3"` 逐字一致）。 */
export const DEVICE_NAME_SEPARATOR = ' · ';

/** 最小可用的存储接口（`localStorage` 的结构子集，便于测试注入）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface DeviceIdOptions {
  /** 显式存储；`undefined` = 自动探测 `localStorage`；`null` = 只用内存（测试/SSR）。 */
  storage?: StorageLike | null;
  /** 注入随机源（测试用）。 */
  random?: () => number;
  /** 直接采用一个已有 id（原生壳下发/迁移场景），仍会被规范化。 */
  id?: string;
}

/** 自动探测 `localStorage`：不存在或不可用（隐私模式抛异常）时返回 null。 */
function detectStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch {
    // Safari 隐私模式下访问 localStorage 会抛，静默降级为内存态
  }
  return null;
}

/**
 * 无存储可用时的进程内 id。
 * 没有它的话，每次 `getOrCreateDeviceId()` 都会生成新 id ——
 * 同一台设备在一次运行里会"变成"好几台设备（正是我们要修的缺陷）。
 */
let fallbackDeviceId: string | null = null;

/**
 * 规范化一个 device id：小写、只保留 `[a-z0-9]`、取**末尾** `DEVICE_ID_LENGTH` 位。
 * 不足 4 位视为无效（返回 null）—— 拼进设备名的东西必须是可预期的字符集。
 */
export function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleaned.length < 4) return null;
  return cleaned.slice(-DEVICE_ID_LENGTH);
}

/**
 * 生成一个新的 device id（`DEVICE_ID_LENGTH` 位 `[0-9a-z]`）。
 * 注入的 `random()` 恒为 0 时会退化成全零 id，这里显式避免。
 */
export function generateDeviceId(random: () => number = Math.random): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < DEVICE_ID_LENGTH; i += 1) {
    const idx = Math.floor(random() * alphabet.length);
    out += alphabet[idx >= 0 && idx < alphabet.length ? idx : 0];
  }
  return /^0+$/.test(out) ? `d${out.slice(1)}` : out;
}

/**
 * 取（必要时生成并持久化）本机 device id。
 *
 * 同一台设备每次调用返回同一个值：`localStorage` 里已有就复用，没有才生成并写回。
 * 存储不可用（Node/隐私模式）时退化为**进程内常量**，保证同一次运行内稳定。
 */
export function getOrCreateDeviceId(options: DeviceIdOptions = {}): string {
  const injected = sanitizeDeviceId(options.id);
  if (injected) return injected;

  const storage = options.storage === undefined ? detectStorage() : options.storage;
  if (storage) {
    try {
      const stored = sanitizeDeviceId(storage.getItem(DEVICE_ID_KEY));
      if (stored) return stored;
    } catch {
      // 读失败不致命：继续生成一个新的
    }
  }

  // 存储不可用（Node/隐私模式）：退化为进程内常量，同一次运行内必须稳定。
  if (!storage) {
    if (!fallbackDeviceId) fallbackDeviceId = generateDeviceId(options.random);
    return fallbackDeviceId;
  }

  const fresh = fallbackDeviceId ?? generateDeviceId(options.random);
  fallbackDeviceId = fresh;
  try {
    storage.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    // 写失败（配额/隐私模式）不致命：本次运行仍用这个 id
  }
  return fresh;
}

/** 从 `"Web Remote Client · a1b2c3"` 这类名字里剥掉已有后缀（保证幂等）。 */
export function stripDeviceSuffix(base: string): string {
  const trimmed = String(base ?? '').trim();
  const idx = trimmed.lastIndexOf(DEVICE_NAME_SEPARATOR);
  if (idx < 0) return trimmed;
  const suffix = trimmed.slice(idx + DEVICE_NAME_SEPARATOR.length);
  return /^[a-z0-9]{4,8}$/.test(suffix) ? trimmed.slice(0, idx).trim() : trimmed;
}

/**
 * 把基础设备名变成网关侧唯一的设备名。
 *
 * - 幂等：`uniqueDeviceName(uniqueDeviceName(base, id), id)` 完全等于前一次结果。
 * - 同一 id → 同一名字（稳定，重启后不会变成"新设备"）。
 * - 不同 id → 不同名字（网关 `platform + name` 判据下互相独立）。
 * - id 无效时**不加后缀**（返回基础名），但绝不返回空串。
 * - 总长裁剪到 `DEVICE_NAME_MAX_LENGTH`，保证后缀不被网关 `slice(0, 64)` 截掉。
 */
export function uniqueDeviceName(base: string, id: string): string {
  const cleanBase = stripDeviceSuffix(base) || DEFAULT_DEVICE_BASE_NAME;
  const suffix = sanitizeDeviceId(id);
  if (!suffix) return cleanBase.slice(0, DEVICE_NAME_MAX_LENGTH);
  const tail = DEVICE_NAME_SEPARATOR + suffix;
  const room = DEVICE_NAME_MAX_LENGTH - tail.length;
  return (cleanBase.slice(0, Math.max(1, room)) + tail).trim();
}

/**
 * 当前设备在配对/登录时应发送的设备名。
 * App.tsx 的接入形态：`deviceName={currentDeviceName('Web Remote Client')}`。
 */
export function currentDeviceName(base: string = DEFAULT_DEVICE_BASE_NAME, options: DeviceIdOptions = {}): string {
  return uniqueDeviceName(base, getOrCreateDeviceId(options));
}