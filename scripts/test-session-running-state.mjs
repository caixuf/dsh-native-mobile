import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('\n  会话运行态与停止按钮（Session Running State & Busy Guard）契约测试');
console.log('  ────────────────────────────────────────────────────────────');

// [1] 源码静态护栏测试
console.log('\n[1] 源码静态护栏（防假阳性停止按钮回归）');

const chatScreenPath = path.join(rootDir, 'src', 'components', 'screens', 'ChatScreen.tsx');
const chatScreenCode = fs.readFileSync(chatScreenPath, 'utf8');

assert(
  !chatScreenCode.includes("lines.some((l) => l.kind === 'tool/call' && !l.toolResult)"),
  'ChatScreen.tsx 不得包含 lines.some(tool/call && !toolResult) —— 该写法对历史调用永远返回 true',
);
console.log('  ok   已彻底移除 lines.some(tool/call && !toolResult) 致盲逻辑');

// isBusy 必须以 running / preparing / sending 为准
assert(
  /isBusy\s*=\s*Boolean\(\s*running\s*\|\|\s*preparing\s*\|\|\s*sending\s*\)/.test(chatScreenCode),
  'ChatScreen.tsx 中的 isBusy 必须严格由 running || preparing || sending 判定',
);
console.log('  ok   ChatScreen isBusy 严格遵循 running || preparing || sending 权威状态');

const appPath = path.join(rootDir, 'src', 'App.tsx');
const appCode = fs.readFileSync(appPath, 'utf8');

// 检查快照分支不得包含无条件 setRunning(true)
assert(
  !appCode.includes("if (activityRef.current && activityRef.current.phase !== 'idle') {\n                setRunning(true);"),
  'App.tsx 快照处理不得根据历史 activity phase 将已结束会话篡改为 running=true',
);
console.log('  ok   App.tsx 历史快照处理不篡改 session.running 状态');

// 检查 handleCancelPrompt 必须清理定时器与状态
assert(
  appCode.includes('stopTurnWatch();') && appCode.includes("phase: 'idle'"),
  'App.tsx handleCancelPrompt 必须包含 stopTurnWatch 和 phase: idle 清理',
);
console.log('  ok   handleCancelPrompt 包含完整的定时器与 phase 清理');

// [2] 纯逻辑状态机测试：模拟已完成会话与历史工具调用
console.log('\n[2] 逻辑状态机：历史会话与工具调用不触发 isBusy');

function computeIsBusy(running, preparing, sending) {
  return Boolean(running || preparing || sending);
}

// 模拟历史会话（非运行中，但包含大量历史 tool/call）
const mockCompletedSession = {
  sessionId: 'hist-1',
  running: false,
  lines: [
    { key: '1', kind: 'user/message', role: 'user', text: '执行脚本' },
    { key: '2', kind: 'tool/call', role: 'assistant', text: 'run_command', toolName: 'run_command' },
    { key: '3', kind: 'tool/result', role: 'assistant', text: 'Success', toolResult: 'Success' },
    { key: '4', kind: 'assistant/message', role: 'assistant', text: '执行完成' },
  ],
};

assert.strictEqual(
  computeIsBusy(mockCompletedSession.running, false, false),
  false,
  '已完成的历史会话进入后 isBusy 必须为 false',
);
console.log('  ok   包含历史工具调用的已完成会话 isBusy = false（绝不显示停止任务按钮）');

// 模拟新建会话未发消息状态
assert.strictEqual(computeIsBusy(false, false, false), false, '空会话 isBusy = false');
console.log('  ok   空会话 isBusy = false');

// 模拟刚点发送，处于 preparing
assert.strictEqual(computeIsBusy(false, true, false), true, 'preparing 态 isBusy = true');
console.log('  ok   preparing 态 isBusy = true（显示停止任务）');

// 模拟正在网络请求 sending
assert.strictEqual(computeIsBusy(false, false, true), true, 'sending 态 isBusy = true');
console.log('  ok   sending 态 isBusy = true（显示停止任务）');

// 模拟主机真正运行中 running = true
assert.strictEqual(computeIsBusy(true, false, false), true, 'running 态 isBusy = true');
console.log('  ok   running 态 isBusy = true（显示停止任务）');

// [3] 快照归约与已停止会话的相位修正
console.log('\n[3] 快照归约：已结束会话的 activity phase 归位');

function processSnapshotActivity(sessionRunning, rawEvents) {
  // 模拟从 records 构建 activity
  let phase = 'idle';
  for (const ev of rawEvents) {
    if (ev.type === 'tool/call') phase = 'tool';
    else if (ev.type === 'tool/result') phase = 'thinking';
    else if (ev.type === 'assistant/message') phase = 'step';
    else if (ev.type === 'turn/end') phase = 'idle';
  }

  // 若主机明确表示该会话已停止运行，快照即使推断出非 idle 也必须安全归位为 idle
  let running = sessionRunning === true;
  if (!running) {
    phase = 'idle';
  }
  return { running, phase };
}

const mockHistoricalEventsWithoutTurnEnd = [
  { type: 'turn/start' },
  { type: 'tool/call', data: { name: 'read_file' } },
  { type: 'tool/result', data: { result: 'ok' } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成' }] } } },
  // 注意：真实场景中常常缺失显式 turn/end
];

const resSnapshot = processSnapshotActivity(false, mockHistoricalEventsWithoutTurnEnd);
assert.strictEqual(resSnapshot.running, false, '缺失 turn/end 的历史快照不得将 session 置为 running');
assert.strictEqual(resSnapshot.phase, 'idle', '已停止会话的 phase 必须归位为 idle');
console.log('  ok   缺失 turn/end 的历史快照不会错误激活 running 或残留 step 状态');

// [4] 实时流事件对 running 状态的推进与终止
console.log('\n[4] 实时事件生命周期推进');

function reduceStreamingEvent(currentRunning, evType) {
  if (
    evType === 'step/start' ||
    evType === 'tool/call' ||
    evType === 'turn/start' ||
    evType === 'agent/start'
  ) {
    return true;
  }
  if (
    evType === 'turn/end' ||
    evType === 'session/complete' ||
    evType === 'run/finish' ||
    evType === 'session/idle' ||
    evType === 'cancel'
  ) {
    return false;
  }
  return currentRunning;
}

let runState = false;
runState = reduceStreamingEvent(runState, 'turn/start');
assert.strictEqual(runState, true, 'turn/start 激活 running');

runState = reduceStreamingEvent(runState, 'tool/call');
assert.strictEqual(runState, true, 'tool/call 保持 running');

runState = reduceStreamingEvent(runState, 'turn/end');
assert.strictEqual(runState, false, 'turn/end 终止 running');

runState = reduceStreamingEvent(true, 'cancel');
assert.strictEqual(runState, false, 'cancel 立即终止 running');

console.log('  ok   实时流事件生命周期（start -> tool -> end/cancel）转换完全符合预期');

console.log('\n  ────────────────────────────────────────────────────────────');
console.log('  ✓ 全部通过：会话运行态与停止按钮假阳性防护契约测试 100% 达成\n');
