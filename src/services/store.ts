import { HostRecord } from '../types';

const STORAGE_KEY = 'dsh_hosts_v1';
const ACTIVE_HOST_KEY = 'dsh_active_host_id';

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
      if (!raw) {
        // Seed with demo host for immediate interactivity if empty
        const initial = [DEFAULT_DEMO_HOST];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
        return initial;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
      return [DEFAULT_DEMO_HOST];
    } catch {
      return [DEFAULT_DEMO_HOST];
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
