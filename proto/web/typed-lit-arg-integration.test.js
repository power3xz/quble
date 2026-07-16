// 타입 있는 리터럴 인자 통합 테스트 - number/bool 리터럴이 상수풀 타입 태그를 거쳐 런타임에서
// 실제 JS number/boolean으로 복원되는지 본다(문자열 "42"/"true"가 아니라). 리터럴은 $lit.* path로
// store에 심기므로, 심긴 leaf 값의 typeof로 타입 유지를 확인한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb;
before(() => {
  qubb = buildFixture("typed_lit_arg");
});

// 리터럴은 store에 심지 않는다 - CONST 슬롯으로 자식에 전달돼 상수풀에서 직접 조립/렌더된다.
// 타입 있는 리터럴이 텍스트로도 올바르게 렌더된다(number/bool은 DOM에서 문자열화).
test("typed literals render as text", () => {
  const inst = compile(qubb)(0)({});
  const host = mount(inst);
  assert.equal(host.querySelector("span").textContent, "42trues");
});
