// `import type`：`../types` 无运行时导出，值导入会让 Node 直跑 src/ 的测试在链接期失败
import type { HostRecord } from '../types';
import { DEMO_MODE } from './demo';

export interface PairingTarget {
  baseUrl: string;
  code: string;
}

export const PairingClient = {
  parsePairingTarget(raw: string): PairingTarget | null {
    const text = raw.trim();
    const hash = text.indexOf('#');
    const urlPart = hash >= 0 ? text.substring(0, hash) : text;
    const code = hash >= 0 ? text.substring(hash + 1) : '';
    const baseMatch = urlPart.split('/mobile-gateway/')[0]?.replace(/\/+$/, '');
    if (!baseMatch || (!baseMatch.startsWith('http://') && !baseMatch.startsWith('https://'))) {
      return null;
    }
    return { baseUrl: baseMatch, code };
  },

  async probe(baseUrl: string): Promise<string | null> {
    const detail = await this.probeDetail(baseUrl);
    return detail?.name ?? null;
  },

  async probeDetail(baseUrl: string): Promise<{ name: string; lanAddresses?: string[] } | null> {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    try {
      const url = parsed.toString().replace(/\/+$/, '') + '/mobile-gateway/health';
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 3500) : null;
      const res = await fetch(url, {
        method: 'GET',
        signal: controller ? controller.signal : undefined,
      });
      if (timeout) clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.ok) {
        return {
          name: data.instance?.name || baseUrl,
          lanAddresses: Array.isArray(data.lanAddresses) ? data.lanAddresses : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  },

  async login(
    baseUrl: string,
    username: string,
    password: string,
    deviceName: string,
  ): Promise<HostRecord> {
    const cleanUrl = baseUrl.replace(/\/+$/, '');

    // 🔴 演示模式才允许伪造凭据（2026-10-14 修正）
    if (DEMO_MODE && (cleanUrl.includes('demo') || username.toLowerCase() === 'demo')) {
      return {
        id: 'host-' + Date.now(),
        label: `${username} 的电脑 (Demo)`,
        baseUrl: cleanUrl || 'http://127.0.0.1:4142',
        lanUrl: 'http://127.0.0.1:4142',
        connectionMode: 'auto',
        token: 'dsh_token_' + Math.random().toString(36).slice(2, 12),
        deviceId: 'device-' + Math.random().toString(36).slice(2, 8),
        instanceName: 'MacBook Pro M3 Max',
        pairedAt: Date.now(),
        lastUsedAt: Date.now(),
      };
    }

    const url = cleanUrl + '/mobile-gateway/login';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.trim(),
        password,
        deviceName,
        platform: 'web',
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error?.message || `登录失败 (HTTP ${res.status})`);
    }

    const lanAddresses: string[] = Array.isArray(body.lanAddresses) ? body.lanAddresses : [];
    const isInputLan = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.0\.0\.1|localhost)/.test(cleanUrl);
    const lanUrl = isInputLan ? cleanUrl : lanAddresses[0];

    return {
      id: 'host-' + Date.now(),
      label: body.instance?.name || baseUrl,
      baseUrl: cleanUrl,
      lanUrl: lanUrl || undefined,
      lanAddresses: lanAddresses.length > 0 ? lanAddresses : undefined,
      connectionMode: 'auto',
      token: body.token,
      deviceId: body.device?.id || 'unknown',
      instanceName: body.instance?.name || '',
      pairedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  },

  async pair(baseUrl: string, code: string, deviceName: string): Promise<HostRecord> {
    const cleanUrl = baseUrl.replace(/\/+$/, '');

    // 🔴 演示模式才允许伪造凭据（2026-10-14 修正）
    if (DEMO_MODE && (cleanUrl.includes('demo') || code.toLowerCase().includes('demo') || code === '123456')) {
      return {
        id: 'host-' + Date.now(),
        label: `已配对工作电脑 (Demo)`,
        baseUrl: cleanUrl || 'http://127.0.0.1:4142',
        lanUrl: 'http://127.0.0.1:4142',
        connectionMode: 'auto',
        token: 'dsh_token_' + Math.random().toString(36).slice(2, 12),
        deviceId: 'device-' + Math.random().toString(36).slice(2, 8),
        instanceName: 'MacBook Pro M3 Max',
        pairedAt: Date.now(),
        lastUsedAt: Date.now(),
      };
    }

    const url = cleanUrl + '/mobile-gateway/pair';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: code.trim(),
        deviceName,
        platform: 'web',
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error?.message || `配对失败 (HTTP ${res.status})`);
    }

    const lanAddresses: string[] = Array.isArray(body.lanAddresses) ? body.lanAddresses : [];
    const isInputLan = /^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.0\.0\.1|localhost)/.test(cleanUrl);
    const lanUrl = isInputLan ? cleanUrl : lanAddresses[0];

    return {
      id: 'host-' + Date.now(),
      label: body.instance?.name || baseUrl,
      baseUrl: cleanUrl,
      lanUrl: lanUrl || undefined,
      lanAddresses: lanAddresses.length > 0 ? lanAddresses : undefined,
      connectionMode: 'auto',
      token: body.token,
      deviceId: body.device?.id || 'unknown',
      instanceName: body.instance?.name || '',
      pairedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  },
};
