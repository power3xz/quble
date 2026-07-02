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

// number/bool 리터럴이 store에 그 타입 그대로 심긴다 - 상수풀 태그 디코드가 값을 복원한다.
test("number/bool literals keep their JS type in store", () => {
  const store = createLeafStoreSubject({});
  // $lit.* path로 심긴 값을 leafOf->get으로 모은다.
  const litValues = [];
  const realLeafOf = store.leafOf;
  store.leafOf = (path) => {
    const leafIndex = realLeafOf(path);
    if (typeof path === "string" && path.startsWith("$lit.")) {
      litValues.push(store.get(leafIndex));
    }
    return leafIndex;
  };
  compile(qubb)(0)(store, []); // TypedLitArg = comp 0, props 없음

  // 세 리터럴(42, true, "s")이 각 타입 그대로다.
  assert.ok(litValues.includes(42), "number 42가 심겨야: " + JSON.stringify(litValues));
  assert.ok(litValues.includes(true), "boolean true가 심겨야: " + JSON.stringify(litValues));
  assert.ok(litValues.includes("s"), "string 's'가 심겨야: " + JSON.stringify(litValues));
  // 문자열로 오염되지 않았는지(회귀 방지) - "42"/"true"가 있으면 실패.
  assert.ok(!litValues.includes("42"), "number가 문자열로 오염되면 안 됨");
  assert.ok(!litValues.includes("true"), "boolean이 문자열로 오염되면 안 됨");
});

// 타입 있는 리터럴이 텍스트로도 올바르게 렌더된다(number/bool은 DOM에서 문자열화).
test("typed literals render as text", () => {
  const store = createLeafStoreSubject({});
  const inst = compile(qubb)(0)(store, []);
  const host = mount(inst);
  assert.equal(host.querySelector("span").textContent, "42trues");
});
