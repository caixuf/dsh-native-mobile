/**
 * 原生壳桥接（NativeBridge）契约与多端降级测试。
 *
 * 覆盖移动端 Android WebView 壳与桌面 Electron 壳的通讯边界：
 *   1. 多端平台自适应检测（android / electron / web）
 *   2. 后台提醒能力判定（supportsBackgroundAlerts，向用户诚实暴露普通浏览器无后台推送）
 *   3. Android 原生桥交互与容错（setConnection、reconnect、status、脏数据解析安全）
 *   4. 返回键与深链处理器安装与注销（installBackHandler、installDeepLinkHandler）
 *   5. 原生异常拦截隔离（Native 接口抛出运行时异常时不把前端 JS 线程炸死）
 *   6. 待处理深链安全提取（takePendingDeepLink 消费语义）
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-native-bridge.mjs
 */

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

console.log('NativeBridge 原生桥接与多端降级测试');
console.log('──────────────────────────────────────────────────');

check('1. 纯 Web 环境下平台判定为 web，后台提醒能力为 false', () => {
  globalThis.window = {};
  eq(NativeBridge.platform(), 'web');
  eq(NativeBridge.supportsBackgroundAlerts(), false, '普通网页不得虚标支持后台提醒');
  eq(NativeBridge.status().available, false);
  eq(NativeBridge.status().platform, 'web');
});

check('2. 识别 Android 原生 WebView 壳（DSHNative 注入）', () => {
  globalThis.window = {
    DSHNative: {
      setConnection: () => '{}',
    },
  };
  eq(NativeBridge.platform(), 'android');
  eq(NativeBridge.supportsBackgroundAlerts(), true, 'Android 原生壳支持后台中继服务');
});

check('3. 识别 Electron 桌面壳（dshDesktop 注入）', () => {
  globalThis.window = {
    dshDesktop: {
      notifyApproval: () => true,
    },
  };
  eq(NativeBridge.platform(), 'electron');
  eq(NativeBridge.supportsBackgroundAlerts(), true, 'Electron 壳支持桌面通知后台提醒');
});

check('4. publishConnection 正确向 Android 壳下发主机配置并解析返回状态', () => {
  let passedBaseUrl = '';
  let passedToken = '';
  let passedLabel = '';

  globalThis.window = {
    DSHNative: {
      setConnection(url, tok, lbl) {
        passedBaseUrl = url;
        passedToken = tok;
        passedLabel = lbl;
        return JSON.stringify({
          configured: true,
          state: 'connected',
          notificationsEnabled: true,
          clientId: 'client-999',
        });
      },
    },
  };

  const status = NativeBridge.publishConnection('http://192.168.1.10:19387', 'token-123', 'Work PC');
  ok(status !== null);
  eq(passedBaseUrl, 'http://192.168.1.10:19387');
  eq(passedToken, 'token-123');
  eq(passedLabel, 'Work PC');
  eq(status.state, 'connected');
  eq(status.clientId, 'client-999');
  eq(status.notificationsEnabled, true);
});

check('5. Android 原生桥返回非 JSON 脏数据或抛异常时，安全兜底不崩溃', () => {
  globalThis.window = {
    DSHNative: {
      setConnection() {
        return 'not a valid json string {}{';
      },
      clearConnection() {
        throw new Error('Android bridge unexpected exception');
      },
      status() {
        return null;
      },
    },
  };

  const status = NativeBridge.publishConnection('http://1.1.1.1', 'tok', 'lbl');
  ok(status !== null);
  eq(status.configured, false, '脏数据应平滑降级为未配置状态');

  // clearConnection 异常不得向外抛出导致 UI 崩溃
  NativeBridge.clearConnection();
});

check('6. installBackHandler 与 installDeepLinkHandler 正确挂载 window 钩子并包裹异常', () => {
  globalThis.window = {
    DSHNative: {
      setConnection: () => '{}',
    },
  };

  const backHandler = () => true;
  NativeBridge.installBackHandler(backHandler);
  ok(typeof globalThis.window.dshHandleBack === 'function');
  eq(globalThis.window.dshHandleBack(), true);

  // 抛出异常时安全兜底返回 false
  NativeBridge.installBackHandler(() => {
    throw new Error('boom');
  });
  eq(globalThis.window.dshHandleBack(), false, '返回键抛出异常时兜底返回 false 给原生');

  const deepLinkHandler = (link) => link.eventId === 'ev-test';
  NativeBridge.installDeepLinkHandler(deepLinkHandler);
  ok(typeof globalThis.window.dshNativeOnDeepLink === 'function');
  eq(globalThis.window.dshNativeOnDeepLink({ eventId: 'ev-test' }), true);
  eq(globalThis.window.dshNativeOnDeepLink({ eventId: 'other' }), false);
});

check('7. takePendingDeepLink 安全提取待处理深链载荷', () => {
  globalThis.window = {
    DSHNative: {
      setConnection: () => '{}',
      takePendingDeepLink: () => JSON.stringify({ pending: true, eventId: 'ev-123', sessionId: 'sess-456' }),
    },
  };

  const deepLink = NativeBridge.takePendingDeepLink();
  ok(deepLink !== null);
  eq(deepLink.pending, true);
  eq(deepLink.eventId, 'ev-123');
  eq(deepLink.sessionId, 'sess-456');

  // 模拟深链未就绪
  globalThis.window.DSHNative.takePendingDeepLink = () => JSON.stringify({ pending: false });
  eq(NativeBridge.takePendingDeepLink()?.pending, false);

  // 模拟无原生桥
  delete globalThis.window.DSHNative;
  eq(NativeBridge.takePendingDeepLink(), null);
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：NativeBridge 原生桥接契约全部达成`);
}
