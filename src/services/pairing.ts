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
    // 🔴 先确认输入是**完整的绝对地址**再探测。
    //
    // 用户在输入框里逐字删除默认值时，会经过 `http`、`http:` 这类中间态；
    // 旧写法直接 `${baseUrl}/mobile-gateway/health` 拼接，于是产生相对路径，
    // 在 WebView（页面来自 file:///android_asset/web/）里被解析成
    // `file:///android_asset/web/http/mobile-gateway/health`，
    // 每敲一个字就发一条必然失败的请求（真机实测的 console 噪音）。
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    try {
      const url = parsed.toString().replace(/\/+$/, '') + '/mobile-gateway/health';
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

    // 🔴 演示模式才允许伪造凭据（2026-10-14 修正）
    //
    // 原判据是 `cleanUrl.includes('demo') || username === 'demo'`，
    // 会**在本地凭空造一个 token**，用户以为登录成功了 —— 实际**什么都没发生**，
    // 没有任何鉴权、没有触达电脑。这是最危险的一类"假成功"。
    // 现在只在显式 `VITE_DEMO_MODE=true` 时启用。
    if (DEMO_MODE && (cleanUrl.includes('demo') || username.toLowerCase() === 'demo')) {
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

    // 🔴 演示模式才允许伪造凭据（2026-10-14 修正）
    //
    // 原判据含 `code === '123456'` —— 用户真输入这个码会拿到**本地伪造的 token**，
    // 界面显示"配对成功"，但实际上**从未与电脑通信**。
    if (DEMO_MODE && (cleanUrl.includes('demo') || code.toLowerCase().includes('demo') || code === '123456')) {
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
