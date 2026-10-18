/**
 * ImageAttachmentLoader 的行为锁。
 *
 * 这一层负责"把主机的 attachmentId 变成能显示的 data URL"。
 * 三个真实风险必须有护栏：
 *
 * 1. **并发去重**：一条消息里同一张图出现两次 → 不能发两次请求（流量 + 慢）。
 * 2. **失败不缓存**：一次网络抖动不能让这张图**永久**打不开（否则用户重进会话也没救）。
 * 3. **跨会话不串图**：缓存 key 必须含 sessionId —— 不同会话可能有相同 attachmentId。
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-image-loader.mjs
 */
import { ImageAttachmentLoader, toDataUrl, DEFAULT_MAX_ENTRIES } from '../src/services/image-attachments.ts';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       期望: ${e}\n       实际: ${a}`);
  }
}

/** 造一个受控的 call：记录调用次数，可指定失败。 */
function makeCall({ failTimes = 0, data = 'QUJD' } = {}) {
  const calls = [];
  let remaining = failTimes;
  const call = async (method, args) => {
    calls.push({ method, args });
    if (remaining > 0) {
      remaining--;
      throw new Error('网络抖动');
    }
    return { attachment: { attachmentId: args.request.attachmentId }, data };
  };
  return { call, calls, get count() { return calls.length; } };
}

const opts = (call) => ({
  call,
  extractBase64: (r) => (r && typeof r.data === 'string' ? r.data : null),
  buildRequest: (sessionId, attachmentId) => ({ request: { sessionId, attachmentId } }),
});

console.log('\n[1] 基本取图');
{
  const c = makeCall({ data: 'QUJD' });
  const loader = new ImageAttachmentLoader(opts(c.call));
  const url = await loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  check('返回 data URL', url, 'data:image/png;base64,QUJD');
  check('请求方法名是斜杠形式', c.calls[0].method, 'session/attachment');
  check('args 用 request 包装', c.calls[0].args, { request: { sessionId: 's1', attachmentId: 'a1' } });
}

console.log('\n[2] 缓存：同图只取一次');
{
  const c = makeCall();
  const loader = new ImageAttachmentLoader(opts(c.call));
  await loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  await loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  check('两次 load 只发一次请求', c.count, 1);
  check('缓存命中数 1', loader.size, 1);
}

console.log('\n[3] 🔴 并发去重（同一张图同时出现两次）');
{
  const c = makeCall();
  const loader = new ImageAttachmentLoader(opts(c.call));
  const [u1, u2] = await Promise.all([
    loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' }),
    loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' }),
  ]);
  check('并发只发一次请求', c.count, 1);
  check('两次拿到同一个 URL', u1 === u2, true);
}

console.log('\n[4] 🔴 失败不缓存，可以重试');
{
  const c = makeCall({ failTimes: 1 });
  const loader = new ImageAttachmentLoader(opts(c.call));
  let threw = false;
  try {
    await loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  } catch {
    threw = true;
  }
  check('第一次失败会 reject', threw, true);
  check('失败后缓存为空', loader.size, 0);
  check('失败后无残留在途请求', loader.pending, 0);

  const url = await loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  check('重试成功', url, 'data:image/png;base64,QUJD');
  check('重试确实又发了请求', c.count, 2);
}

console.log('\n[5] 🔴 跨会话不串图（key 必须含 sessionId）');
{
  const c = makeCall();
  const loader = new ImageAttachmentLoader(opts(c.call));
  await loader.load('s1', { attachmentId: 'same-id', mediaType: 'image/png' });
  await loader.load('s2', { attachmentId: 'same-id', mediaType: 'image/png' });
  check('不同会话同 id → 各取一次', c.count, 2);
  check('第二个请求带的是 s2', c.calls[1].args.request.sessionId, 's2');
}

console.log('\n[6] 媒体类型白名单（防 data URL 被当 HTML 解析）');
check('png 放行', toDataUrl('QQ==', 'image/png'), 'data:image/png;base64,QQ==');
check('jpeg 放行', toDataUrl('QQ==', 'image/jpeg'), 'data:image/jpeg;base64,QQ==');
check('webp 放行', toDataUrl('QQ==', 'image/webp'), 'data:image/webp;base64,QQ==');
check('text/html 兜底为 png', toDataUrl('QQ==', 'text/html'), 'data:image/png;base64,QQ==');
check('空类型兜底为 png', toDataUrl('QQ==', ''), 'data:image/png;base64,QQ==');

console.log('\n[7] 参数校验与主机返回异常');
{
  const c = makeCall();
  const loader = new ImageAttachmentLoader(opts(c.call));
  let threw = false;
  try {
    await loader.load('', { attachmentId: 'a1', mediaType: 'image/png' });
  } catch {
    threw = true;
  }
  check('缺 sessionId → reject', threw, true);
  check('非法调用没发请求', c.count, 0);

  const broken = new ImageAttachmentLoader({
    call: async () => ({ attachment: {} }), // 没有 data
    extractBase64: (r) => (r && typeof r.data === 'string' ? r.data : null),
    buildRequest: (sessionId, attachmentId) => ({ request: { sessionId, attachmentId } }),
  });
  let threw2 = false;
  try {
    await broken.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  } catch {
    threw2 = true;
  }
  check('主机不返回 data → reject', threw2, true);
}

console.log('\n[8] LRU 上限（内存保护）');
{
  const c = makeCall();
  const loader = new ImageAttachmentLoader({ ...opts(c.call), maxEntries: 2 });
  await loader.load('s1', { attachmentId: 'a1', mediaType: 'image/png' });
  await loader.load('s1', { attachmentId: 'a2', mediaType: 'image/png' });
  await loader.load('s1', { attachmentId: 'a3', mediaType: 'image/png' });
  check('超出上限后只留 2 条', loader.size, 2);
  check('最旧的 a1 被淘汰', loader.peek('s1', 'a1'), null);
  check('最新的 a3 还在', loader.peek('s1', 'a3'), 'data:image/png;base64,QUJD');
}

console.log('\n[9] peek 不触发加载');
{
  const c = makeCall();
  const loader = new ImageAttachmentLoader(opts(c.call));
  check('未加载时 peek 为 null', loader.peek('s1', 'a1'), null);
  check('peek 没发请求', c.count, 0);
}

check('默认上限是正数', DEFAULT_MAX_ENTRIES > 0, true);

console.log(`\n${fail === 0 ? '✅' : '❌'} test-image-loader: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
