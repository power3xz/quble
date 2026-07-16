// 리터럴 인자 통합 테스트 - 실제 컴파일러(.qubc → .qubb)와 실제 runtime.js를 jsdom 위에서
// 돌린다. use-site 리터럴(`Label(text="고정")`)이 부모 scope 없이 PUSH_ARG_LIT로 상수풀에서
// 자식에 CONST 슬롯으로 전달돼 렌더되는지 본다(store를 거치지 않음).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb;
before(() => {
  qubb = buildFixture("lit_arg");
});

// 리터럴 인자가 클라 런타임에서 렌더된다 - 부모 scope가 비어도 자식이 상수값을 받아 출력.
test("literal arg renders in client runtime", () => {
  const inst = compile(qubb)(0)({}); // LitArg = comp 0, props 없음
  const host = mount(inst);
  const spans = [...host.querySelectorAll("span")].map((s) => s.textContent);
  assert.deepEqual(spans, ["고정", "고정"]);
});
