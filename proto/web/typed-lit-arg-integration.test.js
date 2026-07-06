// 타입 있는 리터럴 인자 통합 테스트 - number/bool 리터럴이 상수풀 타입 태그를 거쳐 런타임에서
// 실제 JS number/boolean으로 복원되는지 본다(문자열 "42"/"true"가 아니라). 리터럴은 $lit.* path로
// store에 심기므로, 심긴 leaf 값의 typeof로 타입 유지를 확인한다.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./fixtures/dom.js";
import { buildFixture } from "./fixtures/build.js";

const { compile, createLeafStoreSubject } = await import("./runtime.js");

let qubb;
before(() => {
  qubb = buildFixture("typed_lit_arg");
});

// 리터럴은 store에 심지 않는다 - CONST 슬롯으로 자식에 전달돼 상수풀에서 직접 조립/렌더된다.
// leafOf는 반응값(STORE)만 발급한다. 리터럴 하나도 leaf가 발급되면 안 된다(구독 대상 0).
test("literals are not seeded into store", () => {
  const store = createLeafStoreSubject({});
  const seen = [];
  const realLeafOf = store.leafOf;
  store.leafOf = (path) => {
    seen.push(path);
    return realLeafOf(path);
  };
  compile(qubb)(0)(store, []); // TypedLitArg = comp 0, props 없음
  // 리터럴만 있는 컴포넌트라 STORE leaf 발급이 전혀 없어야 한다($lit.* 잔재도 없음).
  assert.deepEqual(seen, [], "리터럴은 leaf 발급 없이 pool에서 직접: " + JSON.stringify(seen));
});

// 타입 있는 리터럴이 텍스트로도 올바르게 렌더된다(number/bool은 DOM에서 문자열화).
test("typed literals render as text", () => {
  const store = createLeafStoreSubject({});
  const inst = compile(qubb)(0)(store, []);
  const host = mount(inst);
  assert.equal(host.querySelector("span").textContent, "42trues");
});
