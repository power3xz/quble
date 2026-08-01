// playground 편집기의 신택스 하이라이트. 소스를 줄 단위 토큰으로 쪼갠다.
//
// 줄 단위인 이유: 화면(.pg__view)이 줄마다 요소를 두고, 그 높이가 거터의 줄 번호와 겹쳐 있는
// textarea의 줄 높이에 맞아야 한다. 토큰을 평평하게 늘어놓고 개행을 토큰으로 섞으면 빈 줄이
// 높이를 잃어 셋이 어긋난다.
//
// 정확한 파서가 아니라 화면용 렉서다 - 문법 오류가 있는 편집 중간 상태도 무조건 토큰을 낸다.
// 어떤 입력에도 원문이 그대로 복원돼야 한다(토큰 text를 이으면 원본).

export type TToken = { text: string; cls: string };
// hasError/error는 토크나이저가 아니라 진단이 채운다(markError) - 문법 오류는 렉서가 아는 것이
// 아니라 컴파일러가 말해 주는 것이다. 여기 두는 건 줄 하나의 화면 표현이 이 타입이기 때문이다.
export type TLine = { tokens: TToken[]; hasError: boolean; error: string };

// qubc 예약어는 SYNTAX.md 전체를 따른다 - 선언 블록(#1), 디렉티브(#4), 타입(#2.1).
// 다른 언어는 화면에서 눈에 띄어야 하는 것만 고른다(완전한 목록이 목적이 아니다).
const QUBC_KEYWORDS = new Set([
  "use", "from", "component", "props", "contexts", "events", "template",
  "of", // @for (x of y)
]);
// 디렉티브(@로 시작). @slot은 자리 선언, 나머지는 블록을 연다.
const QUBC_DIRECTIVES = new Set(["if", "else", "for", "with", "slot"]);
// 원시 3종과 유틸 타입(Omit/Pick). 배열/객체는 문법 기호라 여기 없다.
const QUBC_TYPES = new Set(["string", "number", "bool", "Omit", "Pick"]);
const JS_KEYWORDS = new Set([
  "export", "default", "import", "from", "const", "let", "var", "function",
  "return", "if", "else", "for", "of", "in", "while", "new", "class",
  "async", "await", "try", "catch", "finally", "throw", "typeof", "null",
  "undefined", "true", "false", "this",
]);
const JSON_KEYWORDS = new Set(["true", "false", "null"]);

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
});

/** 진단이 가리키는 줄(1부터)에 메시지를 얹은 새 목록을 만든다. 범위 밖이면 그대로 돌려준다. */
export const markError = (lines: TLine[], line: number, message: string): TLine[] => {
  const i = line - 1;
  if (i < 0 || i >= lines.length) {
    return lines;
  }
  const marked = lines.slice();
  marked[i] = { ...marked[i], hasError: true, error: message };
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

    // qubc에는 주석이 없다 - `/`는 self-close(`img( /)`)로만 쓰인다.

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
      tokens.push({ text: string, cls: cls("string") });
      i += string.length;
      continue;
    }

    if (IDENT_START.test(c)) {
      const ident = readIdent(text, i);
      tokens.push({ text: ident, cls: cls(JS_KEYWORDS.has(ident) ? "keyword" : undefined) });
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
