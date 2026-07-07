// @for 통합 테스트 - 실제 컴파일러(.qubc -> .qubb, @for -> FOR_RAW/FOR_SCOPE_INDEX/FOR_END)와
// 실제 runtime.js를 jsdom 위에서 돌린다. 반복 렌더(리터럴/prop count), 이벤트 fullname의 [$n]
// 정적 표기(컴포넌트 접미 Item[$0], element 익명 [$0]), 발화 시 회차 인덱스($0) 주입을 검증한다.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./fixtures/dom.js"; // jsdom 전역 document 주입(첫 import)
import { buildFixture } from "./fixtures/build.js";

const { compile, createLeafStoreSubject } = await import("./runtime.js");

const qubb = {};
before(() => {
  for (const name of [
    "for_literal",
    "for_count",
    "for_event_component",
    "for_event_element",
  ]) {
    qubb[name] = buildFixture(name);
  }
});

const instantiate = (name, paths, values, handlers) => {
  const store = createLeafStoreSubject(values);
  const inst = compile(qubb[name])(0)(store, paths, handlers);
  const host = mount(inst);
  return { store, inst, host };
};

const paras = (host) => [...host.querySelectorAll("p")].map((p) => p.textContent);

// -- 반복 렌더 --------------------------------------------------------
test("리터럴 count: @for (x of 3)이 몸체를 3회 렌더", () => {
  const { host } = instantiate("for_literal", [], {});
  assert.deepEqual(paras(host), ["item", "item", "item"], "p 3개");
});

test("prop count: store 숫자값만큼 반복", () => {
  const { host } = instantiate("for_count", ["n"], { n: 4 });
  assert.deepEqual(paras(host), ["row", "row", "row", "row"], "n=4 -> p 4개");
});

test("count 0이면 몸체 렌더 없음", () => {
  const { host } = instantiate("for_count", ["n"], { n: 0 });
  assert.deepEqual(paras(host), [], "빈 반복");
});

// -- 이벤트 fullname [$n] + 회차 인덱스 -------------------------------
test("@for 안 자식 컴포넌트: fullname Item[$0], 발화 시 $0 회차 인덱스", () => {
  const picks = [];
  const { host } = instantiate("for_event_component", [], {}, {
    "Item[$0].PICK": (data, { $0 }) => {
      picks.push($0);
    },
  });
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 3, "3회차 버튼 3개");
  buttons[2].click();
  buttons[0].click();
  assert.deepEqual(picks, [2, 0], "클릭한 회차의 $0가 전달된다");
});

test("@for 직속 element: fullname 익명 [$0], 발화 시 $0", () => {
  const sels = [];
  const { host } = instantiate("for_event_element", [], {}, {
    "[$0].SELECT": (data, { $0 }) => {
      sels.push($0);
    },
  });
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 3, "3회차 버튼 3개");
  buttons[1].click();
  assert.deepEqual(sels, [1], "익명 세그먼트 fullname으로 디스패치 + $0=1");
});
