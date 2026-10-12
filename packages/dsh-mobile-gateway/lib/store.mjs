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

function formatCode(body) {
  return `dshm1.${body.match(/.{1,4}/g).join('-')}`;
}

function parseCode(input) {
  const normalized = String(input ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  const body = normalized.startsWith('DSHM1.') ? normalized.slice(6) : normalized;
  if (body.length !== 16) return null;
  for (const ch of body) if (!CODE_ALPHABET.includes(ch)) return null;
  return body;
}

export class DeviceStore {
  #file;
  #log;
  #state = { version: 2, devices: [], pairing: null };
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

  /** 铸造一枚新的配对码；旧码立即作废。 */
  async mintPairing({ ttlMs, origin }) {
    const now = Date.now();
    this.#prune(now);
    const body = randomCode(16);
    this.#state.pairing = {
      codeHash: sha256Hex(body),
      display: formatCode(body),
      createdAt: now,
      expiresAt: now + ttlMs,
      origin: origin ?? null,
    };
    await this.#persist();
    return { ...this.#state.pairing };
  }

  /** 当前配对码的公开视图（不含摘要）。脱敏返回。 */
  currentPairing(now = Date.now()) {
    this.#prune(now);
    if (!this.#state.pairing) return null;
    const { codeHash, ...rest } = this.#state.pairing;
    void codeHash;
    return rest;
  }

  /** 消费配对码，签发设备令牌。返回明文令牌（仅此一次）。 */
  async redeem(code, { ttlMs, deviceName, platform }) {
    const now = Date.now();
    this.#prune(now);
    const body = parseCode(code);
    if (!body) return { ok: false, reason: 'malformed' };
    if (!this.#state.pairing) return { ok: false, reason: 'no_active_code' };

    const presented = Buffer.from(sha256Hex(body), 'hex');
    const stored = Buffer.from(this.#state.pairing.codeHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return { ok: false, reason: 'mismatch' };
    }

    const token = randomBytes(32).toString('base64url');
    const device = {
      id: `dev_${randomBytes(9).toString('base64url')}`,
      name: (deviceName ?? '').trim().slice(0, 64) || 'Android',
      platform: (platform ?? '').trim().slice(0, 32) || 'android',
      tokenHash: sha256Hex(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ttlMs,
    };
    this.#state.devices.push(device);
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