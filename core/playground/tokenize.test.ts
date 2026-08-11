// playground 편집기 토크나이저.
//
// 가장 중요한 성질은 원문 복원이다 - 화면(.pg__view)이 textarea와 정확히 겹쳐야 캐럿이 글자와
// 맞는데, 한 글자라도 먹거나 더하면 그 줄부터 전부 어긋난다. 그래서 어떤 입력이든 토큰 text를
// 이으면 원본이 나와야 한다(빈 줄 채움 한 칸만 예외).
//
// 편집 중간 상태(닫히지 않은 문자열/주석)도 반드시 토큰을 내야 한다 - 타이핑 도중에는 늘
// 문법이 깨져 있다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { markError, type TLine, tokenize } from "./tokenize.ts";

// 줄을 다시 이어 원문을 만든다. 빈 줄에 넣은 공백 한 칸은 되돌린다.
const rejoin = (lines: TLine[]) =>
  lines
    .map((line) => {
      const text = line.tokens.map((t) => t.text).join("");
      return text === " " ? "" : text;
    })
    .join("\n");

// 특정 클래스가 붙은 토큰의 텍스트만 모은다.
const textsOf = (lines: TLine[], name: string) =>
  lines.flatMap((line) => line.tokens.filter((t) => t.cls === `tok tok--${name}`).map((t) => t.text));

// SYNTAX.md의 문법 요소를 한 번씩 지나가는 소스 - 선언 블록 넷, 디렉티브 다섯, 슬롯 지목,
// 유틸 타입, 보간.
const QUBC = `use Card from "./card.qubc"
use "./card.css"

component Panel {
  props { label: string, rows: Omit<Card, 'id'>[], count: number, on: bool }
  contexts { Area { section: "actions", userId: label } }
  events { PICK({ label }) }
  template {
    @with Area {
      button(class="card" @click:PICK) { "담당자: " {label} }
      @if (on) { span() { {count} } } @else { hr( /) }
      @for (row, i of rows) {
        Item: Card(id={row.id} /)
      }
      Shell: Card( ) {
        Header << h1() { {label} }
      }
      @slot(Body)
    }
  }
}
`;

const JS = `import { x } from "./x.js";
/* 블록
   주석 */
export default {
  "Card.PICK": (data) => {
    console.log(\`picked: \${data.label}\`, 42);
  },
};
`;

const CSS = `/* 주석 */
.app__title, #main > .row:hover {
  --files-w: 24rem;
  font-size: 1.6rem;
  content: "x";
}
`;

const JSON_SRC = `{
  "title": "Hello quble",
  "count": 42,
  "ok": true,
  "off": -1.5,
  "none": null
}
`;

const CASES: [string, string][] = [
  ["a.qubc", QUBC],
  ["a.handlers.js", JS],
  ["a.css", CSS],
  ["a.json", JSON_SRC],
  ["a.txt", "모르는 확장자\n두 줄"],
];

test("원문이 그대로 복원된다", () => {
  for (const [name, source] of CASES) {
    assert.equal(rejoin(tokenize(source, name)), source, name);
  }
});

test("줄 수가 원문과 같다", () => {
  for (const [name, source] of CASES) {
    assert.equal(tokenize(source, name).length, source.split("\n").length, name);
  }
});

test("빈 줄에도 토큰이 하나는 있다", () => {
  // 요소에 내용이 없으면 높이가 안 생겨 거터/textarea와 어긋난다.
  for (const [name, source] of CASES) {
    for (const line of tokenize(source, name)) {
      assert.ok(line.tokens.length > 0, name);
      assert.ok(
        line.tokens.some((t) => t.text.length > 0),
        name,
      );
    }
  }
});

test("qubc - 선언 블록과 디렉티브가 모두 키워드다", () => {
  const lines = tokenize(QUBC, "a.qubc");

  // SYNTAX.md #1(선언 블록), #4(디렉티브), 슬롯 지목 `<<`, @for의 `of`.
  assert.deepEqual(textsOf(lines, "keyword"), [
    "use",
    "from",
    "use",
    "component",
    "props",
    "contexts",
    "events",
    "template",
    "@with",
    "@if",
    "@else",
    "@for",
    "of",
    "<<",
    "@slot",
  ]);
});

test("qubc - 타입과 유틸 타입을 가른다", () => {
  const lines = tokenize(QUBC, "a.qubc");

  // 원시 3종 + Omit/Pick. 대문자 시작 식별자(Card, Panel...)도 type으로 묶인다.
  const types = textsOf(lines, "type");
  for (const expected of ["string", "number", "bool", "Omit"]) {
    assert.ok(types.includes(expected), `${expected} 누락`);
  }
});

test("qubc - 이벤트명과 이벤트 바인딩을 가른다", () => {
  const lines = tokenize(QUBC, "a.qubc");

  // 전대문자는 이벤트명, `@click`은 DOM 이벤트 바인딩(디렉티브가 아니다).
  assert.deepEqual(textsOf(lines, "event"), ["PICK", "@click", "PICK"]);
});

test("qubc - 자식 자리 보간을 가른다", () => {
  const lines = tokenize(QUBC, "a.qubc");

  // 값을 꺼내 쓰는 자리 - 경로 접근(row.id)도 한 토큰이다.
  assert.deepEqual(textsOf(lines, "interpolation"), ["{label}", "{count}", "{row.id}", "{label}"]);
});

test("qubc - 주석을 가른다", () => {
  const src = "component X {\n  // 줄 주석\n  /* 여러\n     줄 */\n  template { img( /) }\n}";
  const lines = tokenize(src, "a.qubc");

  // 블록 주석은 줄이 갈려도 각 조각이 주석으로 남는다.
  assert.deepEqual(textsOf(lines, "comment"), ["// 줄 주석", "/* 여러", "     줄 */"]);
  assert.equal(rejoin(lines), src, "원문 복원");
});

test("qubc - self-close `/`는 주석이 아니다", () => {
  const lines = tokenize("component X {\n  template { img( /) }\n}", "a.qubc");

  assert.deepEqual(textsOf(lines, "comment"), []);
});

// 편집 중간 상태 - 타이핑 도중에는 늘 닫혀 있지 않다.
test("qubc - 안 닫힌 블록 주석도 토큰을 낸다", () => {
  const src = "component X {\n  /* 쓰다 말았다\n";
  const lines = tokenize(src, "a.qubc");

  assert.equal(rejoin(lines), src, "원문 복원");
  assert.deepEqual(textsOf(lines, "comment"), ["/* 쓰다 말았다"]);
});

test("qubc - 블록 여는 괄호는 보간이 아니다", () => {
  // `{`는 블록도 연다(component/props/template). 형태로 갈린다.
  const lines = tokenize("component X {\n  props { a: string }\n}", "a.qubc");

  assert.deepEqual(textsOf(lines, "interpolation"), []);
});

test("qubc - 문자열 안 중괄호는 그냥 문자열이다", () => {
  // 문자열 안 보간은 구현되어 있지 않다(렉서가 따옴표 사이를 통째로 담는다).
  const source = 'span() { "담당자: {label}" }';

  const lines = tokenize(source, "a.qubc");
  assert.equal(rejoin(lines), source);
  assert.deepEqual(textsOf(lines, "interpolation"), []);
  assert.deepEqual(textsOf(lines, "string"), ['"담당자: {label}"']);
});

test("qubc - 작은따옴표는 유틸 타입 키다", () => {
  const lines = tokenize(QUBC, "a.qubc");

  assert.ok(textsOf(lines, "string").includes("'id'"));
});

test("qubc - 줄 주석은 그 줄만 먹는다", () => {
  const lines = tokenize("// 주석\nuse x", "a.qubc");

  assert.deepEqual(textsOf(lines, "comment"), ["// 주석"]);
  assert.deepEqual(textsOf(lines, "keyword"), ["use"], "다음 줄은 정상 토큰이다");
});

test("qubc - 보간이 여럿이어도 원문을 지킨다", () => {
  const source = 'span() { {a} "와" {b} }';

  const lines = tokenize(source, "a.qubc");
  assert.equal(rejoin(lines), source);
  assert.deepEqual(textsOf(lines, "interpolation"), ["{a}", "{b}"]);
});

test("qubc - 닫히지 않은 보간은 보간이 아니다", () => {
  // 편집 중간 상태. 멈추지 않고 원문만 지키면 된다.
  const source = "span() { {a 열기만 }";

  const lines = tokenize(source, "a.qubc");
  assert.equal(rejoin(lines), source);
  assert.deepEqual(textsOf(lines, "interpolation"), []);
});

test("js - 키워드/문자열/주석을 가른다", () => {
  const lines = tokenize(JS, "a.handlers.js");

  assert.deepEqual(textsOf(lines, "keyword"), ["import", "from", "export", "default"]);
  assert.deepEqual(textsOf(lines, "number"), ["42"]);
  // 백틱 문자열은 한 토큰이고, 블록 주석은 두 줄에 걸쳐 잘린다.
  assert.deepEqual(textsOf(lines, "comment"), ["/* 블록", "   주석 */"]);
});

test("js - 호출되는 이름을 가른다", () => {
  // 무엇이 실행되는지가 화면에서 가장 먼저 읽혀야 한다. `이름(` 형태로 잡는다.
  const lines = tokenize("push(props.columns, x);\nconsole.log(1);", "a.js");

  assert.deepEqual(textsOf(lines, "function"), ["push", "log"]);
});

test("js - 객체 키와 속성 접근을 가른다", () => {
  const lines = tokenize("const o = { name: 1 };\no.title;\na?.b;", "a.js");

  assert.deepEqual(textsOf(lines, "property"), ["name", "title", "b"]);
});

test("js - 값 리터럴과 전역을 키워드와 갈라 놓는다", () => {
  const lines = tokenize("const a = null;\nJSON.stringify(this, undefined);", "a.js");

  assert.deepEqual(textsOf(lines, "value"), ["null", "this", "undefined"]);
  assert.deepEqual(textsOf(lines, "type"), ["JSON"]);
  // const만 키워드다 - null/this가 여기 섞이면 값과 문법이 같은 색이 된다.
  assert.deepEqual(textsOf(lines, "keyword"), ["const"]);
});

// `${`를 소스 문자열에 직접 쓰면 린터가 템플릿 오타로 본다 - 조각을 이어 만든다.
const DOLLAR = "$";

test("js - 템플릿 문자열의 보간을 가른다", () => {
  const source = `const s = \`새 ${DOLLAR}{n} 개, ${DOLLAR}{a.b}\`;`;

  const lines = tokenize(source, "a.js");
  assert.equal(rejoin(lines), source, "원문 복원");
  assert.deepEqual(textsOf(lines, "interpolation"), [`${DOLLAR}{n}`, `${DOLLAR}{a.b}`]);
  assert.deepEqual(textsOf(lines, "string"), ["`새 ", " 개, ", "`"]);
});

test("js - 닫히지 않은 보간도 원문을 지킨다", () => {
  // 편집 중간 상태 - 보간을 열기만 하고 멈춘 순간.
  const source = `const s = \`열기만 ${DOLLAR}{n`;

  const lines = tokenize(source, "a.js");
  assert.equal(rejoin(lines), source);
});

test("js - 보간 없는 템플릿 문자열은 한 덩어리다", () => {
  const lines = tokenize("const s = `그냥 문자열`;", "a.js");

  assert.deepEqual(textsOf(lines, "string"), ["`그냥 문자열`"]);
  assert.deepEqual(textsOf(lines, "interpolation"), []);
});

test("js - 확장자가 겹쳐도 마지막 조각으로 고른다", () => {
  // main.qubc.handlers.js는 js다(qubc가 아니다).
  const lines = tokenize("export default {}", "main.qubc.handlers.js");

  assert.deepEqual(textsOf(lines, "keyword"), ["export", "default"]);
});

test("css - 선택자/속성/값을 가른다", () => {
  const lines = tokenize(CSS, "a.css");

  assert.deepEqual(textsOf(lines, "property"), ["--files-w", "font-size", "content"]);
  assert.deepEqual(textsOf(lines, "selector"), [".", "app__title", "#", "main", ".", "row", "hover"]);
  // 단위는 숫자에 붙여 한 토큰이다.
  assert.deepEqual(textsOf(lines, "number"), ["24rem", "1.6rem"]);
  assert.deepEqual(textsOf(lines, "string"), ['"x"']);
});

test("json - 키와 값 문자열을 가른다", () => {
  const lines = tokenize(JSON_SRC, "a.json");

  assert.deepEqual(textsOf(lines, "property"), ['"title"', '"count"', '"ok"', '"off"', '"none"']);
  assert.deepEqual(textsOf(lines, "string"), ['"Hello quble"']);
  assert.deepEqual(textsOf(lines, "number"), ["42", "-1.5"]);
  assert.deepEqual(textsOf(lines, "keyword"), ["true", "null"]);
});

// 편집 중간 상태 - 타이핑 도중에는 늘 문법이 깨져 있다. 멈추거나 글자를 잃으면 안 된다.

test("닫히지 않은 문자열도 원문을 지킨다", () => {
  const broken = 'use "./card\ncomponent Card {';

  const lines = tokenize(broken, "a.qubc");
  assert.equal(rejoin(lines), broken);
  // 줄을 넘지 않는다 - 다음 줄은 문자열이 아니다.
  assert.deepEqual(textsOf(lines, "string"), ['"./card']);
  assert.deepEqual(textsOf(lines, "keyword"), ["use", "component"]);
});

test("닫히지 않은 블록 주석도 원문을 지킨다", () => {
  const broken = "/* 열기만\nconst x = 1;";

  const lines = tokenize(broken, "a.js");
  assert.equal(rejoin(lines), broken);
  // 끝까지 주석이다.
  assert.deepEqual(textsOf(lines, "keyword"), []);
});

test("빈 문자열도 한 줄을 낸다", () => {
  const lines = tokenize("", "a.qubc");

  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].tokens, [{ text: " ", cls: "tok" }]);
});

// 에러 표시 - 토크나이저가 아니라 진단이 얹는다. 줄 요소의 화면 표현이라 여기 있다.
// 진단의 line/column은 0부터 세고 column은 UTF-16 code unit이다. 밑줄의 from/to는 표시 폭(ch)이다.

// 한 줄 안의 범위. 진단이 대개 이 모양이라 짧게 쓴다.
const at = (line: number, from: number, to: number) => [
  { line, column: from },
  { line, column: to },
] as const;

test("에러가 그 줄에만 붙는다", () => {
  const [start, end] = at(1, 0, 1);
  const lines = markError(tokenize("a\nb\nc", "a.qubc"), start, end, "무언가 잘못됐다");

  assert.deepEqual(
    lines.map((l) => l.hasError),
    [false, true, false],
  );
  assert.equal(lines[1].error, "무언가 잘못됐다");
});

test("에러를 얹어도 원문은 그대로다", () => {
  // 표시가 토큰을 건드리면 화면이 textarea와 어긋난다.
  const source = "use x\ncomponent A {\n}";
  const [start, end] = at(1, 0, 9);

  assert.equal(rejoin(markError(tokenize(source, "a.qubc"), start, end, "err")), source);
});

test("범위 밖 줄 번호는 무시한다", () => {
  const lines = tokenize("a\nb", "a.qubc");
  const [tooBig, tooBigEnd] = at(9, 0, 1);
  const [negative, negativeEnd] = at(-1, 0, 1);

  assert.deepEqual(markError(lines, tooBig, tooBigEnd, "err"), lines, "너무 큼");
  assert.deepEqual(markError(lines, negative, negativeEnd, "err"), lines, "0부터 세는 규칙 밖");
});

test("표시 없는 줄은 hasError가 꺼져 있다", () => {
  for (const line of tokenize("a\nb", "a.qubc")) {
    assert.equal(line.hasError, false);
    assert.equal(line.error, "");
    assert.equal(line.underline, null);
  }
});

test("밑줄이 진단 범위를 덮는다", () => {
  // "  p() { {user.nope} }" - user.nope에 밑줄.
  const source = "  p() { {user.nope} }";
  const [start, end] = at(0, 9, 18);
  const lines = markError(tokenize(source, "a.qubc"), start, end, "err");

  assert.deepEqual(lines[0].underline, { from: 9, to: 18 });
  assert.equal(source.slice(9, 18), "user.nope", "표시할 자리가 그 식이다");
});

test("한글 앞 밑줄은 표시 폭으로 밀린다", () => {
  // 한글은 monospace에서 2ch다 - UTF-16 열을 그대로 쓰면 밑줄이 글자보다 왼쪽에 선다.
  // 열 3은 `"가나`까지(1 + 2x2 = 5ch), 열 4는 `"가나다`까지(1 + 3x2 = 7ch)다.
  const [start, end] = at(0, 3, 4);
  const lines = markError(tokenize('"가나다" x', "a.qubc"), start, end, "err");

  assert.deepEqual(lines[0].underline, { from: 5, to: 7 }, "`다` 한 글자가 2ch를 차지한다");
});

test("빈 구간도 최소 한 칸을 차지한다", () => {
  // 소스 끝에서 난 에러는 start == end다. 폭이 0이면 밑줄이 안 보인다.
  const [start, end] = at(0, 3, 3);
  const lines = markError(tokenize("abc", "a.qubc"), start, end, "err");

  assert.deepEqual(lines[0].underline, { from: 3, to: 4 });
});

test("여러 줄 범위는 줄마다 잘린다", () => {
  // 닫히지 않은 문자열이 이렇게 온다 - 시작 줄은 start부터 줄 끝까지, 끝 줄은 줄머리부터 end까지.
  const lines = markError(
    tokenize('a "열림\nbbbb\ncc', "a.qubc"),
    { line: 0, column: 2 },
    { line: 2, column: 1 },
    "unterminated string",
  );

  assert.deepEqual(lines[0].underline, { from: 2, to: 7 }, '따옴표 1 + 한글 2자 x 2ch');
  assert.deepEqual(lines[1].underline, { from: 0, to: 4 }, "중간 줄은 전체");
  assert.deepEqual(lines[2].underline, { from: 0, to: 1 }, "끝 줄은 end까지");
});

test("여러 줄 범위에서 메시지는 시작 줄에만 붙는다", () => {
  const lines = markError(tokenize("aa\nbb\ncc", "a.qubc"), { line: 0, column: 0 }, { line: 1, column: 2 }, "err");

  assert.deepEqual(
    lines.map((l) => l.hasError),
    [true, false, false],
    "줄 배경/막대는 시작 줄만 - 여러 줄이 다 물들면 어디가 원인인지 흐려진다",
  );
  assert.equal(lines[1].error, "");
  assert.notEqual(lines[1].underline, null, "밑줄은 걸친 줄마다 있다");
});

test("범위 끝이 줄 목록을 넘으면 마지막 줄에서 멎는다", () => {
  const lines = markError(tokenize("aa\nbb", "a.qubc"), { line: 0, column: 0 }, { line: 9, column: 0 }, "err");

  assert.equal(lines.length, 2);
  assert.notEqual(lines[1].underline, null);
});

test("끝이 개행이면 마지막 빈 줄이 남는다", () => {
  // 거터의 줄 번호가 같은 규칙(text.split("\n").length)이라 개수가 맞아야 한다.
  const lines = tokenize("use x\n", "a.qubc");

  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1].tokens, [{ text: " ", cls: "tok" }]);
});

test("탭과 공백이 보존된다", () => {
  const source = "\tif (x) {\n    y\n}";

  assert.equal(rejoin(tokenize(source, "a.js")), source);
});
