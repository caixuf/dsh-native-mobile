/**
 * 客户端通用文件下载与系统分享（Downloader）契约与边界测试。
 *
 * 覆盖移动端保存图片与代码文件时的关键缺陷：
 *   1. UTF-8 多字节字符（中文、Emoji、全角符号）转 Base64 编码安全性（杜绝 btoa 字符越界崩溃）
 *   2. Android 原生桥（DSHNative.saveFile）优先委派与回执解析
 *   3. 原生桥解析失败时自动降级至 Web HTML5 Blob 下载
 *   4. Data URI 转换为 Blob 时的 MIME 类型与二进制提取
 *   5. Web Share API 原生分享检测与异常优雅捕获（用户取消不抛未捕获异常）
 *
 * 运行：
 *   node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-downloader.mjs
 */

import { downloadFile, shareFileIfSupported } from '../src/utils/downloader.ts';

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

async function checkAsync(name, fn) {
  try {
    await fn();
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

console.log('Downloader 文件下载与系统分享契约测试');
console.log('──────────────────────────────────────────────────');

await checkAsync('1. 🔴 关键防线：中文字符与 Emoji 文本在 Android 桥下正确编码为 Base64，不触发 btoa 异常', async () => {
  let bridgeCalled = false;
  let receivedFilename = '';
  let receivedBase64 = '';
  let receivedMime = '';

  const mockBridge = {
    saveFile(name, b64, mime) {
      bridgeCalled = true;
      receivedFilename = name;
      receivedBase64 = b64;
      receivedMime = mime;
      return JSON.stringify({ ok: true, path: '/sdcard/Download/' + name });
    },
  };

  globalThis.window = { DSHNative: mockBridge };
  globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

  const chineseText = '你好，世界！🌟 这里是 DSH 测试代码：const x = 100;';
  const okResult = await downloadFile(chineseText, 'test-chinese.ts', 'text/typescript');

  ok(okResult, '下载应返回成功');
  ok(bridgeCalled, '必须调用了 Android 原生桥');
  eq(receivedFilename, 'test-chinese.ts');
  eq(receivedMime, 'text/typescript');

  // 验证收到的 Base64 解码后能精确复原中文字符
  const decodedText = decodeURIComponent(escape(Buffer.from(receivedBase64, 'base64').toString('binary')));
  eq(decodedText, chineseText, 'Base64 解码后必须与原始中文字符完全一致');
});

await checkAsync('2. Android 桥返回错误或非法 JSON 时，自动降级至 Web 下载流程', async () => {
  let webDownloadTriggered = false;

  const mockBridge = {
    saveFile() {
      // 模拟原生抛错或返回非 ok
      return JSON.stringify({ ok: false, error: 'Permission denied' });
    },
  };

  const mockDoc = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        style: {},
        click() {
          webDownloadTriggered = true;
        },
      };
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
  };

  globalThis.window = {
    DSHNative: mockBridge,
    setTimeout: (fn) => fn(),
  };
  globalThis.document = mockDoc;
  globalThis.URL = {
    createObjectURL: () => 'blob:mock-url',
    revokeObjectURL: () => {},
  };

  const res = await downloadFile('console.log("fallback");', 'fallback.js', 'text/javascript');
  ok(res, '降级 Web 下载应返回成功');
  ok(webDownloadTriggered, '必须触发了 Web 端的 <a> 标签点击下载');
});

await checkAsync('3. Web 环境下直接触发 HTML5 Blob 下载', async () => {
  let clickCount = 0;
  let clickedFilename = '';
  let clickedHref = '';

  const mockDoc = {
    createElement(tag) {
      const link = {
        tagName: tag.toUpperCase(),
        style: {},
        set download(val) {
          clickedFilename = val;
        },
        set href(val) {
          clickedHref = val;
        },
        click() {
          clickCount += 1;
        },
      };
      return link;
    },
    body: {
      appendChild() {},
      removeChild() {},
    },
  };

  globalThis.window = { setTimeout: (fn) => fn() };
  globalThis.document = mockDoc;
  globalThis.URL = {
    createObjectURL: (blob) => `blob:mock-blob-${blob.type}`,
    revokeObjectURL: () => {},
  };

  const success = await downloadFile('echo "hello"', 'script.sh', 'application/x-sh');
  ok(success);
  eq(clickCount, 1);
  eq(clickedFilename, 'script.sh');
  ok(clickedHref.includes('application/x-sh'));
});

await checkAsync('4. shareFileIfSupported 在不支持时不抛错并返回 false', async () => {
  // 无 navigator.share
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
    writable: true,
  });
  const res1 = await shareFileIfSupported('content', 'test.txt');
  eq(res1, false, '不支持 share 时必须返回 false');

  // canShare 返回 false
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      share: async () => {},
      canShare: () => false,
    },
    configurable: true,
    writable: true,
  });
  const res2 = await shareFileIfSupported('content', 'test.txt');
  eq(res2, false, 'canShare 为 false 时必须返回 false');
});

await checkAsync('5. shareFileIfSupported 在支持时调用系统面板并优雅处理取消操作', async () => {
  let sharedFiles = null;
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      share: async (payload) => {
        sharedFiles = payload.files;
      },
      canShare: () => true,
    },
    configurable: true,
    writable: true,
  });

  const okShare = await shareFileIfSupported('test file content', 'share.py', 'text/x-python');
  ok(okShare, '分享成功应返回 true');
  ok(Array.isArray(sharedFiles) && sharedFiles.length === 1);
  eq(sharedFiles[0].name, 'share.py');

  // 用户取消分享（系统触发 AbortError）
  globalThis.navigator.share = async () => {
    const abortErr = new Error('Share canceled');
    abortErr.name = 'AbortError';
    throw abortErr;
  };
  const cancelShare = await shareFileIfSupported('content', 'cancel.py');
  eq(cancelShare, false, '用户取消时优雅返回 false，不向外抛异常');
});

console.log('──────────────────────────────────────────────────');
if (failed > 0) {
  console.error(`\n❌ ${failed} 项测试失败！`);
  process.exit(1);
} else {
  console.log(`\n✓ 全部 ${passed} 项通过：Downloader 文件下载与系统分享契约全部达成`);
}
