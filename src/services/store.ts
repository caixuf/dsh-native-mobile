// `import type`：`../types` 无运行时导出，值导入会让 Node 直跑 src/ 的测试在链接期失败
import type { HostRecord } from '../types';
import { DEMO_MODE } from './demo';

const STORAGE_KEY = 'dsh_hosts_v1';
const ACTIVE_HOST_KEY = 'dsh_active_host_id';

/**
 * 演示用主机 —— **只在 [DEMO_MODE] 开启时才会被使用**。
 *
 * 🔴 2026-10-14 修正：此前它在 `all()` 的**三条路径**上被返回：
 *   ① 首次运行（无数据时主动写入）
 *   ② 解析出的数组为空
 *   ③ 任何异常（catch 分支）
 *
 * 后果是**静默的假成功**：全新安装的用户会看到一台并不存在的
 * 「MacBook Pro (Demo 实例)」，界面一切正常 —— 但它连的不是他的电脑。
 * 这种失败比直接报错难查得多（而且掩盖了真实的存储/连接错误）。
 *
 * 现在：**只有显式设了 `VITE_DEMO_MODE=true` 才回退到它**；
 * 否则如实返回空列表，让用户走正常的「配对电脑」流程。
 */
const DEFAULT_DEMO_HOST: HostRecord = {
  id: 'demo-local-host',
  label: 'MacBook Pro (Demo 实例)',
  baseUrl: 'http://127.0.0.1:4142',
  token: 'dsh_demo_token_3a7b9c1d2e',
  deviceId: 'web-companion-device-01',
  instanceName: 'MacBook Pro M3 Max (本地)',
  pairedAt: Date.now() - 86400000 * 2,
  lastUsedAt: Date.now(),
};

export const HostStore = {
  all(): HostRecord[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // 无数据：仅演示模式才注入假主机，否则返回空（用户该看到"请配对"）
      if (!raw) {
        if (DEMO_MODE) {
          const initial = [DEFAULT_DEMO_HOST];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
          return initial;
        }
        return [];
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
      // 空数组：演示模式给假主机，否则就是"没有已配对电脑"
      return DEMO_MODE ? [DEFAULT_DEMO_HOST] : [];
    } catch (error) {
      // 读失败要**暴露**而不是伪装成"有一台演示机"。
      console.error('[HostStore] 读取已配对电脑失败：', error);
      return DEMO_MODE ? [DEFAULT_DEMO_HOST] : [];
    }
  },

  find(id: string): HostRecord | undefined {
    return this.all().find((h) => h.id === id);
  },

  upsert(record: HostRecord): void {
    const next = this.all().filter((h) => h.id !== record.id);
    next.unshift(record);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  },

  touch(id: string): void {
    const record = this.find(id);
    if (record) {
      this.upsert({ ...record, lastUsedAt: Date.now() });
    }
  },

  remove(id: string): void {
    const next = this.all().filter((h) => h.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (this.getActiveId() === id) {
      this.setActiveId(next[0]?.id || null);
    }
  },

  rename(id: string, label: string): void {
    const record = this.find(id);
    if (record) {
      this.upsert({ ...record, label });
    }
  },

  getActiveId(): string | null {
    const saved = localStorage.getItem(ACTIVE_HOST_KEY);
    if (saved && this.find(saved)) {
      return saved;
    }
    const all = this.all();
    const first = all[0]?.id || null;
    if (first) {
      localStorage.setItem(ACTIVE_HOST_KEY, first);
    }
    return first;
  },

  setActiveId(id: string | null): void {
    if (id) {
      localStorage.setItem(ACTIVE_HOST_KEY, id);
      this.touch(id);
    } else {
      localStorage.removeItem(ACTIVE_HOST_KEY);
    }
  },
};
