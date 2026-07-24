// 핸들러 props는 발화 컴포넌트의 props 선언 전체를 참조한다 - 이벤트 payload에 실었는지와
// 무관하게(payload는 data 값, props는 상태 주소). props { label, hidden } 중 hidden은
// TAP({ label }) payload에 없지만, 핸들러가 set(props.hidden, ...)로 바꿀 수 있어야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("props_beyond_payload");
});

// props [label, hidden]. label만 button 텍스트로 나오고 payload에 실린다. hidden은 순수 상태.
const instantiate = (values: unknown, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers as unknown as THandlers);
  const store = inst.store;
  const host = mount(inst);
  const button = host.querySelector("button")!;
  return { store, host, button };
};

test("payload에 없는 prop도 props로 접근해 set한다", () => {
  const { store } = instantiate(
    { label: "제목", hidden: "before" },
    {
      TAP: (_data, { set, props }) => {
        set(props.hidden, "after"); // hidden은 payload에 없지만 props엔 있다
      },
    },
  );
  const button = document.querySelector("button")!;
  button.click();
  // hidden leafIndex 1(label 0 다음). set이 통지 - store에서 확인.
  assert.equal(store.get(1), "after", "payload에 없는 hidden을 props로 set");
});

test("payload에 없는 prop을 props로 get한다", () => {
  let read: unknown = null;
  instantiate(
    { label: "제목", hidden: "숨은값" },
    {
      TAP: (_data, { get, props }) => {
        read = get(props.hidden);
      },
    },
  );
  document.querySelector("button")!.click();
  assert.equal(read, "숨은값", "get(props.hidden)이 현재값");
});

// 리터럴로 바인딩된 prop(CONST 슬롯)은 주소가 없어(상태 아님) props에 안 담긴다 - 접근하면
// Proxy가 throw(조용한 undefined 대신). 부모가 흘려준 STORE prop(flow)만 leafIndex로 담긴다.
test("리터럴 바인딩 prop 접근은 throw, STORE prop은 leafIndex", () => {
  const qubb2 = buildFixture("props_const_slot");
  let flowRef: unknown = null;
  let litError: unknown = null;
  const inst = compile(qubb2)(0)({ flowed: "흐른값" }, {
    "Child.TAP": (_data: unknown, { props }: { props: Record<string, unknown> }) => {
      flowRef = props.flow; // STORE - leafIndex
      try {
        void props.lit; // 리터럴 바인딩 - Proxy가 throw
      } catch (e) {
        litError = e;
      }
    },
  } as unknown as THandlers);
  mount(inst);
  document.querySelector("button")!.click();
  assert.equal(typeof flowRef, "number", "STORE flow는 leafIndex");
  assert.match((litError as Error)?.message ?? "", /lit/, "리터럴 lit 접근은 throw");
});
