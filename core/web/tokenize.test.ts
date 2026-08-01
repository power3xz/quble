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
import { markError, type TLine, tokenize } from "../../components/tokenize.ts";

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

test("qubc - 주석 문법이 없다", () => {
  // `/`는 self-close(`img( /)`)로만 쓰인다. `//`를 주석으로 칠하면 없는 문법을 있는 것처럼
  // 보여 준다.
  const lines = tokenize("// not a comment\nuse x", "a.qubc");

  assert.deepEqual(textsOf(lines, "comment"), []);
  assert.deepEqual(textsOf(lines, "keyword"), ["use"]);
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

test("에러가 그 줄에만 붙는다", () => {
  const lines = markError(tokenize("a\nb\nc", "a.qubc"), 2, "무언가 잘못됐다");

  assert.deepEqual(
    lines.map((l) => l.hasError),
    [false, true, false],
  );
  assert.equal(lines[1].error, "무언가 잘못됐다");
});

test("에러를 얹어도 원문은 그대로다", () => {
  // 표시가 토큰을 건드리면 화면이 textarea와 어긋난다.
  const source = "use x\ncomponent A {\n}";

  assert.equal(rejoin(markError(tokenize(source, "a.qubc"), 2, "err")), source);
});

test("범위 밖 줄 번호는 무시한다", () => {
  const lines = tokenize("a\nb", "a.qubc");

  assert.deepEqual(markError(lines, 9, "err"), lines, "너무 큼");
  assert.deepEqual(markError(lines, 0, "err"), lines, "0은 1부터 세는 규칙 밖");
});

test("표시 없는 줄은 hasError가 꺼져 있다", () => {
  for (const line of tokenize("a\nb", "a.qubc")) {
    assert.equal(line.hasError, false);
    assert.equal(line.error, "");
  }
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
