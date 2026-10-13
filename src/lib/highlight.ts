/**
 * 纯 TypeScript 语法高亮引擎（零依赖）。
 *
 * ## 为什么不用 highlight.js / shiki
 *
 * - shiki：体积大、要 WASM、异步，不适合流式逐 token 重渲；
 * - highlight.js：约 1 MB 全量语言包，手机端首屏代价高；
 * - Prism：同上，且正则对流式半截 token 容易回溯爆炸。
 *
 * 手机端只真实出现少数语言，所以这里做**组合式正则分词**：
 * 每条规则一个 `regex + token class`，按优先级顺序扫描，命中即推进。
 * 复杂度 O(n × 规则数)，规则数固定 ≤ 20，无回溯嵌套，天然流式安全。
 *
 * ## 配色
 *
 * 与 Android 端 `render/CodeHighlighter.kt` 使用**同一套 One Dark 风格色板**，
 * 两个端的代码块观感一致。
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'builtin'
  | 'function'
  | 'operator'
  | 'punct'
  | 'tag'
  | 'attr'
  | 'property'
  | 'type'
  | 'regexp'
  | 'meta';

export interface Token {
  text: string;
  kind: TokenKind;
}

export interface TokenStyle {
  color: string;
  fontStyle?: 'italic';
  fontWeight?: 'bold';
}

/** One Dark 风格色板（浅色底 / 深色代码块均已按对比度调过）。 */
export const TOKEN_STYLES: Record<TokenKind, TokenStyle> = {
  plain: { color: '#d4d4d4' },
  comment: { color: '#7f848e', fontStyle: 'italic' },
  string: { color: '#98c379' },
  number: { color: '#d19a66' },
  keyword: { color: '#c678dd', fontWeight: 'bold' },
  builtin: { color: '#e5c07b' },
  function: { color: '#61afef' },
  operator: { color: '#56b6c2' },
  punct: { color: '#9aa0aa' },
  tag: { color: '#e06c75' },
  attr: { color: '#d19a66' },
  property: { color: '#e06c75' },
  type: { color: '#e5c07b' },
  regexp: { color: '#98c379' },
  meta: { color: '#61afef' },
};

interface Rule {
  re: RegExp;
  kind: TokenKind;
}

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

const JS_KEYWORDS =
  'as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|true|false|null|undefined|NaN|Infinity';

const TS_EXTRA =
  '|interface|type|enum|implements|declare|namespace|readonly|public|private|protected|abstract|as|infer|satisfies|keyof|unknown|never|asserts|override|using';

const SHELL_KEYWORDS =
  'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|in|export|local|readonly|source|alias|set|unset|echo|cd|exit|trap|shift';

const PY_KEYWORDS =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case|self|cls|None|True|False';

const SQL_KEYWORDS =
  'SELECT|FROM|WHERE|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|ON|AS|AND|OR|NOT|NULL|IS|IN|EXISTS|BETWEEN|LIKE|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|WITH|RETURNING|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CONSTRAINT|IF|EXISTS|CASCADE';

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shell_session: 'bash',
  py: 'python',
  py3: 'python',
  python3: 'python',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  htm: 'html',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  rs: 'rust',
  golang: 'go',
  rb: 'ruby',
  kt: 'kotlin',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  dockerfile: 'docker',
  docker: 'docker',
  'objc': 'c',
  h: 'c',
  cc: 'cpp',
  hpp: 'cpp',
  toml: 'ini',
  conf: 'ini',
  properties: 'ini',
};

function words(...groups: string[]): string {
  return `(?:${groups.join('|')})`;
}

/**
 * 规则集。顺序即优先级 —— 先匹配的赢，剩下的位置继续往后找。
 * 注释与字符串放最前，避免 `"//"` 里的内容被当成语法。
 */
function buildRules(lang: string): Rule[] {
  const rules: Rule[] = [];

  const push = (pattern: string, kind: TokenKind, flags = '') => {
    rules.push({ re: new RegExp(pattern, flags), kind });
  };

  switch (lang) {
    case 'javascript':
    case 'typescript': {
      const kw = lang === 'typescript' ? words(JS_KEYWORDS, TS_EXTRA) : words(JS_KEYWORDS);
      const builtins =
        'console|Math|JSON|Object|Array|String|Number|Boolean|Promise|Map|Set|WeakMap|WeakSet|Symbol|Date|RegExp|Error|TypeError|RangeError|process|globalThis|window|document|require|module|exports|__dirname|Buffer|setTimeout|setInterval|fetch|URL|Headers|Response|Intl|BigInt';

      // 模板字符串要先于普通字符串，否则 `${}` 会被切断
      push('`(?:\\\\.|[^`\\\\])*`', 'string');
      push('"(?:\\\\.|[^"\\\\\\n])*"', 'string');
      push("'(?:\\\\.|[^'\\\\\\n])*'", 'string');
      push('//.*', 'comment');
      push('/\\*(?:[^*]|\\*(?!/))*\\*/', 'comment');
      push('0[xXbBoO][0-9a-fA-F_]+n?|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?', 'number');
      push(kw, 'keyword', 'g');
      push(`(?:new)\\s+(?=${IDENT})`, 'keyword');
      push(builtins, 'builtin', 'g');
      push('(?:typeof|instanceof|in|of|void|delete)\\s+(?=' + IDENT + ')', 'keyword');
      push(`${IDENT}(?=\\s*\\()`, 'function');
      push(IDENT, 'plain', 'g');
      push('[{}()\\[\\]]', 'punct');
      push('=>|[+\\-*/%=<>!&|^~?:]+', 'operator');
      break;
    }

    case 'json': {
      push('"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', 'property');
      push('"(?:\\\\.|[^"\\\\])*"', 'string');
      push('\\b(?:true|false|null)\\b', 'keyword');
      push('-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'number');
      push('[{}]', 'punct');
      push('[:,]', 'operator');
      break;
    }

    case 'bash': {
      push('#[^\\n]*', 'comment');
      push('"(?:\\\\.|[^"\\\\])*"', 'string');
      push("'[^']*'", 'string');
      push('\\$\\{[^}]*\\}|\\$\\(?\\)|\\$[A-Za-z_][A-Za-z0-9_]*', 'builtin');
      push(`\\b(?:${SHELL_KEYWORDS})\\b`, 'keyword');
      push('\\b(?:cd|ls|git|npm|pnpm|node|yarn|pnpm|npx|curl|wget|docker|kubectl|make|cat|grep|awk|sed|echo|mkdir|rm|cp|mv|chmod|sudo|systemctl|journalctl|ps|kill|ssh|scp)\\b', 'builtin');
      push('\\b\\d+\\b', 'number');
      push('&|\\|\\||&&|>>|<<|[<>]|[|]', 'operator');
      break;
    }

    case 'python': {
      push('"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'', 'string');
      push('(?i)f?"(?:\\\\.|[^"\\\\\\n])*"', 'string');
      push("(?i)f?'(?:\\\\.|[^'\\\\\\n])*'", 'string');
      push('#[^\\n]*', 'comment');
      push('0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', 'number');
      push(`\\b(?:${PY_KEYWORDS})\\b`, 'keyword');
      push('\\b(?:print|len|range|open|int|str|float|bool|list|dict|set|tuple|sum|min|max|abs|enumerate|zip|sorted|isinstance|super|getattr|setattr|hasattr)\\b', 'builtin');
      push('(?:self|cls)\\b', 'keyword');
      push(`${IDENT}(?=\\s*\\()`, 'function');
      push(IDENT, 'plain', 'g');
      push('[{}()\\[\\]]', 'punct');
      push('->|:=|==|!=|>=|<=|\\+=|\\*=|//|[+\\-*/%<>=]', 'operator');
      break;
    }

    case 'java':
    case 'kotlin':
    case 'c':
    case 'cpp':
    case 'csharp':
    case 'go':
    case 'rust':
    case 'swift':
    case 'dart': {
      push('//.*', 'comment');
      push('/\\*(?:[^*]|\\*(?!/))*\\*/', 'comment');
      push('"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'', 'string');
      push('`[^`]*`', 'string');
      push('\\b0[xXbB][0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?[fFlLuU]*\\b', 'number');
      push(
        words(
          'abstract|as|async|await|base|bool|boolean|break|byte|case|catch|char|class|const|constructor|continue|def|default|defer|delete|do|double|dynamic|elif|else|enum|err|error|except|export|extends|extern|false|final|finally|float|fn|for|from|func|function|get|go|guard|if|impl|implements|import|in|int|interface|internal|is|let|lock|long|match|mod|module|move|mut|namespace|new|nil|none|not|null|nullptr|object|override|package|pass|priv|private|protected|pub|public|raise|readonly|ref|require|return|sealed|self|short|signed|sizeof|static|string|struct|super|switch|synchronized|template|this|throw|throws|trait|true|try|type|typedef|typeof|union|unsafe|unsigned|use|using|var|virtual|void|volatile|when|where|while|with|yield',
        ),
        'keyword',
        'g',
      );
      push(
        words(
          'String|int|Integer|long|Long|double|Double|float|Float|boolean|Boolean|char|byte|short|void|auto|size_t|vector|Vector|Option|Result|Box|Arc|Rc|HashMap|HashSet|Map|List|Array|StringBuilder|Future|Promise|Optional|Any|AnyObject|byte[]',
        ),
        'type',
        'g',
      );
      push(`${IDENT}(?=\\s*\\()`, 'function');
      push(IDENT, 'plain', 'g');
      push('[{}()\\[\\]]', 'punct');
      push('->|=>|::|===|!==|[+\\-*/%<>=!&|^~?]+', 'operator');
      break;
    }

    case 'sql': {
      push('--[^\\n]*|/\\*(?:[^*]|\\*(?!/))*\\*/', 'comment');
      push("'(?:''|[^'])*'", 'string');
      push('`(?:``|[^`])*`', 'string');
      push(`\\b(?:${SQL_KEYWORDS})\\b`, 'keyword', 'gi');
      push('\\b\\d+(?:\\.\\d+)?\\b', 'number');
      push(IDENT, 'plain', 'g');
      push('[(),;]', 'punct');
      push('=|!=|<>|<=|>=|[-+*/%]', 'operator');
      break;
    }

    case 'html': {
      push('<!--[\\s\\S]*?-->', 'comment');
      push('<!DOCTYPE[^>]*>', 'meta');
      push('</?${IDENT}', 'tag');
      push('"[^"]*"|\'[^\']*\'', 'string');
      push(IDENT + '(?==)', 'attr');
      push('=', 'operator');
      push('/?>', 'tag');
      break;
    }

    case 'css': {
      push('/\\*(?:[^*]|\\*(?!/))*\\*/', 'comment');
      push('"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'', 'string');
      push('@[a-z-]+', 'keyword');
      push('#[0-9a-fA-F]{3,8}\\b', 'number');
      push('-?\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|ms|s|deg)?', 'number');
      push(IDENT + '(?=\\s*[,{])', 'tag');
      push('\\.[-\\w]+|#[-\\w]+|:{1,2}[-\\w]+(?:\\([^)]*\\))?', 'property');
      push(IDENT, 'plain', 'g');
      push('[{}();:,]', 'punct');
      break;
    }

    case 'yaml': {
      push('#[^\\n]*', 'comment');
      push('"(?:\\\\.|[^"\\\\])*"|\'[^\']*\'', 'string');
      push('^[ \\t]*-[ \\t]+', 'operator');
      push('^\\s*([-\\w.]+)(?=\\s*:)', 'property');
      push('\\b(?:true|false|null|yes|no|on|off|~)\\b', 'keyword');
      push('\\b\\d+(?:\\.\\d+)?\\b', 'number');
      push('[|>][-+]?$', 'meta');
      break;
    }

    case 'diff': {
      push('^@@[^\\n]*', 'meta');
      push('^[+-][^+-].*', 'string');
      push('^!.*', 'keyword');
      break;
    }

    case 'ini':
    case 'toml': {
      push('[;#].*', 'comment');
      push('^\\s*\\[[^\\]\\n]*\\]', 'type');
      push('^\\s*[-\\w.]+(?=\\s*=)', 'property');
      push('=.*$', 'string');
      break;
    }

    default: {
      // 未知语言：只挑通用可读的，注释 + 字符串 + 数字。
      push('(?:#|//|<!--)[^\\n]*', 'comment');
      push('"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'', 'string');
      push('`[^`]*`', 'string');
      push('\\b\\d+(?:\\.\\d+)?\\b', 'number');
    }
  }

  return rules;
}

const ruleCache = new Map<string, Rule[]>();

function rulesFor(lang: string): Rule[] {
  let rules = ruleCache.get(lang);
  if (!rules) {
    rules = buildRules(lang);
    ruleCache.set(lang, rules);
  }
  return rules;
}

/** 语言名归一：`JSX` / `js` / `Shell Session` → 规范名。 */
export function normalizeLang(raw: string | null | undefined): string {
  if (!raw) return '';
  const key = raw.trim().toLowerCase().split(/[\s,:/+]/)[0];
  return LANGUAGE_ALIASES[key] ?? key;
}

/**
 * 对一行代码分词。
 *
 * `anchor` 控制 `^` 锚点的语义：多数规则里我们**不**用 `^`（多行语言如 Python
 * 缩进块、diff、yaml 需要行首语义），而是由 `startOfLine` 标志在扫描时切分。
 *
 * 实现要点：把整行文本一次性 `matchAll`，用「粘性正则 + 手动推进」保证零回溯。
 */
export function tokenizeLine(line: string, lang: string): Token[] {
  const rules = rulesFor(lang);
  const tokens: Token[] = [];

  let cursor = 0;
  let plainStart = 0;

  const pushPlain = (end: number) => {
    if (end > plainStart) {
      tokens.push({ text: line.slice(plainStart, end), kind: 'plain' });
    }
  };

  outer: while (cursor < line.length) {
    let bestEnd = -1;
    let bestKind: TokenKind = 'plain';

    for (const rule of rules) {
      // 用带 lastIndex 的克隆推进，避免共享 regex 状态导致的串扰
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      re.lastIndex = cursor;
      const m = re.exec(line);
      if (m && m.index === cursor && m[0].length > 0) {
        bestEnd = cursor + m[0].length;
        bestKind = rule.kind;
        break;
      }
    }

    if (bestEnd === -1) {
      cursor += 1;
      continue;
    }

    pushPlain(cursor);
    tokens.push({ text: line.slice(cursor, bestEnd), kind: bestKind });
    cursor = bestEnd;
    plainStart = cursor;
  }

  pushPlain(line.length);
  return tokens;
}

/** 整段代码分词（返回二维数组，每行一组）。 */
export function highlight(code: string, rawLang: string | null | undefined): Token[][] {
  const lang = normalizeLang(rawLang);
  const lines = code.split('\n');
  // 未知语言走轻量规则，不值得为它建全量规则集。
  return lines.map((line) => tokenizeLine(line, lang));
}
