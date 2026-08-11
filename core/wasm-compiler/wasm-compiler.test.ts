// 실제 .wasm을 인스턴스화해 래퍼가 ABI를 제대로 오가는지 본다.
//
// compiler-wasm 크레이트의 Rust 테스트는 qb_* 함수를 네이티브로 컴파일해 직접 부른다 - 그래서
// wasm32 타깃 산출물이 실제로 로드되는지, 32비트 포인터로 ptr/len이 맞아떨어지는지, 힙이
// 자란 뒤에도 읽기가 성립하는지는 그쪽에서 드러나지 않는다. 그 층이 여기다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { loadCompiler } from "./node.ts";

const ENTRY = "a.qubc";

// qubb 헤더 매직(BYTECODE.md #헤더) - 바이트코드가 온전히 건너왔다는 표시로 쓴다.
const MAGIC = [...new TextEncoder().encode("QBL\0")];

const source = (body: string) => `component A {
  props { title: string }
  events { GO({ title }) }
  template { ${body} }
}`;

const SIMPLE = { [ENTRY]: source("button(@click:GO) { {title} }") };

let compiler: Awaited<ReturnType<typeof loadCompiler>>;

before(async () => {
  compiler = await loadCompiler();
});

test("wasm을 인스턴스화해 컴파일한다", () => {
  const result = compiler.compile(SIMPLE, ENTRY);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.ok(result.bytecode.length > 0);
  assert.deepEqual([...result.bytecode.slice(0, 4)], MAGIC);
  assert.deepEqual(result.resources, []);
});

test("합성 트리를 걸어 핸들러 fullname을 낸다", () => {
  assert.deepEqual(compiler.handlerNames(SIMPLE, ENTRY), ["GO"]);
});

test("실패하면 진단 텍스트가 온다", () => {
  const result = compiler.compile({ [ENTRY]: "component A { template { p() { {nope} } } }" }, ENTRY);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.match(result.diagnostic, /error/);
});

// 진단은 한국어를 담을 수 있고 소스도 그렇다 - ptr/len이 바이트 길이라 문자 수로 세면 잘린다.
test("멀티바이트 문자가 왕복해도 온전하다", () => {
  const files = { [ENTRY]: source('button(@click:GO) { "한글 テスト" }') };
  const result = compiler.compile(files, ENTRY);
  assert.equal(result.ok, true);
});

// 힙이 자라면 기존 ArrayBuffer가 detach된다(wasm-compiler.ts 머리주석). 뷰를 캐싱하면 그 뒤로
// 빈 배열이 되므로, 한 번에 여러 페이지를 넘길 만큼 큰 입력으로 그 경로를 태운다.
test("힙이 자라는 큰 입력도 결과가 온전하다", () => {
  const many = Array.from({ length: 4000 }, (_, i) => `p(class="c${i}") { "line ${i}" }`).join("\n      ");
  const result = compiler.compile({ [ENTRY]: source(many) }, ENTRY);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual([...result.bytecode.slice(0, 4)], MAGIC);
});

// out 슬롯은 하나라 다음 호출이 덮어쓴다 - 래퍼가 복사해 두지 않으면 앞 결과가 뒤 것으로 바뀐다.
// 뒤 컴파일을 훨씬 크게 해 슬롯 내용이 확실히 달라지게 한다 - 결과가 비슷하면 뷰로 들고 있어도
// 우연히 같은 바이트가 보여 통과한다.
test("연속 호출이 앞 결과를 덮어쓰지 않는다", () => {
  const first = compiler.compile(SIMPLE, ENTRY);
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  const kept = [...first.bytecode];

  const many = Array.from({ length: 500 }, (_, i) => `p(class="x${i}") { "row ${i}" }`).join("\n      ");
  compiler.compile({ [ENTRY]: source(many) }, ENTRY);
  assert.deepEqual([...first.bytecode], kept);
});

// qb_reset이 앞 호출의 파일 목록을 비우는지 - 남아 있으면 지운 파일의 use가 계속 풀린다.
test("호출마다 파일 목록이 새로 시작한다", () => {
  compiler.compile({ "b.qubc": source('p() { "b" }'), [ENTRY]: SIMPLE[ENTRY] }, ENTRY);

  const result = compiler.compile({ [ENTRY]: `use B from "./b.qubc"\n${SIMPLE[ENTRY]}` }, ENTRY);
  assert.equal(result.ok, false);
});

test("핸들러 d.ts 텍스트를 낸다", () => {
  const result = compiler.handlersDts(SIMPLE, ENTRY);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.match(result.dts, /export interface THandlers \{/);
  assert.match(result.dts, /type TProps_A = \{ title: TLeafIndex<string> \};/);
  assert.match(result.dts, /'GO': THandler<\{ title: string \}, TProps_A/);
});

// handlerNames는 실패를 빈 배열로 뭉개지만 d.ts는 이유를 돌려준다.
test("d.ts가 실패하면 진단이 온다", () => {
  const result = compiler.handlersDts({ [ENTRY]: "component A { template {" }, ENTRY);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.match(result.diagnostic, /error/);
});

test("use 그래프를 등록된 파일로 해소한다", () => {
  const files = {
    "child.qubc": `component Child {
  props { label: string }
  events { TAP({ label }) }
  template { span(@click:TAP) { {label} } }
}`,
    [ENTRY]: `use Child from "./child.qubc"
component A {
  props { title: string }
  template { div() { Kid: Child(label={title} /) } }
}`,
  };
  assert.deepEqual(compiler.handlerNames(files, ENTRY), ["Kid.TAP"]);
});

test("컴파일이 되면 진단이 없다", () => {
  assert.equal(compiler.diagnose(SIMPLE, ENTRY), null);
});

// 한글이 앞선 줄에서 컬럼을 본다 - JS 문자열 인덱스가 곧 UTF-16이라, indexOf가 준 자리와
// 맞으면 에디터가 짚을 자리와 같다. 컴파일러가 바이트로 셌다면 한글 2자만큼 4칸 더 나간다.
test("진단이 구간을 0-based/UTF-16으로 낸다", () => {
  const line = `  template { p() { "가나" {nope} } }`;
  const files = {
    [ENTRY]: `component A {
${line}
}`,
  };
  const d = compiler.diagnose(files, ENTRY);

  assert.equal(d?.path, ENTRY);
  assert.match(d?.message ?? "", /nope/);
  assert.deepEqual(d?.start, { line: 1, column: line.indexOf("nope") });
  assert.deepEqual(d?.end, { line: 1, column: line.indexOf("nope") + "nope".length });
});

// 에디터가 밑줄을 그을 파일이 엔트리가 아닐 수 있다 - 그 이름으로 문서를 되찾는다.
test("use한 파일의 에러는 그 파일을 가리킨다", () => {
  const files = {
    "child.qubc": `component Child {
  template { p() { {nope} } }
}`,
    [ENTRY]: `use Child from "./child.qubc"
component A { template { Child( /) } }`,
  };
  const d = compiler.diagnose(files, ENTRY);

  assert.equal(d?.path, "child.qubc");
  assert.equal(d?.start.line, 1);
});

// use 대상을 못 찾으면 그 경로를 짚는다 - 파일 첫 줄로 밀리지 않는다.
test("못 찾은 use 경로에 밑줄이 걸린다", () => {
  const line = `use B from "./nope.qubc"`;
  const files = { [ENTRY]: `${line}\n${SIMPLE[ENTRY]}` };
  const d = compiler.diagnose(files, ENTRY);

  assert.deepEqual(d?.start, { line: 0, column: line.indexOf('"') });
  assert.deepEqual(d?.end, { line: 0, column: line.length });
  assert.match(d?.message ?? "", /nope\.qubc/);
});
