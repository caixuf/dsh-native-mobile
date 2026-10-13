import { HostRecord } from '../types';

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
    try {
      const url = baseUrl.replace(/\/+$/, '') + '/mobile-gateway/health';
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.ok) {
        return data.instance?.name || baseUrl;
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

    // Allow mock demo account for instant onboarding
    if (cleanUrl.includes('demo') || username.toLowerCase() === 'demo') {
      return {
        id: 'host-' + Date.now(),
        label: `${username} 的电脑 (Demo)`,
        baseUrl: cleanUrl || 'http://127.0.0.1:4142',
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

    return {
      id: 'host-' + Date.now(),
      label: body.instance?.name || baseUrl,
      baseUrl: cleanUrl,
      token: body.token,
      deviceId: body.device?.id || 'unknown',
      instanceName: body.instance?.name || '',
      pairedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  },

  async pair(baseUrl: string, code: string, deviceName: string): Promise<HostRecord> {
    const cleanUrl = baseUrl.replace(/\/+$/, '');

    if (cleanUrl.includes('demo') || code.toLowerCase().includes('demo') || code === '123456') {
      return {
        id: 'host-' + Date.now(),
        label: `已配对工作电脑 (Demo)`,
        baseUrl: cleanUrl || 'http://127.0.0.1:4142',
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

    return {
      id: 'host-' + Date.now(),
      label: body.instance?.name || baseUrl,
      baseUrl: cleanUrl,
      token: body.token,
      deviceId: body.device?.id || 'unknown',
      instanceName: body.instance?.name || '',
      pairedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  },
};
