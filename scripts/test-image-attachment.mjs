/**
 * 主机图片附件通路的行为锁（2026-10-17 补）。
 *
 * ## 为什么必须有这个测试
 *
 * 真机实测：主机返回的图片是**附件引用**而不是 URL：
 * ```
 * { type:'image', attachment:{ attachmentId, mediaType, bytes, width, height } }
 * ```
 * 旧实现把非 text 块一律跳过，后果有两层，**第二层比第一层严重得多**：
 *
 * 1. 有图有文 → 图片位置什么都没有（用户看到"图片丢了"）；
 * 2. **纯图片消息 → text 为空 → `eventToLine` 返回 null → 整条消息连气泡都不出现。**
 *    用户发一张图，聊天里看起来像"我什么都没发"。
 *
 * 第 2 层是静默的：不报错、不占位。所以这条通路必须有护栏，
 * 否则下次重构 `collectMessageText` 会再次把它吃掉而没人发现。
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-resolve-hook.mjs scripts/test-image-attachment.mjs
 */
import {
  eventToLine,
  collectImageRefs,
  collectMessageText,
  attachmentRequest,
  attachmentBase64,
} from '../src/lib/session-page.ts';

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

/** 主机真实形状（取自 app.asar 里的 ImageAttachmentRef zod schema）。 */
const IMAGE_BLOCK = {
  type: 'image',
  attachment: {
    attachmentId: 'att-abc123',
    mediaType: 'image/png',
    bytes: 45678,
    width: 800,
    height: 600,
  },
};

console.log('\n[1] collectImageRefs：抽出附件引用');
check('单个图片块', collectImageRefs([IMAGE_BLOCK]), [
  { attachmentId: 'att-abc123', mediaType: 'image/png', bytes: 45678, width: 800, height: 600 },
]);
check('mediaType 缺失时兜底 png', collectImageRefs([
  { type: 'image', attachment: { attachmentId: 'a1' } },
]), [{ attachmentId: 'a1', mediaType: 'image/png' }]);
check('没有 attachmentId 的图片块被忽略', collectImageRefs([
  { type: 'image', attachment: { mediaType: 'image/png' } },
]), []);
check('非数组返回空', collectImageRefs('nope'), []);

console.log('\n[2] collectMessageText：正文提取不受影响');
check('有图有文只取文字', collectMessageText([
  { type: 'text', text: '这是截图：' },
  IMAGE_BLOCK,
]), '这是截图：');
check('纯图片 → 空文本（这正是第 2 层事故的起点）', collectMessageText([IMAGE_BLOCK]), '');

console.log('\n[3] 🔴 纯图片消息不能整条消失（回归锁）');
const assistantOnlyImage = eventToLine({
  type: 'assistant/message',
  seq: 7,
  data: { message: { content: [IMAGE_BLOCK] } },
});
check('纯图片消息仍然产出一行', assistantOnlyImage !== null, true);
check('该行的 imageRefs 保留', assistantOnlyImage?.imageRefs, [
  { attachmentId: 'att-abc123', mediaType: 'image/png', bytes: 45678, width: 800, height: 600 },
]);
check('该行 text 为空字符串', assistantOnlyImage?.text, '');

console.log('\n[4] user 消息（无 message 包装）同样要接住');
const userOnlyImage = eventToLine({
  type: 'user/message',
  seq: 8,
  data: { content: [IMAGE_BLOCK] },
});
check('user 纯图片不消失', userOnlyImage !== null, true);
check('user 行 role 正确', userOnlyImage?.role, 'user');

console.log('\n[5] 空消息仍然不该渲染（别把"什么都没有"变成空气泡）');
check('完全空的事件 → null', eventToLine({ type: 'assistant/message', seq: 9, data: { message: { content: [] } } }), null);
check('只有 reasoning 的事件 → null', eventToLine({
  type: 'assistant/message',
  seq: 10,
  data: { message: { content: [{ type: 'reasoning', text: '内部思考' }] } },
}), null);

console.log('\n[6] 请求构造与返回值解析');
check('session/attachment 的 args 形状', attachmentRequest('sess-1', 'att-1'), {
  request: { sessionId: 'sess-1', attachmentId: 'att-1' },
});
check('取 base64', attachmentBase64({ attachment: {}, data: 'iVBORw0KGgo=' }), 'iVBORw0KGgo=');
check('返回里没有 data → null', attachmentBase64({ attachment: {} }), null);
check('返回是 null → null', attachmentBase64(null), null);

console.log(`\n${fail === 0 ? '✅' : '❌'} test-image-attachment: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
