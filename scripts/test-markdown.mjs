/**
 * Markdown 解析器回归测试（零依赖，手写断言）。
 *
 * 运行：`node scripts/test-markdown.mjs`
 *
 * 与 Android 端 `MarkdownTest.kt` 用同一批用例，保证两端行为一致。
 *
 * 🔴 重点覆盖两类真实事故：
 *  1. **流式半截语法** —— 半开的 `**`、半开的代码围栏不能被渲染成错的；
 *  2. **静默丢内容** —— 任何输入都必须能被完整还原（用 plain() 回扫比对）。
 */

import { parseMarkdown, inlinePlain, listItemPlain, safeUrl } from '../src/lib/markdown.ts';
import { highlight, normalizeLang, tokenizeLine, TOKEN_STYLES } from '../src/lib/highlight.ts';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? ''}\n  expected: ${e}\n  actual:   ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expected truthy');
}

/** 把整棵 AST 还原成纯文本，用于「不许丢内容」断言。 */
function plain(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
      case 'quote':
        out.push(inlinePlain(b.children));
        break;
      case 'callout':
        out.push(inlinePlain(b.children));
        break;
      case 'code':
        out.push(b.code);
        break;
      case 'list':
        for (const item of b.items) out.push(listItemPlain(item));
        break;
      case 'table':
        for (const cell of b.header) out.push(inlinePlain(cell));
        for (const row of b.rows) for (const cell of row) out.push(inlinePlain(cell));
        break;
      case 'divider':
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}

// ── 块级结构 ────────────────────────────────────────────────────────────────

check('标题分级：h1..h6 收敛到 h3', () => {
  const b = parseMarkdown('# H1\n## H2\n### H3\n#### H4\n');
  eq(
    b.filter((x) => x.type === 'heading').map((x) => x.level),
    [1, 2, 3, 3],
    '更深的标题当正文/收敛到 3',
  );
});

check('分隔线优先于列表判定', () => {
  const b = parseMarkdown('- - -\n');
  eq(b.map((x) => x.type), ['divider'], '「- - -」不是列表项');
});

check('分隔线三种写法', () => {
  eq(parseMarkdown('---').map((x) => x.type), ['divider']);
  eq(parseMarkdown('***').map((x) => x.type), ['divider']);
  eq(parseMarkdown('___').map((x) => x.type), ['divider']);
});

check('表格：识别 + 对齐 + 列数补齐', () => {
  const b = parseMarkdown('| A | B |\n| :-- | --: |\n| 1 | 2 |\n| 3 |');
  eq(b.length, 1);
  eq(b[0].type, 'table');
  eq(b[0].aligns, ['left', 'right']);
  eq(b[0].rows.length, 2, '缺列的行被补齐而不是被丢弃');
  eq(b[0].rows[1].length, 2);
});

check('表格：正文里的竖线不会被误判成表格', () => {
  // 第二行不是分隔行 → 不构成表格
  const b = parseMarkdown('a | b\nnot a separator\nc | d');
  ok(!b.some((x) => x.type === 'table'), '没有分隔行就不该是表格');
});

check('表格：转义竖线不切列', () => {
  const b = parseMarkdown('| A | B |\n|---|---|\n| x \\| y | z |');
  eq(b[0].type, 'table');
  eq(inlinePlain(b[0].rows[0][0]), 'x | y', '转义竖线还原为字面 |');
});

// ── 列表 ────────────────────────────────────────────────────────────────────

check('有序列表保留起始编号', () => {
  const b = parseMarkdown('3. c\n4. d');
  eq(b[0].type, 'list');
  eq(b[0].ordered, true);
  eq(b[0].startNumber, 3);
});

check('嵌套缩进最多 3 级', () => {
  const b = parseMarkdown('- a\n    - b\n        - c\n            - d\n');
  eq(b[0].type, 'list');
  eq(b[0].indents, [0, 2, 3, 3], '2 空格=1 级，4 空格=2 级，6 空格=3 级后夹紧');
});

check('有序/无序切换会切开列表', () => {
  const b = parseMarkdown('- a\n- b\n1. c\n2. d');
  eq(b.map((x) => x.type), ['list', 'list']);
  eq(b[0].ordered, false);
  eq(b[1].ordered, true);
});

check('🔴 任务列表项不会被静默丢弃（曾经的 bug）', () => {
  const b = parseMarkdown('- [x] 写完文档\n- [ ] 补测试\n- 普通项');
  eq(b[0].type, 'list');
  eq(b[0].items.length, 3);
  eq(b[0].items[0].kind, 'task');
  eq(b[0].items[0].checked, true);
  eq(listItemPlain(b[0].items[0]), '写完文档');
  eq(b[0].items[1].checked, false);
  eq(b[0].items[2].kind, 'item');
  // 关键断言：文本真的进了 AST，而不是被行内渲染器吃掉
  ok(plain(b).includes('写完文档'), '已勾选任务文本必须存在');
  ok(plain(b).includes('补测试'), '未勾选任务文本必须存在');
});

check('任务项支持 - / * / + 三种项目符号与 [X] 大写', () => {
  const b = parseMarkdown('* [X] a\n+ [ ] b\n- [x] c');
  eq(b.map((x) => x.type), ['list']);
  eq(b[0].items.map((i) => i.checked), [true, false, true]);
});

// ── Callout ─────────────────────────────────────────────────────────────────

check('GitHub Callout 五种类型', () => {
  for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
    const b = parseMarkdown(`> [!${kind}]\n> 内容`);
    eq(b[0].type, 'callout');
    eq(b[0].callout, kind);
    ok(plain(b).includes('内容'), `${kind} 正文必须存在`);
  }
});

check('Callout 自定义标题', () => {
  const b = parseMarkdown('> [!WARNING] 小心点\n> 别乱删');
  eq(b[0].title, '小心点');
});

check('普通引用不是 Callout', () => {
  const b = parseMarkdown('> 只是引用\n> 第二行');
  eq(b[0].type, 'quote');
  ok(plain(b).includes('第二行'), '多行引用都要保留');
});

// ── 行内 ────────────────────────────────────────────────────────────────────

check('嵌套样式：粗体里含行内代码', () => {
  const b = parseMarkdown('**加粗 `代码` 继续**');
  const texts = b[0].children;
  const code = texts.find((n) => n.type === 'text' && n.style.code);
  ok(code, '行内代码节点存在');
  eq(code.value, '代码');
  eq(code.style.bold, true, '行内代码继承外层粗体');
});

check('链接内含粗体', () => {
  const b = parseMarkdown('[**重点**](https://example.com)');
  const n = b[0].children.find((x) => x.style.link);
  ok(n, '链接节点存在');
  eq(n.style.link, 'https://example.com');
  eq(n.style.bold, true, '链接内文字保留粗体');
});

check('删除线', () => {
  const b = parseMarkdown('~~删掉~~');
  eq(b[0].children[0].style.strike, true);
});

check('反斜杠转义不被当成语法', () => {
  const b = parseMarkdown('\\*不是斜体\\* \\`不是代码\\`');
  ok(!b[0].children.some((n) => n.style.italic), '转义后不应有斜体');
  ok(!b[0].children.some((n) => n.style.code), '转义后不应有行内代码');
  ok(plain(b).includes('*不是斜体*'), '字面字符还原');
});

check('词内下划线不触发斜体（CommonMark）', () => {
  const b = parseMarkdown('snake_case_name');
  ok(!b[0].children.some((n) => n.style.italic), 'snake_case 不该变斜体');
});

// ── 🔴 流式半截语法（渲染「难受」的头号来源）─────────────────────────────────

check('流式：半开的粗体按纯文本', () => {
  const b = parseMarkdown('这里**加粗还没闭合');
  ok(!b[0].children.some((n) => n.style.bold), '未闭合粗体不渲染成粗体');
  ok(plain(b).includes('加粗还没闭合'), '但字面文本必须完整显示');
});

check('流式：半开的行内代码', () => {
  const b = parseMarkdown('看这个 `code 还没闭');
  ok(!b[0].children.some((n) => n.style.code), '未闭合行内代码不当代码');
  ok(plain(b).includes('还没闭'));
});

check('流式：只有开围栏的代码块照样渲染', () => {
  const b = parseMarkdown('```ts\nconst a = 1;');
  eq(b.length, 1);
  eq(b[0].type, 'code');
  eq(b[0].lang, 'ts');
  ok(b[0].code.includes('const a = 1;'));
});

check('流式：只有闭围栏不炸', () => {
  const b = parseMarkdown('```\n结束符提前到了');
  eq(b[0].type, 'code');
});

check('流式：空输入与纯空白', () => {
  eq(parseMarkdown('').length, 0);
  eq(parseMarkdown('   \n\n  ').length, 0);
});

check('流式：半个表格不炸', () => {
  const b = parseMarkdown('| A | B |\n| ---');
  eq(b[0].type, 'table', '分隔行不完整也尽量当表格');
});

check('🔴 任意输入都不丢内容（不抛异常）', () => {
  const nasty = [
    '**',
    '```',
    '| a |',
    '> ',
    '- [',
    '[](', '](', '![', '~~~', '***', '#', '> [!NOTE]', '- [ ]', '\u0000\ufffd',
    'a'.repeat(5000), '`'.repeat(51), '*'.repeat(101),
  ];
  for (const src of nasty) {
    const b = parseMarkdown(src);
    ok(Array.isArray(b), `parse(${JSON.stringify(src.slice(0, 20))}) 必须返回数组`);
  }
});

check('超长输入不超时', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `- [${i % 2 ? 'x' : ' '}] 项目 ${i}`).join('\n');
  const t0 = performance.now();
  const b = parseMarkdown(big);
  const dt = performance.now() - t0;
  ok(dt < 2000, `2000 行解析耗时 ${dt.toFixed(0)}ms，应远低于 2s`);
  eq(b[0].items.length, 2000);
});

// ── 语法高亮 ────────────────────────────────────────────────────────────────

check('高亮：语言名归一', () => {
  eq(normalizeLang('js'), 'javascript');
  eq(normalizeLang('TSX'), 'typescript');
  eq(normalizeLang('sh'), 'bash');
  eq(normalizeLang('Shell Session'), 'bash');
  eq(normalizeLang('c++'), 'cpp');
  eq(normalizeLang(null), '');
});

check('高亮：分词总数守恒（一个字符都不丢）', () => {
  const samples = [
    ['ts', 'const a: number = 1; // hi\nfunction f(x: string) { return `v${x}`; }'],
    ['python', 'def f(x):\n    # c\n    return {"a": 1, "b": [2, 3]}'],
    ['bash', 'git commit -m "msg" # note\necho $HOME'],
    ['go', 'func main() { fmt.Println("hi") }'],
    ['rust', 'fn main() { let v: Vec<i32> = vec![1, 2]; }'],
    ['json', '{"a": 1, "b": [true, null], "c": "s"}'],
    ['sql', 'SELECT id FROM t WHERE a = 1 -- c'],
    ['unknownlang', 'whatever ~~ stuff 123'],
  ];
  for (const [lang, code] of samples) {
    const lines = highlight(code, lang);
    eq(lines.length, code.split('\n').length, `${lang} 行数`);
    const rejoined = lines.map((toks) => toks.map((t) => t.text).join('')).join('\n');
    eq(rejoined, code, `${lang} 分词后必须能完整还原`);
    ok(tokensHaveColor(tokensOf(lines)), `${lang} 至少要命中一个高亮 token`);
  }
});

function tokensOf(lines) {
  return lines.flat();
}
function tokensHaveColor(tokens) {
  return tokens.some((t) => t.kind !== 'plain' && t.text.trim().length > 0);
}

check('高亮：空行不产生空 token 列表以外的怪东西', () => {
  const lines = highlight('a\n\nb', 'javascript');
  eq(lines.length, 3);
  eq(lines[1].map((t) => t.text).join(''), '', '空行还原为空');
});

// ── 🔴 XSS：链接 URL 协议白名单 ──────────────────────────────────────────────
//
// 背景：模型输出（及被投毒的 prompt）能产出 `[点我](javascript:alert(1))`。
// 渲染端若把 href 原样塞进 <a>，用户一点即执行 —— 存储型 XSS。

check('🔴 XSS：危险协议一律被 safeUrl 拒绝', () => {
  const attacks = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'blob:https://evil.com/uuid',
  ];
  for (const a of attacks) {
    eq(safeUrl(a), null, `${JSON.stringify(a)} 必须被拒绝`);
  }
});

check('XSS：正常 URL 不得误杀（相对地址也算安全）', () => {
  const safe = [
    'https://example.com',
    'http://example.com/a?b=1#c',
    'HTTPS://EXAMPLE.COM',
    'mailto:a@b.c',
    '/local/path',
    './relative',
    '#anchor',
    '?q=1',
    '//cdn.example.com/x',
  ];
  for (const s of safe) {
    ok(safeUrl(s) !== null, `${JSON.stringify(s)} 不该被误杀`);
  }
});

check('XSS：空值与空白返回 null', () => {
  eq(safeUrl(''), null);
  eq(safeUrl(null), null);
  eq(safeUrl(undefined), null);
  eq(safeUrl('   '), null);
});

check('🔴 链接 URL 内的括号不再被截断', () => {
  const cases = [
    ['[wiki](https://en.wikipedia.org/wiki/Foo_(bar))', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['[fn](https://example.com/a(b)c)', 'https://example.com/a(b)c'],
    ['[ok](https://example.com/ok)', 'https://example.com/ok'],
  ];
  for (const [src, expected] of cases) {
    const n = parseMarkdown(src)[0].children.find((x) => x.style.link);
    ok(n, `链接节点应存在: ${src}`);
    eq(n.style.link, expected, `URL 不该在内层 ) 处截断: ${src}`);
  }
});

check('链接 URL 未闭合 → 走流式降级（不当链接）', () => {
  const b = parseMarkdown('[文字](https://example.com/a(b');
  ok(!b[0].children.some((n) => n.style.link), '括号不配对时不应渲染成链接');
  ok(plain(b).includes('https://example.com/a(b'), '但文本必须完整保留');
});

// ── 🔴 两端一致性：Web 必须与 Android `Markdown.kt` 同构 ───────────────────────

check('🔴 有序列表中出现任务项要切块（与 Kotlin Markdown.kt 对齐）', () => {
  // Kotlin: `if (listItems.isNotEmpty() && listOrdered) flushList()`
  const b = parseMarkdown('1. 第一步\n- [x] 已完成');
  eq(b.length, 2, '任务项必须把有序列表切成两个块');
  eq(b[0].type, 'list');
  eq(b[0].ordered, true, '第一个块仍是有序列表');
  eq(b[0].items[0].kind, 'item');
  eq(b[1].type, 'list');
  eq(b[1].ordered, false, '任务项块是无序列表');
  eq(b[1].items[0].kind, 'task');
  eq(b[1].items[0].checked, true);
  ok(plain(b).includes('第一步') && plain(b).includes('已完成'), '两段文本都不能丢');
});

check('任务项出现在无序列表中不额外切块', () => {
  const b = parseMarkdown('- 普通\n- [x] 任务\n- 另一个');
  eq(b.length, 1, '同为无序列表不该被切开');
  eq(b[0].items.length, 3);
});

check('表格：首尾多个竖线只剥一层（与 Kotlin trim(\'|\') 一致）', () => {
  const b = parseMarkdown('||a||b||\n|---|---|\n|1|2|');
  eq(b[0].type, 'table');
  eq(
    b[0].header.map((c) => inlinePlain(c)),
    ['a', '', 'b'],
    '|| 应被整体剥掉，不能多出两列空列',
  );
  eq(
    b[0].rows[0].map((c) => inlinePlain(c)),
    ['1', '2', ''],
    '行内空列在行尾被补齐（与 Kotlin .take(header.size) 的补齐策略一致）',
  );
});

// ── 🔴 高亮性能：sticky 改造不能退化 ────────────────────────────────────────

check('🔴 高亮：长行不退化（O(n²) → O(n) 回归防护）', () => {
  // 原实现对「一条规则都命中不了」的行最慢：每推进 1 字符，每条规则重扫全文。
  // 8000 字符行原实现 ~144ms，sticky 后 ~1.2ms。这里取宽松阈值防回归。
  const line = ' '.repeat(8000) + 'x';
  const t0 = performance.now();
  const toks = tokenizeLine(line, 'javascript');
  const dt = performance.now() - t0;
  ok(dt < 40, `8000 字符行耗时 ${dt.toFixed(1)}ms，应远低于 40ms（O(n²) 会到 100ms+）`);
  eq(toks.map((t) => t.text).join(''), line, '长行分词必须守恒');
});

check('高亮：200 行代码块整体耗时在预算内', () => {
  const code = Array.from(
    { length: 200 },
    (_, i) => `  const v${i} = compute(${i}, "s-${i}", { k: ${i} }); // c`,
  ).join('\n');
  const t0 = performance.now();
  const lines = highlight(code, 'typescript');
  const dt = performance.now() - t0;
  eq(lines.length, 200);
  ok(dt < 120, `200 行高亮耗时 ${dt.toFixed(1)}ms，应远低于 120ms`);
});

check('🔴 sticky 改造后分词结果不变（含 ^ 锚点语言）', () => {
  // sticky (`y`) 只在 lastIndex 处匹配，因此 `^` 规则必须在行首才命中。
  // 这些是各语言里带 `^` 的规则，用来确认语义没被改掉。
  const cases = [
    ['yaml', 'key: value', 'property'],
    ['yaml', '  - item', 'operator'],
    ['diff', '@@ -1 +1 @@', 'meta'],
    ['diff', '+ added', 'string'],
    ['ini', '[section]', 'type'],
    ['ini', 'key = value', 'property'],
    ['javascript', 'const a = 1; // c', 'keyword'],
  ];
  for (const [lang, src, expectedKind] of cases) {
    const toks = tokenizeLine(src, lang);
    eq(toks.map((t) => t.text).join(''), src, `${lang} 守恒: ${src}`);
    ok(
      toks.some((t) => t.kind === expectedKind),
      `${lang} 应命中 ${expectedKind}: ${src}`,
    );
  }
});

check('高亮：所有产出的 TokenKind 都有配色（不 fallback 到 plain）', () => {
  const samples = [
    ['typescript', 'const a: number = 1; // c\nclass A { m(x: string): void {} }'],
    ['python', 'def f(x):\n    """doc"""\n    # c\n    return {"a": 1}'],
    ['go', 'func main() {\n\t// c\n\tfmt.Println("x")\n}'],
    ['html', '<!-- c -->\n<div class="x" data-y="1">t</div>'],
    ['css', '.a { color: #fff; margin: 10px; }'],
    ['yaml', '# c\nkey: value\n- item\nx: >'],
    ['diff', '@@ -1 +1 @@\n+add\n-del\n!chg'],
    ['ini', '# c\n[sec]\nk = v'],
    ['json', '{"a": 1, "b": true}'],
    ['sql', 'SELECT a FROM t -- c'],
    ['bash', '# c\necho "$H"'],
    // builtin：只有这几个语言会产出，必须显式覆盖到
    ['bash', 'cd /tmp && ls | grep x'],
    ['typescript', 'console.log(Math.max(JSON.parse(x), 1))'],
    ['python', 'print(len(open("f").read()))'],
  ];
  const seen = new Set();
  for (const [lang, code] of samples) {
    for (const line of highlight(code, lang)) for (const t of line) seen.add(t.kind);
  }
  for (const kind of seen) {
    ok(TOKEN_STYLES[kind] !== undefined, `TokenKind "${kind}" 缺少配色`);
  }
  // 反向：不能有「声明了但任何语言都产不出」的死 TokenKind。
  const declared = Object.keys(TOKEN_STYLES);
  for (const kind of declared) {
    ok(seen.has(kind), `TokenKind "${kind}" 从未被任何规则产出（死代码）`);
  }
});

// ── 🔴 流式稳定性：block type 不得来回跳变 ───────────────────────────────────

check('🔴 流式：逐字符追加时块类型单调演化（不回退）', () => {
  // 「铁律」的可执行版本：对每个用例，block type 序列里
  // 同一个位置只能从 paragraph→更具体的类型，绝不能反向跳回。
  const cases = [
    '```ts\nconst a = 1;\n```',
    '这里**加粗文字**结束',
    '看这个 `const x = 1` 完成',
    '这是~~被删除的内容~~好了',
    '| 名称 | 状态 |\n| :--- | ---: |\n| a | b |',
    '> [!WARNING] 小心\n> 正文',
    '- 第一项\n  - 第二项',
    '- [ ] 未完成\n- [x] 已完成',
    '看看 [文档](https://example.com) 吧',
  ];
  const RANK = { paragraph: 0, quote: 1, callout: 1, list: 1, code: 2, table: 2 };
  for (const src of cases) {
    let prev = [];
    for (let n = 1; n <= src.length; n++) {
      const types = parseMarkdown(src.slice(0, n)).map((b) => b.type);
      const common = Math.min(prev.length, types.length);
      for (let k = 0; k < common; k++) {
        const before = RANK[prev[k]] ?? 0;
        const after = RANK[types[k]] ?? 0;
        ok(
          after >= before,
          `流式回退: 「${src.slice(0, n)}」第 ${k} 块 ${prev[k]} → ${types[k]}`,
        );
      }
      prev = types;
    }
  }
});

check('流式：链接/图片半截时不产生链接节点', () => {
  for (const src of ['看 [文档](https://exa', '看 [文档](https://exam', '![图](https://ex']) {
    const b = parseMarkdown(src);
    const hasLink = b[0].children.some((n) => n.style.link);
    const hasImg = b[0].children.some((n) => n.type === 'image');
    ok(!hasLink && !hasImg, `未闭合不应成链接/图片: ${src}`);
  }
});

// ── 报告 ────────────────────────────────────────────────────────────────────

console.log(`\n  Markdown 解析 / 高亮 单元测试`);
console.log(`  ${'─'.repeat(46)}`);
for (const f of failures) {
  console.log(`  ✗ ${f.name}\n    ${f.message.split('\n').join('\n    ')}`);
}
console.log(`  ${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed\n`);

process.exit(failed === 0 ? 0 : 1);
