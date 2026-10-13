/**
 * 修正 docs/api-contract.json 里与真实主机不符的方法条目。
 *
 * 背景：该文件由子代理从**客户端 bundle** 挖出，与真实主机不同步，
 * 已导致 App 调用不存在的 `session.history`。本脚本把已确认的错误条目
 * 改为真实主机源码里的定义。
 *
 * 用法：node scripts/fix-contract-json.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const path = join(repo, 'docs', 'api-contract.json');

const raw = readFileSync(path, 'utf8');
const doc = JSON.parse(raw);

const HOST_SOURCE = 'app.asar:@deepseek-ai/dsh-api-session-controller/lib/client.js';

let changed = 0;

for (const method of doc.methods ?? []) {
  if (method.name === 'session.history') {
    method.name = 'session.page';
    method.params = [
      {
        name: 'address',
        type: "{kind:'session',sessionId} | {kind:'subagent',…}",
        required: true,
      },
      { name: 'throughSeq', type: 'number', required: true },
      { name: 'beforeSeq', type: 'number', required: false },
      { name: 'maxMessages', type: 'number', required: false },
      { name: 'turnWindow', type: 'object', required: false },
    ];
    method.returns = '{ records: [ { type:"event", event:{ type, seq, time, data } } ], … }';
    method.description =
      'Page the session event journal. Verified against the REAL host: the method is ' +
      'session.page with {address, throughSeq}; there is no session.history.';
    method.source = HOST_SOURCE;
    method.verifiedAgainst = 'real-host';
    changed += 1;
    console.log('  fixed: session.history -> session.page');
  }

  if (method.name === 'session.prompt') {
    const hasRequestId = (method.params ?? []).some((p) => p.name === 'requestId');
    if (!hasRequestId) {
      method.params = [
        { name: 'requestId', type: 'string', required: true },
        ...(method.params ?? []),
      ];
      method.note =
        'requestId is REQUIRED alongside sessionId — the official client itself sends ' +
        'requestId ?? randomUUID(). Verified against the real host source.';
      method.verifiedAgainst = 'real-host';
      changed += 1;
      console.log('  fixed: session.prompt 补上必填 requestId');
    }
  }
}

// 给整个文件加一条来源警告，避免后来者再被它误导。
doc._warning =
  'IMPORTANT: this file was mined from the CLIENT bundle (@deepseek-ai/dsh-client-connection) ' +
  'and has been out of sync with the real host before (session.history did not exist). ' +
  'Before shipping any call, verify against the real host: app.asar ' +
  '@deepseek-ai/dsh-api-*/lib/*.js, or issue a real request and see what it accepts.';

writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`\n完成，修改 ${changed} 处 -> ${path}`);
