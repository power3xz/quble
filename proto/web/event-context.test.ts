// @with 컨텍스트 전달 통합 테스트 - 실제 컴파일러(contexts{}/@with -> ENTER_CONTEXT)와 실제
// runtime을 jsdom 위에서 돌린다. 버튼 클릭 -> 이벤트 발생 -> 활성 컨텍스트를 핸들러의 context로
// 전달. context.<이름>.<필드>는 발생 시점 현재값(리터럴은 상수, 변수는 prop의 현재값).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입(첫 import)

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_context");
});

// C 인스턴스 하나. props [userId].
const instantiate = (values: unknown, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers as unknown as THandlers);
  const host = mount(inst);
  const button = host.querySelector("button")!;
  return { store: inst.store, host, button };
};

test("핸들러 context에 활성 @with 컨텍스트가 이름별로 담긴다", () => {
  let received = null;
  const { button } = instantiate(
    { userId: 42 },
    {
      TOGGLE: (_data, { context }) => {
        received = context;
      },
    },
  );
  button.click();
  assert.deepEqual(received, {
    Area: { section: "actions", userId: 42 },
  });
});

test("context 필드의 변수 값은 발생 시점 현재값이다", () => {
  let received = null;
  const { store, button } = instantiate(
    { userId: 1 },
    {
      TOGGLE: (_data, { context }) => {
        received = context.Area.userId;
      },
    },
  );
  store.set(0, 99); // userId: 발생 전에 prop을 바꾼다
  button.click();
  assert.equal(received, 99, "리터럴이 아닌 변수 필드는 현재값을 반영");
});
