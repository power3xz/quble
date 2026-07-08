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
    "for_event_count",
    "for_if_count",
    "for_nested_render",
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

// RENDER로 진입한 자식 안의 @for가 여러 노드를 조립할 때 하나도 안 새는지 - 라이브 NodeList를
// for-of로 돌며 appendChild하면 컬렉션이 실시간으로 줄어 인덱스가 밀려 노드를 건너뛰던 회귀
// (ISSUES.md 해결됨 참고). 3x4=12장이 전부 렌더되고 두 뎁스 인덱스가 12조합 다 나와야 한다.
test("중첩 @for(자식 RENDER 경유): 12장 전부 + 두 뎁스 인덱스 누락 없음", () => {
  const fired = [];
  const { host } = instantiate("for_nested_render", [], {}, {
    "Mid.Col[$0].Card[$1].PICK": (data, { $0, $1 }) => {
      fired.push([$0, $1]);
    },
  });
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 12, "3x4 = 12장이 전부 렌더된다(누락 없음)");
  buttons.forEach((b) => b.click());
  const expected = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      expected.push([i, j]);
    }
  }
  assert.deepEqual(fired, expected, "두 뎁스 회차 인덱스가 12조합 전부 순서대로");
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

// -- prop count 반응(FOR_SCOPE_INDEX+STORE): count leaf 구독으로 회차 증감 -----
test("count 늘리면 꼬리 회차만 추가된다", () => {
  const { host, store } = instantiate("for_count", ["n"], { n: 2 });
  assert.deepEqual(paras(host), ["row", "row"], "초기 n=2");
  store.setPath("n", 5);
  assert.deepEqual(paras(host), ["row", "row", "row", "row", "row"], "n=5 -> 5개");
});

test("count 줄이면 꼬리 회차만 제거된다", () => {
  const { host, store } = instantiate("for_count", ["n"], { n: 5 });
  assert.deepEqual(paras(host).length, 5, "초기 n=5");
  store.setPath("n", 2);
  assert.deepEqual(paras(host), ["row", "row"], "n=2 -> 2개");
});

test("count 0으로 갔다 다시 늘려도 회차가 복원된다", () => {
  const { host, store } = instantiate("for_count", ["n"], { n: 3 });
  store.setPath("n", 0);
  assert.deepEqual(paras(host), [], "n=0 -> 빈 반복");
  store.setPath("n", 2);
  assert.deepEqual(paras(host), ["row", "row"], "n=2 -> 도로 2개");
});

// 반응으로 늘린 회차도 이벤트가 붙고 회차 인덱스($0)가 자기 자리로 온다 - prop count(n) fixture로
// 늘린 뒤 새로 생긴 마지막 회차 버튼을 클릭한다.
test("반응으로 늘린 회차도 이벤트·회차 인덱스가 정상", () => {
  const picks = [];
  const { host, store } = instantiate("for_event_count", ["n"], { n: 1 }, {
    "Item[$0].PICK": (data, { $0 }) => {
      picks.push($0);
    },
  });
  assert.equal(host.querySelectorAll("button").length, 1, "초기 n=1");
  store.setPath("n", 3);
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 3, "n=3 -> 버튼 3개");
  buttons[2].click(); // 반응으로 새로 생긴 회차
  assert.deepEqual(picks, [2], "늘린 회차의 $0=2로 디스패치");
});

// 회차를 줄여 떼어낸 뒤 다시 늘려 새로 build된 회차의 이벤트·$값이 옛 회차 잔재 없이 정상인지 -
// 떼어낸 회차의 구독/바인딩이 남아 잘못 발화하거나 $값이 어긋나면 안 된다.
test("회차 제거 후 재추가한 회차의 이벤트·$값이 정상", () => {
  const picks = [];
  const { host, store } = instantiate("for_event_count", ["n"], { n: 3 }, {
    "Item[$0].PICK": (data, { $0 }) => {
      picks.push($0);
    },
  });
  store.setPath("n", 1); // 회차 1,2 제거
  store.setPath("n", 3); // 회차 1,2 재추가(새로 build)
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 3, "n=3 -> 버튼 3개");
  buttons.forEach((b) => b.click());
  assert.deepEqual(picks, [0, 1, 2], "재추가된 회차도 각자 $0로 한 번씩만 발화(잔재 없음)");
});

// 회차 몸체가 @if(자식 region)를 품은 반응 @for - 늘린 회차의 자식 region도 붙고(초기 가지 렌더),
// 그 뒤 flag를 바꾸면 모든 회차의 가지가 swap된다(자식 region 구독이 회차마다 살아 있어야 한다).
test("반응 @for 몸체의 @if 자식 region이 회차 증가·swap에 정상", () => {
  const { host, store } = instantiate("for_if_count", ["n", "flag"], { n: 1, flag: true });
  assert.deepEqual(paras(host), ["on"], "초기 n=1, flag=true");
  store.setPath("n", 3);
  assert.deepEqual(paras(host), ["on", "on", "on"], "늘린 회차도 @if then 렌더");
  store.setPath("flag", false);
  assert.deepEqual(paras(host), ["off", "off", "off"], "flag swap이 모든 회차에 반영");
});
