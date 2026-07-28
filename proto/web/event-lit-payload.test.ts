// 이벤트 페이로드 리터럴 통합 테스트 - 실제 컴파일러(events 페이로드의 "lit" -> FieldValue::Const)와
// 실제 runtime을 jsdom 위에서 돌린다. 한 이벤트에 변수 필드(count)와 리터럴 필드(label)를 섞어,
// 핸들러 data에서 변수는 현재값, 리터럴은 상수로 담기는지 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입(첫 import)

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_lit_payload");
});

// C 인스턴스 하나. props [count].
const instantiate = (values: unknown, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers as unknown as THandlers);
  const store = inst.store;
  const host = mount(inst);
  const button = host.querySelector("button")!;
  return { store, button };
};

test("핸들러 data에 변수 필드는 현재값, 리터럴 필드는 상수로 담긴다", () => {
  let received = null;
  const { button } = instantiate(
    { count: 7 },
    {
      BUMP: (data) => {
        received = data;
      },
    },
  );
  button.click();
  assert.deepEqual(received, { count: 7, label: "clicks" });
});
