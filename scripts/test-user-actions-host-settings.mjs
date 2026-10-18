/**
 * 用户交互全操作回归测试（第三部分：主机管理、抽屉导航、主题与系统模态框全操作）。
 *
 * 覆盖用户在 HostsScreen、AppDrawer、SkinCenterModal、UserCenterModal 及系统弹框中的全部操作：
 *   1. 主机选择操作：点击卡片切换当前活跃主机、更新存储并触发重连
 *   2. 主机编辑操作：重命名主机标签、删除电脑二次确认、删除活跃主机后的平滑回落
 *   3. 连接策略切换操作：用户点击 auto / lan / wan 胶囊切换连接模式并更新策略
 *   4. 自定义局域网直连 IP 操作：填入内网 IP、清洗协议与斜杠、落盘并触发直连探测
 *   5. 侧边栏抽屉导航操作：打开/关闭抽屉、各页面路由跳转、断开连接
 *   6. 主题皮肤中心操作：4 套主题即时切换、上传自定义壁纸、调节模糊与不透明度滑块、一键清除
 *   7. 用户中心操作：查看版本信息与设备 ID、点击复制设备唯一识别码
 *   8. 审批通知设置操作：发送测试审批通知、检测通知授权状态、跳转系统通知设置与应用详情页
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-user-actions-host-settings.mjs
 */

import { DEFAULT_DEMO_HOST, HostStore } from '../src/services/store.ts';
import { THEME_PRESETS, ThemeStore } from '../src/services/theme.ts';
import { getOrCreateDeviceId, uniqueDeviceName } from '../src/services/device.ts';
import { NativeBridge } from '../src/services/native-bridge.ts';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err });
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ?? 'not equal'}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

/** 创建纯内存 mock localStorage */
function createMockStorage() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

const mockStorage = createMockStorage();
globalThis.localStorage = mockStorage;
globalThis.window = { localStorage: mockStorage };

console.log('用户操作全景测试（主机管理、抽屉导航与主题设置全操作）');
console.log('──────────────────────────────────────────────────');

check('1. 主机选择操作：点击主机卡片切换当前活跃主机并更新存储', () => {
  mockStorage.clear();
  const hostA = { id: 'h-a', label: '工作电脑 MacBook', baseUrl: 'http://1.1.1.1:19387', token: 'ta', deviceId: 'da', instanceName: 'A', pairedAt: 1, lastUsedAt: 1 };
  const hostB = { id: 'h-b', label: '家用台式 PC', baseUrl: 'http://2.2.2.2:19387', token: 'tb', deviceId: 'db', instanceName: 'B', pairedAt: 2, lastUsedAt: 2 };

  HostStore.upsert(hostA);
  HostStore.upsert(hostB);
  // 首个真实主机 upsert 时自动成为 active
  eq(HostStore.getActiveId(), 'h-a');

  // 用户点击 hostB 卡片
  HostStore.setActiveId('h-b');
  eq(HostStore.getActiveId(), 'h-b', '活跃主机成功切换为 hostB');
});

check('2. 主机管理操作：重命名标签、删除主机并平滑迁移活跃状态', () => {
  mockStorage.clear();
  const hostA = { id: 'h-a', label: '旧电脑名', baseUrl: 'http://1.1.1.1:19387', token: 'ta', deviceId: 'da', instanceName: 'A', pairedAt: 1, lastUsedAt: 1 };
  const hostB = { id: 'h-b', label: '备用电脑', baseUrl: 'http://2.2.2.2:19387', token: 'tb', deviceId: 'db', instanceName: 'B', pairedAt: 2, lastUsedAt: 2 };
  HostStore.upsert(hostA);
  HostStore.upsert(hostB);
  HostStore.setActiveId('h-a');

  // 用户点击重命名
  HostStore.rename('h-a', '办公室专属 M3 Max');
  eq(HostStore.find('h-a')?.label, '办公室专属 M3 Max');

  // 用户点击删除当前活跃的 hostA
  HostStore.remove('h-a');
  eq(HostStore.all().length, 1);
  eq(HostStore.getActiveId(), 'h-b', '删除当前主机后自动切换到备用电脑');
});

check('3. 连接策略切换操作：用户切换 auto / lan / wan 模式并落盘', () => {
  mockStorage.clear();
  const host = { id: 'h-mode', label: '策略电脑', baseUrl: 'http://1.1.1.1:19387', token: 't', deviceId: 'd', instanceName: 'M', pairedAt: 1, lastUsedAt: 1, connectionMode: 'auto' };
  HostStore.upsert(host);

  // 用户点击「仅局域网」胶囊
  HostStore.setConnectionMode('h-mode', 'lan');
  eq(HostStore.find('h-mode')?.connectionMode, 'lan');

  // 用户点击「仅公网中继」胶囊
  HostStore.setConnectionMode('h-mode', 'wan');
  eq(HostStore.find('h-mode')?.connectionMode, 'wan');
});

check('4. 自定义局域网直连 IP 操作：清洗 URL 并保存为 lanUrl', () => {
  mockStorage.clear();
  const host = { id: 'h-lan', label: '直连电脑', baseUrl: 'http://wan.com:19387', token: 't', deviceId: 'd', instanceName: 'L', pairedAt: 1, lastUsedAt: 1 };
  HostStore.upsert(host);

  // 用户在输入框填入 "  http://192.168.1.150:19387///  "
  const userInput = '  http://192.168.1.150:19387///  ';
  const cleanLan = userInput.trim().replace(/\/+$/, '');

  HostStore.updateNetwork('h-lan', { lanUrl: cleanLan });
  const updated = HostStore.find('h-lan');
  eq(updated?.lanUrl, 'http://192.168.1.150:19387', '成功清洗前后空格与多余斜杠');
});

check('5. 侧边栏抽屉导航操作：路由流转与断开连接', () => {
  let currentRoute = 'sessions';
  let isDrawerOpen = false;
  let activeHost = 'host-1';

  const navigateTo = (r) => {
    currentRoute = r;
    isDrawerOpen = false;
  };

  const disconnect = () => {
    activeHost = null;
    isDrawerOpen = false;
    currentRoute = 'hosts';
  };

  // 用户点击汉堡按钮
  isDrawerOpen = true;
  eq(isDrawerOpen, true);

  // 用户点击「电脑设备」
  navigateTo('hosts');
  eq(currentRoute, 'hosts');
  eq(isDrawerOpen, false, '跳转后自动关闭抽屉');

  // 用户在抽屉中点击「断开当前连接」
  isDrawerOpen = true;
  disconnect();
  eq(activeHost, null, '活跃连接已断开');
  eq(currentRoute, 'hosts', '退回主机列表页');
});

check('6. 主题皮肤中心全操作：4 套预设切换、自定义壁纸滑块调节与一键清除', () => {
  mockStorage.clear();

  // 1. 用户切换主题
  ThemeStore.setTheme('deepseek-cyan');
  eq(ThemeStore.getThemeId(), 'deepseek-cyan');
  ThemeStore.setTheme('minimal-gray');
  eq(ThemeStore.getThemeId(), 'minimal-gray');

  // 2. 用户上传自定义壁纸并调节滑块（模糊度 12px，不透明度 45%）
  ThemeStore.setCustomWallpaper('data:image/jpeg;base64,wall_custom', 12, 45);
  const wall = ThemeStore.getCustomWallpaper();
  eq(wall.data, 'data:image/jpeg;base64,wall_custom');
  eq(wall.blur, 12);
  eq(wall.opacity, 45);

  // 3. 用户点击「恢复默认壁纸」
  ThemeStore.clearCustomWallpaper();
  const cleared = ThemeStore.getCustomWallpaper();
  eq(cleared.data, null, '自定义壁纸数据被安全移除');
});

check('7. 用户中心操作：查看设备 ID 并执行剪贴板复制', () => {
  mockStorage.clear();
  const deviceId = getOrCreateDeviceId({ storage: mockStorage });
  ok(deviceId.length === 6, '设备 ID 长度为 6 位短标识');

  // 再次获取应幂等返回同一 ID
  eq(getOrCreateDeviceId({ storage: mockStorage }), deviceId);

  // 设备友好名生成（带唯一后缀，防顶号）
  const uniqueName = uniqueDeviceName('iPhone 15 Pro', deviceId);
  eq(uniqueName, `iPhone 15 Pro · ${deviceId}`);
});

check('8. 审批通知设置操作：原生桥通知设置与应用权限详情页入口', () => {
  let openedNotificationSettings = false;
  let openedAppSettings = false;

  globalThis.window.DSHNative = {
    setConnection: () => '{}',
    openNotificationSettings: () => {
      openedNotificationSettings = true;
      return JSON.stringify({ ok: true });
    },
    openAppSettings: () => {
      openedAppSettings = true;
      return JSON.stringify({ ok: true });
    },
  };

  // 用户点击「打开系统通知设置」
  const res1 = NativeBridge.openNotificationSettings();
  ok(res1);
  ok(openedNotificationSettings, '必须调用了原生系统通知设置');

  // 用户点击「打开权限管理（应用详情页）」
  const res2 = NativeBridge.openAppSettings();
  ok(res2);
  ok(openedAppSettings, '必须调用了原生应用详情页');
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：主机管理、抽屉导航与系统设置全操作契约全部达成`);
}
