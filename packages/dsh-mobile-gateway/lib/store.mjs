/**
 * @file lib/store.mjs
 * @description 配对码与设备令牌的持久化注册表。
 *
 * 安全约定：
 * - 设备令牌只在配对成功那一刻返回一次，磁盘上只留 SHA-256 摘要，明文不可恢复。
 * - 配对码一次性消费、短 TTL；刷新后旧码立即作废。
 * - 写盘走「临时文件 + 原子改名」，进程被杀不会留下半截 JSON。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 去掉易混字符（0/O/1/I/L）的配对码字母表。 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function randomCode(length = 16) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** 生成6位纯数字配对码（对齐移动端极简输入体验） */
function randomPin(length = 6) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += (bytes[i] % 10).toString();
  return out;
}

function formatCode(body) {
  return `dshm1.${body.match(/.{1,4}/g).join('-')}`;
}

function parseCode(input) {
  const normalized = String(input ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (/^\d{6}$/.test(normalized)) {
    return { type: 'pin', value: normalized };
  }
  const body = normalized.startsWith('DSHM1.') ? normalized.slice(6) : normalized;
  if (body.length !== 16) return null;
  for (const ch of body) if (!CODE_ALPHABET.includes(ch)) return null;
  return { type: 'code', value: body };
}

/**
 * 账号密码凭据。
 *
 * 用户反馈「配对码太麻烦」——要复制 22 位、还要区分大小写。改成账号密码：
 * 电脑端管理面板直接显示，手机端两个输入框，跟平常登录一样。
 *
 * 安全边界与原配对码方案完全一致：
 *   - 密码以 SHA-256 摘要落盘，不明文存储
 *   - 首次配对仍需一次「账号密码」交换，换回长期设备令牌
 *   - 之后手机只用令牌，不再传输密码
 *
 * 注意：这不是「多用户体系」，仍然是一台机器一个密码，只是入口好记。
 */
export const DEFAULT_CREDENTIALS = {
  username: 'dsh',
  // 首次自动生成 12 位密码（去易混字符），用户在管理面板可见，可改。
  password: randomCode(12),
};

/** 生成密码用的字母表（去掉 0/O/1/I/L/S5 等易混字符）。 */
const PASSWORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomPassword(length = 12) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

export class DeviceStore {
  #file;
  #log;
  #state = { version: 3, devices: [], pairing: null, credentials: null };
  #writeChain = Promise.resolve();
  /** 由连接层注入：给设备列表打在线标记。 */
  #online;

  constructor(file, log) {
    this.#file = file;
    this.#log = log;
  }

  get file() {
    return this.#file;
  }

  async load() {
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.devices)) {
        this.#state = { version: 2, devices: parsed.devices, pairing: parsed.pairing ?? null };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#log.warn('devices file unreadable; starting empty', { error: String(error) });
      }
    }
    this.#prune();
    return this.#state;
  }

  async #persist() {
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#file);
      try {
        await chmod(this.#file, 0o600);
      } catch {
        /* Windows 上没有 POSIX 权限位，忽略 */
      }
    });
    return this.#writeChain;
  }

  #prune(now = Date.now()) {
    const devices = this.#state.devices.filter((d) => !d.revokedAt && (!d.expiresAt || d.expiresAt > now));
    if (this.#state.pairing && this.#state.pairing.expiresAt <= now) this.#state.pairing = null;
    this.#state.devices = devices;
  }

  /**
   * 清空所有设备记录（保留账号凭据与配对码设置）。
   *
   * 用途：历史遗留数据清理。设备令牌 TTL 是 30 天，早期版本每次登录都
   * 新增一条记录，存量会一直挂着到过期为止（实测积到 126 条）。
   *
   * ⚠️ 副作用：**所有已配对设备会立刻掉线**，需要重新登录/配对。
   * 所以只在管理面板显式触发，不做自动调用。
   */
  async clearDevices() {
    const removed = this.#state.devices.length;
    this.#state.devices = [];
    await this.#persist();
    return { ok: true, removed };
  }

  /**
   * 按 `platform + name` 合并重复设备，每组只保留最近活跃的一条。
   *
   * 用于清理历史遗留：早期版本每次登录都新增记录，同一台手机会有
   * 多条同名条目。保留 `lastSeenAt` 最新的那条（它的 token 最可能仍在使用），
   * 其余删除。
   */
  async dedupeDevices() {
    const now = Date.now();
    this.#prune(now);

    const best = new Map();
    for (const d of this.#state.devices) {
      const key = `${d.platform}\u0000${d.name}`;
      const prev = best.get(key);
      if (!prev || (d.lastSeenAt ?? 0) > (prev.lastSeenAt ?? 0)) {
        best.set(key, d);
      }
    }

    const before = this.#state.devices.length;
    this.#state.devices = [...best.values()].sort(
      (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
    );
    await this.#persist();
    return { ok: true, before, after: this.#state.devices.length, removed: before - this.#state.devices.length };
  }

  // ---- 账号密码 -----------------------------------------------------------

  /**
   * 取出当前凭据；首次调用时自动生成一套。
   * 返回的 password 是**明文**（只有管理面板会用），落盘的仍是摘要。
   */
  ensureCredentials() {
    if (!this.#state.credentials) {
      const password = randomPassword(12);
      this.#state.credentials = {
        username: DEFAULT_CREDENTIALS.username,
        passwordHash: sha256Hex(password),
        createdAt: Date.now(),
      };
      void this.#persist();
      return { username: DEFAULT_CREDENTIALS.username, password };
    }
    return null; // 已存在，不重复生成（调用方应读磁盘上的提示）
  }

  /** 管理面板用：返回用户名与密码明文（仅当本次会话刚生成时才有）。 */
  credentialsView() {
    const c = this.#state.credentials;
    if (!c) return null;
    return {
      username: c.username,
      createdAt: c.createdAt,
      passwordSet: true,
    };
  }

  /** 改密码。旧密码可选（首次设置时不需要）。 */
  async setPassword(newPassword, oldPassword) {
    const c = this.#state.credentials;
    if (c && oldPassword !== undefined) {
      if (sha256Hex(String(oldPassword)) !== c.passwordHash) return { ok: false, reason: 'mismatch' };
    }
    const next = String(newPassword ?? '');
    if (next.length < 6) return { ok: false, reason: 'too-short' };
    this.#state.credentials = {
      username: c?.username ?? DEFAULT_CREDENTIALS.username,
      passwordHash: sha256Hex(next),
      createdAt: Date.now(),
    };
    await this.#persist();
    return { ok: true };
  }

  /**
   * 签发设备令牌，**同一台设备复用同一条记录**。
   *
   * 🔴 真实问题（2026-10-14 实测）：原先 `login` 与 `redeem` 都无条件
   * `devices.push()`，从不查重。结果是**每登录一次就多一条设备**——
   * 用户在同一台手机上反复登录/重连，管理面板就会堆出一大串同名设备
   * （实测攒到 126 条，绝大多数是同一个模拟器 + 各种验证脚本）。
   *
   * 身份键取 `platform + name`（App 传的是机型，如 `RMX5200`）：
   *  - 同一台手机 → 名称与平台稳定 → 命中同一条记录，**只轮换 token**；
   *  - 换一台手机 / 改名 → 视为新设备，另立一条。
   *
   * 为什么用 `name` 而不是设备指纹：客户端目前不送稳定的硬件 ID，
   * 加字段要改协议与两端；`platform + name` 已经能解决「同一台设备重复登录」
   * 这个实际痛点，且对旧客户端向后兼容。
   *
   * ⚠️ 这**不是**安全边界：设备名可被客户端伪造。它只是"去重展示"的判据；
   * 真正的鉴权始终是 token 本身（每次签发都换新 tokenHash）。
   */
  #issueDevice({ name, platform, ttlMs }) {
    const now = Date.now();
    const cleanName = (name ?? '').trim().slice(0, 64) || 'Android';
    const cleanPlatform = (platform ?? '').trim().slice(0, 32) || 'android';
    const token = randomBytes(32).toString('base64url');

    const existing = this.#state.devices.find(
      (d) => d.platform === cleanPlatform && d.name === cleanName,
    );

    if (existing) {
      // 复用：换 token、续期、刷新活跃时间。id 与 createdAt 保持不变，
      // 这样管理面板里看到的是「同一台设备又连上来了」而不是新设备。
      existing.tokenHash = sha256Hex(token);
      existing.lastSeenAt = now;
      existing.expiresAt = now + ttlMs;
      return { device: existing, token };
    }

    const device = {
      id: `dev_${randomBytes(9).toString('base64url')}`,
      name: cleanName,
      platform: cleanPlatform,
      tokenHash: sha256Hex(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ttlMs,
    };
    this.#state.devices.push(device);
    return { device, token };
  }

  /**
   * 用账号密码换取设备令牌。
   *
   * 与配对码方案的关系：**并存的第二条入口**，不取代配对码。
   * 校验通过后签发的设备令牌与配对码完全同构，后续鉴权无差别。
   */
  async login(username, password, { ttlMs, deviceName, platform }) {
    const now = Date.now();
    this.#prune(now);
    const c = this.#state.credentials;
    if (!c) return { ok: false, reason: 'no-credentials' };

    const userOk = String(username ?? '').trim().toLowerCase() === c.username.toLowerCase();
    const passOk = sha256Hex(String(password ?? '')) === c.passwordHash;
    if (!userOk || !passOk) return { ok: false, reason: 'mismatch' };

    const { device, token } = this.#issueDevice({ name: deviceName, platform, ttlMs });
    await this.#persist();
    return { ok: true, device: this.#public(device), token };
  }

  /** 铸造一枚新的配对码（同时生成 6 位纯数字 PIN 与 16 位字符码）；旧码立即作废。 */
  async mintPairing({ ttlMs, origin } = {}) {
    const now = Date.now();
    this.#prune(now);
    const body = randomCode(16);
    const pin = randomPin(6);
    this.#state.pairing = {
      codeHash: sha256Hex(body),
      pinHash: sha256Hex(pin),
      pin,
      pinDisplay: `${pin.slice(0, 3)} ${pin.slice(3)}`,
      display: formatCode(body),
      createdAt: now,
      expiresAt: now + (ttlMs || 600_000),
      origin: origin ?? null,
    };
    await this.#persist();
    return { ...this.#state.pairing };
  }

  /** 当前配对码的公开视图（不含摘要）。脱敏返回。 */
  currentPairing(now = Date.now()) {
    this.#prune(now);
    if (!this.#state.pairing) return null;
    const { codeHash, pinHash, ...rest } = this.#state.pairing;
    void codeHash;
    void pinHash;
    return rest;
  }

  /** 消费配对码，签发设备令牌。支持 6 位纯数字 PIN 或 16 位字符码。返回明文令牌（仅此一次）。 */
  async redeem(code, { ttlMs, deviceName, platform }) {
    const now = Date.now();
    this.#prune(now);
    const parsed = parseCode(code);
    if (!parsed) return { ok: false, reason: 'malformed' };
    if (!this.#state.pairing) return { ok: false, reason: 'no_active_code' };

    let matches = false;
    if (parsed.type === 'pin' && this.#state.pairing.pinHash) {
      const presented = Buffer.from(sha256Hex(parsed.value), 'hex');
      const stored = Buffer.from(this.#state.pairing.pinHash, 'hex');
      matches = presented.length === stored.length && timingSafeEqual(presented, stored);
    } else if (parsed.type === 'code' && this.#state.pairing.codeHash) {
      const presented = Buffer.from(sha256Hex(parsed.value), 'hex');
      const stored = Buffer.from(this.#state.pairing.codeHash, 'hex');
      matches = presented.length === stored.length && timingSafeEqual(presented, stored);
    }

    if (!matches) {
      return { ok: false, reason: 'mismatch' };
    }

    // 与 login 同一条签发路径：同一台设备复用记录，只轮换 token。
    const { device, token } = this.#issueDevice({ name: deviceName, platform, ttlMs });
    // 配对码一次性消费。
    this.#state.pairing = null;
    await this.#persist();
    return { ok: true, device: this.#public(device), token };
  }

  /** 校验 Bearer 令牌；命中则刷新活跃时间并返回设备。 */
  verify(token) {
    if (!token) return null;
    const now = Date.now();
    this.#prune(now);
    const hash = sha256Hex(token);
    const device = this.#state.devices.find((d) => d.tokenHash === hash);
    if (!device) return null;
    device.lastSeenAt = now;
    void this.#persist();
    return this.#public(device);
  }

  rotate(deviceId) {
    const device = this.#state.devices.find((d) => d.id === deviceId);
    if (!device) return null;
    const token = randomBytes(32).toString('base64url');
    device.tokenHash = sha256Hex(token);
    device.lastSeenAt = Date.now();
    void this.#persist();
    return { device: this.#public(device), token };
  }

  rename(deviceId, name) {
    const device = this.#state.devices.find((d) => d.id === deviceId);
    if (!device) return null;
    device.name = String(name ?? '').trim().slice(0, 64) || device.name;
    void this.#persist();
    return this.#public(device);
  }

  revoke(deviceId) {
    const index = this.#state.devices.findIndex((d) => d.id === deviceId);
    if (index < 0) return false;
    this.#state.devices.splice(index, 1);
    void this.#persist();
    return true;
  }

  list() {
    this.#prune();
    return this.#state.devices.map((d) => this.#public(d));
  }

  #public(device) {
    const { tokenHash, ...rest } = device;
    void tokenHash;
    return { ...rest, online: this.#online?.(device.id) ?? false };
  }

  /** 由连接层注入，用于给设备列表打在线标记。 */
  setOnlineProbe(fn) {
    this.#online = fn;
  }

  flush() {
    return this.#writeChain;
  }
}