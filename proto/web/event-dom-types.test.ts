// 입력 요소(@input)의 이벤트/값 경로 통합 테스트. 두 축을 함께 덮는다.
// (1) 이벤트 종류 - 새로 추가한 DOM 이벤트 종류가 실제 컴파일러로 BIND_EVENT를 내고,
//     runtime.js가 그 event_type을 input 리스너로 풀어 핸들러를 부르는지.
// (2) 값 - 초기값이 value 속성으로 꽂히는지, 그리고 타이핑된 현재 값에 핸들러가 도달하는지.
//     payload 식은 선언 시점 이름만 참조해 타이핑 값을 못 싣지만(ISSUES.md "DOM 입력값을
//     이벤트 payload로 못 보냄"), 런타임이 ctx.event로 원본 DOM Event를 넘겨 도달한다.
//
// fixture Field는 같은 leaf(value)를 input과 형제 p에 함께 걸어 둔다 - store 되먹임이
// 화면까지 갔는지를 store.get이 아니라 p의 textContent로 관찰하기 위해서다.

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

// Field 인스턴스 하나 - props [value]. echo는 같은 leaf를 보간한 형제 p(갱신 관찰 지점).
const instantiate = (values: unknown, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers as unknown as THandlers);
  const store = inst.store;
  const host = mount(inst);
  const input = host.querySelector("input")! as HTMLInputElement;
  const echo = host.querySelector("p")!;
  return { store, host, input, echo };
};

// value prop의 leafIndex. props 첫 필드라 0.
const VALUE_LEAF = 0;

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

// self-close된 void 요소(input)는 자식 없이 렌더된다 - 옛 `<input>value</input>` 버그가
// 사라졌는지(ISSUES.md "void 요소 구분 없음"). fixture는 `input(value={value} @input:EDIT /)`.
test("self-close input은 자식 없이 렌더된다", () => {
  const { input } = instantiate({ value: "A" });
  assert.equal(input.childNodes.length, 0, "input은 자식 노드가 없어야");
  assert.equal(input.textContent, "", "input 텍스트 내용이 비어야");
});

// value 속성으로 초기값이 실제 <input>에 꽂히는지 - `input(value={value} /)`가
// setAttribute("value")를 내고, 그게 DOM의 초기 표시값(input.value)이 되는지.
test("input value 속성으로 초기값이 렌더된다", () => {
  const { input, echo } = instantiate({ value: "초기값" });
  assert.equal(input.getAttribute("value"), "초기값", "value 속성이 설정돼야");
  assert.equal(input.value, "초기값", "input의 초기 표시값이어야");
  assert.equal(echo.textContent, "초기값", "같은 leaf를 보간한 형제도 초기값이어야");
});

// ── 값 경로 - 타이핑된 현재 값에 핸들러가 도달하는가 ──────────────────

test("핸들러 ctx.event로 발화 요소의 현재 입력값을 읽는다", () => {
  let seen: unknown = null;
  const { input } = instantiate(
    { value: "초기값" },
    {
      EDIT: (_data, { event }) => {
        seen = (event.target as HTMLInputElement).value;
      },
    },
  );

  input.value = "타이핑된값"; // 사용자 타이핑
  input.dispatchEvent(new Event("input", { bubbles: true }));

  assert.equal(seen, "타이핑된값", "선언 시점 prop이 아니라 발화 시점 DOM 값이어야");
});

test("ctx.event.target은 발화한 바로 그 요소다", () => {
  let target: unknown = null;
  const { input } = instantiate(
    { value: "A" },
    {
      EDIT: (_data, { event }) => {
        target = event.target;
      },
    },
  );

  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(target, input, "event.target이 발화 요소와 동일해야");
});

// payload는 선언 시점 값(store의 prop)에 묶인다 - 타이핑해도 data.value는 안 따라온다.
// event로 도달해야 하는 이유(ISSUES 항목의 증상)를 못박는다.
test("payload(data)는 타이핑된 값이 아니라 store의 prop 값이다", () => {
  let data: Record<string, unknown> = {};
  const { input } = instantiate(
    { value: "초기값" },
    {
      EDIT: (d, { event }) => {
        data = d;
        assert.equal(
          (event.target as HTMLInputElement).value,
          "타이핑된값",
          "같은 발화에서 event는 타이핑된 값을 봐야",
        );
      },
    },
  );

  input.value = "타이핑된값";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  assert.equal(data.value, "초기값", "payload는 store 값(타이핑 값 아님)");
});

// 입력값을 store로 되먹이면 그 leaf를 구독하는 형제(p)가 갱신된다 - 화면까지 갔는지를
// store.get이 아니라 textContent로 본다. input 자신은 사용자가 친 값 그대로 남는다.
test("event 값을 store에 set하면 같은 leaf를 보간한 형제가 갱신된다", () => {
  const { input, echo } = instantiate(
    { value: "초기값" },
    {
      EDIT: (_data, { event, set }) => {
        set(VALUE_LEAF, (event.target as HTMLInputElement).value);
      },
    },
  );

  input.value = "1차";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(echo.textContent, "1차", "형제 보간이 타이핑 값으로 갱신돼야");

  input.value = "2차";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(echo.textContent, "2차", "연속 입력도 따라와야");
  assert.equal(input.value, "2차", "input 표시값은 사용자가 친 그대로(재대입 안 함)");
});

// 되먹인 값이 다음 발화의 payload에도 반영되는지 - store를 실제로 거쳤다는 증거.
test("되먹인 값이 다음 발화의 payload에 반영된다", () => {
  const seen: unknown[] = [];
  const { input } = instantiate(
    { value: "초기값" },
    {
      EDIT: (d, { event, set }) => {
        seen.push(d.value);
        set(VALUE_LEAF, (event.target as HTMLInputElement).value);
      },
    },
  );

  input.value = "1차";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.value = "2차";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  assert.deepEqual(seen, ["초기값", "1차"], "다음 발화의 payload가 되먹인 값을 봐야");
});

test("바인딩 안 한 이벤트 종류로는 값 경로도 열리지 않는다", () => {
  let called = 0;
  const { input } = instantiate(
    { value: "A" },
    {
      EDIT: () => {
        called += 1;
      },
    },
  );

  input.value = "타이핑된값";
  input.dispatchEvent(new Event("change", { bubbles: true }));

  assert.equal(called, 0, "@input 바인딩은 change로 안 불림");
});
