// click 외 DOM 이벤트(@input) 통합 테스트 - 새로 추가한 DOM 이벤트 종류가 실제 컴파일러로
// BIND_EVENT를 내고, runtime.js가 그 event_type을 input 리스너로 풀어 핸들러를 부르는지.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_input");
});

// Field 인스턴스 하나 - props [value].
const instantiate = (values: unknown, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers as unknown as THandlers);
  const store = inst.store;
  const host = mount(inst);
  const input = host.querySelector("input")!;
  return { store, host, input };
};

test("@input은 input 이벤트에 리스너를 달아 핸들러를 부른다", () => {
  let called = 0;
  const { input } = instantiate(
    { value: "A" },
    {
      EDIT: () => {
        called += 1;
      },
    },
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(called, 1, "input 이벤트로 핸들러 1회 호출");
});

test("@input 핸들러는 click에는 반응하지 않는다(이벤트 종류 구분)", () => {
  let called = 0;
  const { input } = instantiate(
    { value: "A" },
    {
      EDIT: () => {
        called += 1;
      },
    },
  );
  input.dispatchEvent(new Event("click", { bubbles: true }));
  assert.equal(called, 0, "click으로는 input 핸들러 안 불림");
});
