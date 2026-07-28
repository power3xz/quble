// 버블 차단 디폴트 통합 테스트 - 부모(div)/자식(button)에 같은 DOM 이벤트(@click) 위임이
// 걸렸을 때, 자식 클릭이 자기 핸들러만 부르고 부모 핸들러로 버블하지 않는지.
// runtime.js의 위임 리스너가 stopPropagation을 디폴트로 호출한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_nested");
});

const instantiate = (handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)({ label: "X" }, handlers as unknown as THandlers);
  const host = mount(inst);
  return host.querySelector("button")!;
};

test("자식 클릭은 자기 핸들러만 부르고 부모로 버블하지 않는다", () => {
  let inner = 0;
  let outer = 0;
  const button = instantiate({
    INNER: () => {
      inner += 1;
    },
    OUTER: () => {
      outer += 1;
    },
  });
  button.dispatchEvent(new Event("click", { bubbles: true }));
  assert.equal(inner, 1, "자식 핸들러 1회");
  assert.equal(outer, 0, "부모 핸들러는 버블 차단으로 안 불림");
});
