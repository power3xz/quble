// 이벤트 발생 통합 테스트 - 실제 컴파일러(.qubc -> .qubb, events{}/@click:EVENT -> BIND_EVENT)와
// 실제 runtime.js를 jsdom 위에서 돌린다. 단일 컴포넌트(합성/fullname 없음): 버튼 클릭 -> 이벤트
// 발생 -> payload(현재값) 조립 -> 핸들러 호출 -> 핸들러의 set이 기존 반응성으로 DOM을 갱신.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입(첫 import)

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_toggle");
});

// Toggle 인스턴스 하나 - { store, host, button }. props [label, on].
const instantiate = (values: unknown, handlers: TTestHandlers = {}) => {
  // 테스트용 구체 ctx 타입이라 runtime의 헐거운 THandlers와 반공변 충돌 - 경계에서 한 번 캐스트.
  const inst = compile(qubb)(0)(values, handlers as unknown as THandlers);
  const store = inst.store;
  const host = mount(inst);
  const button = host.querySelector("button")!;
  return { store, host, button };
};

test("클릭하면 이벤트명으로 등록한 핸들러가 호출된다", () => {
  let called = 0;
  const { button } = instantiate(
    { label: "A", on: false },
    {
      TOGGLE: () => {
        called += 1;
      },
    },
  );
  button.click();
  assert.equal(called, 1, "핸들러 1회 호출");
});

test("핸들러 data에 payload 필드의 현재값이 필드명 키로 담긴다", () => {
  let received: unknown = null;
  const { button } = instantiate(
    { label: "할일", on: true },
    {
      TOGGLE: (data) => {
        received = data;
      },
    },
  );
  button.click();
  assert.deepEqual(received, { label: "할일", on: true }, "label/on 현재값이 키로");
});

test("핸들러의 set이 DOM을 갱신한다(클릭 -> set -> 텍스트 변경)", () => {
  const { store, button } = instantiate(
    { label: "켜기", on: false },
    {
      TOGGLE: (data) => {
        store.set(0, data.on ? "켜기" : "끄기"); // label(leafIndex 0): on=false면 "끄기"로
      },
    },
  );
  assert.equal(button.textContent, "켜기", "초기 label");
  button.click();
  assert.equal(button.textContent, "끄기", "핸들러 set이 텍스트 갱신");
});

test("둘째 인자 set/props로 상태를 바꾸면 DOM이 갱신된다", () => {
  const { button } = instantiate(
    { label: "켜기", on: false },
    {
      TOGGLE: (_data, { set, props }) => {
        set(props.label, "끄기"); // props.label = label leafIndex, set이 통지 -> DOM
      },
    },
  );
  assert.equal(button.textContent, "켜기", "초기 label");
  button.click();
  assert.equal(button.textContent, "끄기", "핸들러 set이 텍스트 갱신");
});

test("둘째 인자 get으로 현재값을 읽는다", () => {
  let read: unknown = null;
  const { button } = instantiate(
    { label: "현재값", on: false },
    {
      TOGGLE: (_data, { get, props }) => {
        read = get(props.label);
      },
    },
  );
  button.click();
  assert.equal(read, "현재값", "get(props.label)이 현재값");
});

test("둘째 인자 event로 DOM 이벤트 객체를 받는다", () => {
  let received: Event | null = null;
  const { button } = instantiate(
    { label: "A", on: false },
    {
      TOGGLE: (_data, { event }) => {
        received = event;
      },
    },
  );
  button.click();
  assert.equal(received!.type, "click", "DOM click 이벤트 객체 전달");
});

test("핸들러 없는 이벤트는 무시된다(에러 없음)", () => {
  const { button } = instantiate({ label: "A", on: false }, {});
  assert.doesNotThrow(() => button.click(), "핸들러 없어도 클릭은 안전");
});
