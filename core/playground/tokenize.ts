// playground 편집기의 신택스 하이라이트. 소스를 줄 단위 토큰으로 쪼갠다.
//
// 줄 단위인 이유: 화면(.pg__view)이 줄마다 요소를 두고, 그 높이가 거터의 줄 번호와 겹쳐 있는
// textarea의 줄 높이에 맞아야 한다. 토큰을 평평하게 늘어놓고 개행을 토큰으로 섞으면 빈 줄이
// 높이를 잃어 셋이 어긋난다.
//
// 정확한 파서가 아니라 화면용 렉서다 - 문법 오류가 있는 편집 중간 상태도 무조건 토큰을 낸다.
// 어떤 입력에도 원문이 그대로 복원돼야 한다(토큰 text를 이으면 원본).

export type TToken = { text: string; cls: string };
// 줄 안 밑줄 구간. 단위는 **표시 폭**(monospace 1ch)이고 to는 끝 배타다 - 화면이 이걸
// 그대로 left/width로 쓴다. 진단이 주는 UTF-16 열과 다르다(한글은 2ch, markError가 환산한다).
export type TUnderline = { from: number; to: number };
// hasError/error/underline은 토크나이저가 아니라 진단이 채운다(markError) - 문법 오류는 렉서가
// 아는 것이 아니라 컴파일러가 말해 주는 것이다. 여기 두는 건 줄 하나의 화면 표현이 이
// 타입이기 때문이다.
export type TLine = { tokens: TToken[]; hasError: boolean; error: string; underline: TUnderline | null };

// qubc 예약어는 SYNTAX.md 전체를 따른다 - 선언 블록(#1), 디렉티브(#4), 타입(#2.1).
// 다른 언어는 화면에서 눈에 띄어야 하는 것만 고른다(완전한 목록이 목적이 아니다).
const QUBC_KEYWORDS = new Set([
  "use",
  "from",
  "component",
  "props",
  "contexts",
  "events",
  "template",
  "of", // @for (x of y)
]);
// 디렉티브(@로 시작). @slot은 자리 선언, 나머지는 블록을 연다.
const QUBC_DIRECTIVES = new Set(["if", "else", "for", "with", "slot"]);
// 원시 3종과 유틸 타입(Omit/Pick). 배열/객체는 문법 기호라 여기 없다.
const QUBC_TYPES = new Set(["string", "number", "bool", "Omit", "Pick"]);
const JS_KEYWORDS = new Set([
  "export",
  "default",
  "import",
  "from",
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "of",
  "in",
  "while",
  "new",
  "class",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "null",
  "undefined",
  "true",
  "false",
  "this",
]);
const JSON_KEYWORDS = new Set(["true", "false", "null"]);
// 값처럼 읽히는 리터럴/전역 - 키워드(문법)와 색을 갈라 둔다.
const JS_VALUES = new Set(["null", "undefined", "true", "false", "this"]);
// 핸들러에서 자주 보이는 전역. 완전한 목록이 목적이 아니라 눈에 띄어야 하는 것만.
const JS_GLOBALS = new Set([
  "console",
  "document",
  "window",
  "Object",
  "Array",
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Promise",
  "Date",
  "Error",
]);

const cls = (name?: string) => (name ? `tok tok--${name}` : "tok");

/** 확장자로 언어를 고른다. `main.qubc.handlers.js`처럼 겹쳐도 마지막 조각이 이긴다. */
const languageOf = (name: string) => {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  if (ext === "qubc") return "qubc";
  if (ext === "js" || ext === "ts") return "js";
  if (ext === "css") return "css";
  if (ext === "json") return "json";
  return "text";
};

/** 파일 이름의 확장자로 언어를 골라 줄 단위 토큰으로 쪼갠다. */
export const tokenize = (text: string, name: string): TLine[] => {
  const language = languageOf(name);
  const scan = SCANNERS[language];
  // 여러 줄 주석/문자열은 줄을 넘나든다. 줄마다 새로 훑지 않고 전체를 한 번 훑은 뒤 개행에서
  // 자른다 - 그래야 열린 상태가 다음 줄로 이어진다.
  return splitLines(scan(text));
};

// 토큰 목록을 개행에서 자른다. 토큰 하나가 여러 줄에 걸치면(주석/템플릿 문자열) 줄마다 쪼갠다.
// 빈 줄에는 공백 한 칸을 넣는다 - 내용이 없으면 요소에 높이가 안 생겨 textarea와 어긋난다.
const splitLines = (tokens: TToken[]): TLine[] => {
  const lines: TLine[] = [];
  let current: TToken[] = [];
  for (const token of tokens) {
    const pieces = token.text.split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) {
        lines.push(lineOf(current));
        current = [];
      }
      if (piece) current.push({ text: piece, cls: token.cls });
    });
  }
  lines.push(lineOf(current));
  return lines;
};

// 줄 하나를 만든다. 빈 줄이면 공백 한 칸을 넣는다. 에러는 아직 없다(markError가 나중에 얹는다).
const lineOf = (tokens: TToken[]): TLine => ({
  tokens: tokens.length ? tokens : [{ text: " ", cls: cls() }],
  hasError: false,
  error: "",
  underline: null,
});

/** 줄 수. 거터의 번호 개수이자 textarea의 rows다 - 둘이 같아야 번호가 코드와 맞는다. */
export const lineCountOf = (text: string) => text.split("\n").length;

/** 거터에 넣을 줄 번호 - 1부터 줄 수까지. */
export const lineNumbersFor = (text: string) =>
  Array.from({ length: lineCountOf(text) }, (_, i) => String(i + 1)).join("\n");

// 화면에서 한 글자가 차지하는 칸 수. 폰트가 monospace라 라틴은 1ch, 한글/한자/가나/전각은
// 2ch다. 컴파일러의 display_width와 같은 목적이지만 기준이 터미널이 아니라 이 편집기다 -
// 탭은 CSS `tab-size: 2`를 따른다(playground.css의 .pg__view).
//
// 완전한 East Asian Width 표가 아니라 `.qubc`에 실제로 나오는 범위만 덮는다. 여기서 빠진
// 문자가 줄에 있으면 그 뒤 밑줄이 그만큼 밀린다.
const charWidth = (c: string) => {
  if (c === "\t") {
    return 2;
  }
  const code = c.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모 초성
    (code >= 0x2e80 && code <= 0x303e) || // CJK 부호, 가나 부호
    (code >= 0x3041 && code <= 0x33ff) || // 가나, 한글 호환 자모, CJK 기호
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 확장 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 통합 한자
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) || // CJK 호환 한자
    (code >= 0xff00 && code <= 0xff60) || // 전각 영숫자/기호
    (code >= 0xffe0 && code <= 0xffe6); // 전각 통화 기호
  return wide ? 2 : 1;
};

// UTF-16 열을 표시 폭으로 환산한다. 진단은 UTF-16 code unit으로 열을 세지만(에디터 규약)
// 화면은 ch로 배치하므로, 그 열까지의 글자들이 실제로 차지하는 칸을 세야 밑줄이 글자에 맞는다.
//
// 열이 줄보다 길면(진단이 줄 끝을 가리키는 경우) 줄 전체 폭을 준다.
const widthUpTo = (text: string, column: number) => {
  let unit = 0;
  let width = 0;
  for (const c of text) {
    if (unit >= column) {
      break;
    }
    unit += c.length; // 서로게이트 페어는 UTF-16으로 2
    width += charWidth(c);
  }
  return width;
};

/** 진단이 가리키는 지점. line/column 모두 0부터 세고 column은 UTF-16 code unit이다. */
export type TPosition = { line: number; column: number };

/**
 * 진단 범위에 걸친 줄들에 밑줄을 얹고, 시작 줄에 메시지를 붙인 새 목록을 만든다.
 * 범위가 줄 목록을 벗어나면 그대로 돌려준다.
 *
 * 여러 줄에 걸친 범위(닫히지 않은 문자열)는 줄마다 자른다 - 시작 줄은 start부터 줄 끝까지,
 * 중간 줄은 전체, 끝 줄은 줄머리부터 end까지다.
 *
 * 빈 구간(소스 끝에서 난 에러)도 가리킬 자리가 있어야 해 최소 1ch를 준다.
 */
export const markError = (lines: TLine[], start: TPosition, end: TPosition, message: string): TLine[] => {
  if (start.line < 0 || start.line >= lines.length) {
    return lines;
  }
  const lastLine = Math.min(end.line, lines.length - 1);
  const marked = lines.slice();
  for (let i = start.line; i <= lastLine; i++) {
    const text = marked[i].tokens.map((t) => t.text).join("");
    const from = i === start.line ? widthUpTo(text, start.column) : 0;
    const to = i === end.line ? widthUpTo(text, end.column) : widthUpTo(text, text.length);
    marked[i] = {
      ...marked[i],
      hasError: i === start.line,
      error: i === start.line ? message : "",
      underline: { from, to: Math.max(to, from + 1) },
    };
  }
  return marked;
};

// 렉서는 커서를 들고 원문을 훑으며 토큰을 밀어 넣는다. 어느 분기도 커서를 반드시 전진시켜야
// 한다 - 안 그러면 무한 루프다. 마지막 분기(한 글자 밀기)가 그 보증이다.

type TScanner = (text: string) => TToken[];

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

// 식별자를 읽는다. 커서가 식별자 시작 문자인 것은 호출자가 확인한다.
const readIdent = (text: string, from: number) => {
  let i = from;
  while (i < text.length && IDENT_PART.test(text[i])) i += 1;
  return text.slice(from, i);
};

// 숫자를 읽는다. 소수점과 단위 없는 정수만 - 화면용이라 지수 표기까지는 안 본다.
const readNumber = (text: string, from: number) => {
  let i = from;
  while (i < text.length && (DIGIT.test(text[i]) || text[i] === ".")) i += 1;
  return text.slice(from, i);
};

// 따옴표 문자열을 읽는다. 닫히지 않으면 줄 끝(또는 파일 끝)까지 - 편집 중간 상태다.
// 백틱만 여러 줄을 허용한다.
const readString = (text: string, from: number) => {
  const quote = text[from];
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return text.slice(from, i + 1);
    if (text[i] === "\n" && quote !== "`") return text.slice(from, i);
    i += 1;
  }
  return text.slice(from);
};

// 공백을 읽는다. 개행도 포함한다 - splitLines가 나중에 자른다.
const readSpace = (text: string, from: number) => {
  let i = from;
  while (i < text.length && SPACE.test(text[i])) i += 1;
  return text.slice(from, i);
};

// `//` 줄 주석 - 줄 끝까지.
const readLineComment = (text: string, from: number) => {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.slice(from) : text.slice(from, end);
};

// `/* */` 블록 주석 - 닫히지 않으면 파일 끝까지.
const readBlockComment = (text: string, from: number) => {
  const end = text.indexOf("*/", from + 2);
  return end === -1 ? text.slice(from) : text.slice(from, end + 2);
};

const scanQubc: TScanner = (text) => {
  const tokens: TToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (SPACE.test(c)) {
      const space = readSpace(text, i);
      tokens.push({ text: space, cls: cls() });
      i += space.length;
      continue;
    }

    // `/`는 주석이거나 self-close(`img( /)`)다 - 뒤 한 글자로 가른다.
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const comment = text[i + 1] === "/" ? readLineComment(text, i) : readBlockComment(text, i);
      tokens.push({ text: comment, cls: cls("comment") });
      i += comment.length;
      continue;
    }

    // 큰따옴표는 값 리터럴, 작은따옴표는 유틸 타입의 키(`Omit<Section, 'title'>`) - 자리가 달라
    // SYNTAX.md가 따옴표로 구분한다. 화면에서는 둘 다 문자열로 둔다.
    if (c === '"' || c === "'") {
      const string = readString(text, i);
      tokens.push({ text: string, cls: cls("string") });
      i += string.length;
      continue;
    }

    // 보간 `{IDENT}` / `{a.b}` - 값을 꺼내 쓰는 자리다. `{`는 블록도 열지만(component/props/
    // template), 보간은 여는 괄호 바로 뒤에 경로가 붙고 곧장 닫힌다는 형태로 갈린다.
    if (c === "{") {
      const path = readInterpolation(text, i);
      if (path !== null) {
        tokens.push({ text: path, cls: cls("interpolation") });
        i += path.length;
        continue;
      }
    }

    // 슬롯 지목(`Header << h1(...)`). 한 토큰으로 둬야 `<`, `<`로 갈리지 않는다.
    if (c === "<" && text[i + 1] === "<") {
      tokens.push({ text: "<<", cls: cls("keyword") });
      i += 2;
      continue;
    }

    // 디렉티브(`@if`/`@for`/`@with`/`@else`/`@slot`)와 이벤트 바인딩(`@click:PICK`)이 같은 `@`로
    // 시작한다. 아는 디렉티브면 키워드, 아니면 DOM 이벤트명이다.
    if (c === "@") {
      const name = readIdent(text, i + 1);
      tokens.push({
        text: `@${name}`,
        cls: cls(QUBC_DIRECTIVES.has(name) ? "keyword" : "event"),
      });
      i += name.length + 1;
      continue;
    }

    if (IDENT_START.test(c)) {
      const ident = readIdent(text, i);
      tokens.push({ text: ident, cls: cls(qubcIdentClass(ident)) });
      i += ident.length;
      continue;
    }

    if (DIGIT.test(c)) {
      const number = readNumber(text, i);
      tokens.push({ text: number, cls: cls("number") });
      i += number.length;
      continue;
    }

    tokens.push({ text: c, cls: cls("punctuation") });
    i += 1;
  }
  return tokens;
};

// `{` 자리에서 보간(`{title}`, `{row.label}`)이면 그 전체를, 아니면 null을 돌려준다.
//
// 파서는 자리로 가르지만(자식 자리의 `{`는 보간, 그 밖은 블록) 렉서는 자리를 모른다. 형태로
// 가른다 - 여는 괄호 바로 뒤에 경로(IDENT[.IDENT]*)가 붙고 곧장 닫히는 것만 보간이다.
// 블록은 `{ label }`처럼 공백이 끼거나 `{` 뒤에 선언/노드가 온다.
const readInterpolation = (text: string, from: number): string | null => {
  let i = from + 1;
  if (i >= text.length || !IDENT_START.test(text[i])) {
    return null;
  }
  while (i < text.length && (IDENT_PART.test(text[i]) || text[i] === ".")) {
    i += 1;
  }
  return text[i] === "}" ? text.slice(from, i + 1) : null;
};

// qubc 식별자의 갈래. 전대문자는 이벤트명(PICK), 대문자 시작은 컴포넌트/별칭(Card, Row)이다 -
// SYNTAX.md의 관례라 형태만 보고 가른다.
const qubcIdentClass = (ident: string) => {
  if (QUBC_KEYWORDS.has(ident)) return "keyword";
  if (QUBC_TYPES.has(ident)) return "type";
  if (/^[A-Z][A-Z0-9_]*$/.test(ident)) return "event";
  if (/^[A-Z]/.test(ident)) return "type";
  return undefined;
};

const scanJs: TScanner = (text) => {
  const tokens: TToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (SPACE.test(c)) {
      const space = readSpace(text, i);
      tokens.push({ text: space, cls: cls() });
      i += space.length;
      continue;
    }

    if (c === "/" && text[i + 1] === "/") {
      const comment = readLineComment(text, i);
      tokens.push({ text: comment, cls: cls("comment") });
      i += comment.length;
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      const comment = readBlockComment(text, i);
      tokens.push({ text: comment, cls: cls("comment") });
      i += comment.length;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const string = readString(text, i);
      // 템플릿 문자열은 `${}` 안이 코드다 - 통째로 한 색이면 화면에서 큰 회색 덩어리가 된다.
      tokens.push(...(c === "`" ? splitTemplate(string) : [{ text: string, cls: cls("string") }]));
      i += string.length;
      continue;
    }

    if (IDENT_START.test(c)) {
      const ident = readIdent(text, i);
      tokens.push({ text: ident, cls: cls(jsIdentClass(ident, text, i)) });
      i += ident.length;
      continue;
    }

    if (DIGIT.test(c)) {
      const number = readNumber(text, i);
      tokens.push({ text: number, cls: cls("number") });
      i += number.length;
      continue;
    }

    tokens.push({ text: c, cls: cls("punctuation") });
    i += 1;
  }
  return tokens;
};

// 템플릿 문자열을 문자열 조각과 `${...}` 보간으로 가른다. 조각을 이으면 원문이 그대로여야
// 한다(원문 복원). 닫히지 않은 `${`는 끝까지 보간으로 본다 - 편집 중간 상태.
const splitTemplate = (text: string): TToken[] => {
  const tokens: TToken[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      const stop = end === -1 ? text.length : end + 1;
      if (i > start) tokens.push({ text: text.slice(start, i), cls: cls("string") });
      tokens.push({ text: text.slice(i, stop), cls: cls("interpolation") });
      i = stop;
      start = stop;
      continue;
    }
    i += 1;
  }
  if (start < text.length) tokens.push({ text: text.slice(start), cls: cls("string") });
  return tokens;
};

// 식별자 하나를 무엇으로 칠할지. 이름만으로는 못 가르는 것들(호출/키/속성)은 뒤에 오는
// 글자를 봐서 정한다 - 정확한 파서가 아니라 화면용이라 이 정도로 충분하다.
const jsIdentClass = (ident: string, text: string, at: number): string | undefined => {
  if (JS_VALUES.has(ident)) return "value";
  if (JS_KEYWORDS.has(ident)) return "keyword";
  if (JS_GLOBALS.has(ident)) return "type";

  const next = nextNonSpace(text, at + ident.length);
  // `이름(` 은 호출/선언. 화면에서 무엇이 실행되는지가 가장 먼저 보여야 한다.
  if (next === "(") return "function";
  // `이름:` 은 객체 키. `?:`(삼항)와 겹치지만 핸들러 소스에서는 키가 압도적이다.
  if (next === ":") return "property";
  // `.이름` 은 속성 접근. 앞 글자로 가른다(`?.`도 같이 잡힌다).
  if (previousNonSpace(text, at) === ".") return "property";
  return undefined;
};

// at부터 처음 나오는 공백 아닌 글자(없으면 빈 문자열). 줄바꿈도 공백으로 본다.
const nextNonSpace = (text: string, at: number): string => {
  let i = at;
  while (i < text.length && SPACE.test(text[i])) i += 1;
  return text[i] ?? "";
};

// at 바로 앞의 공백 아닌 글자(없으면 빈 문자열).
const previousNonSpace = (text: string, at: number): string => {
  let i = at - 1;
  while (i >= 0 && SPACE.test(text[i])) i -= 1;
  return text[i] ?? "";
};

// CSS는 `{}` 안팎으로 의미가 갈린다. 밖은 선택자, 안은 `속성: 값`이고 콜론이 그 경계다.
const scanCss: TScanner = (text) => {
  const tokens: TToken[] = [];
  let i = 0;
  let inBlock = false;
  let afterColon = false;
  while (i < text.length) {
    const c = text[i];

    if (SPACE.test(c)) {
      const space = readSpace(text, i);
      tokens.push({ text: space, cls: cls() });
      i += space.length;
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      const comment = readBlockComment(text, i);
      tokens.push({ text: comment, cls: cls("comment") });
      i += comment.length;
      continue;
    }

    if (c === '"' || c === "'") {
      const string = readString(text, i);
      tokens.push({ text: string, cls: cls("string") });
      i += string.length;
      continue;
    }

    if (c === "{") {
      inBlock = true;
      afterColon = false;
      tokens.push({ text: c, cls: cls("punctuation") });
      i += 1;
      continue;
    }

    if (c === "}") {
      inBlock = false;
      afterColon = false;
      tokens.push({ text: c, cls: cls("punctuation") });
      i += 1;
      continue;
    }

    if (c === ":" && inBlock) {
      afterColon = true;
      tokens.push({ text: c, cls: cls("punctuation") });
      i += 1;
      continue;
    }

    if (c === ";") {
      afterColon = false;
      tokens.push({ text: c, cls: cls("punctuation") });
      i += 1;
      continue;
    }

    if (DIGIT.test(c)) {
      const number = readNumber(text, i);
      // 단위(px, rem)는 숫자에 붙여 한 토큰으로 둔다 - 떼면 색이 갈려 오히려 읽기 나쁘다.
      const unit = readIdent(text, i + number.length);
      tokens.push({ text: number + unit, cls: cls("number") });
      i += number.length + unit.length;
      continue;
    }

    if (IDENT_START.test(c) || c === "-") {
      // 속성명은 `-`로 시작할 수 있다(--files-w, -webkit-*).
      let end = i;
      while (end < text.length && (IDENT_PART.test(text[end]) || text[end] === "-")) end += 1;
      const ident = text.slice(i, end);
      if (end === i) {
        tokens.push({ text: c, cls: cls("punctuation") });
        i += 1;
        continue;
      }
      const name = inBlock && !afterColon ? "property" : inBlock ? undefined : "selector";
      tokens.push({ text: ident, cls: cls(name) });
      i = end;
      continue;
    }

    // 선택자의 `.`/`#`/`&`도 선택자 색으로 둔다 - 이름과 떨어져 보이면 눈에 안 붙는다.
    const selectorMark = !inBlock && (c === "." || c === "#" || c === "&" || c === "*");
    tokens.push({ text: c, cls: cls(selectorMark ? "selector" : "punctuation") });
    i += 1;
  }
  return tokens;
};

// JSON은 콜론 앞 문자열이 키다. 그 구분만 하고 나머지는 리터럴로 둔다.
const scanJson: TScanner = (text) => {
  const tokens: TToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (SPACE.test(c)) {
      const space = readSpace(text, i);
      tokens.push({ text: space, cls: cls() });
      i += space.length;
      continue;
    }

    if (c === '"') {
      const string = readString(text, i);
      // 뒤에 오는 첫 비공백이 `:`면 키다.
      let after = i + string.length;
      while (after < text.length && SPACE.test(text[after])) after += 1;
      const key = text[after] === ":";
      tokens.push({ text: string, cls: cls(key ? "property" : "string") });
      i += string.length;
      continue;
    }

    if (IDENT_START.test(c)) {
      const ident = readIdent(text, i);
      tokens.push({ text: ident, cls: cls(JSON_KEYWORDS.has(ident) ? "keyword" : undefined) });
      i += ident.length;
      continue;
    }

    if (DIGIT.test(c) || (c === "-" && DIGIT.test(text[i + 1] ?? ""))) {
      const number = readNumber(text, c === "-" ? i + 1 : i);
      const full = c === "-" ? `-${number}` : number;
      tokens.push({ text: full, cls: cls("number") });
      i += full.length;
      continue;
    }

    tokens.push({ text: c, cls: cls("punctuation") });
    i += 1;
  }
  return tokens;
};

// 모르는 확장자는 색 없이 원문 그대로 - 하이라이트가 없을 뿐 편집은 되어야 한다.
const scanText: TScanner = (text) => [{ text, cls: cls() }];

const SCANNERS: Record<string, TScanner> = {
  qubc: scanQubc,
  js: scanJs,
  css: scanCss,
  json: scanJson,
  text: scanText,
};
