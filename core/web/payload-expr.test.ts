// payload/context 값 자리의 식 - `SEND({ next: n + 1, row: rows[cursor] })`.
//
// 템플릿 식과 달리 구독하지 않는다. 발화할 때 한 번 평가해 핸들러에 넘긴다. 결과가 원시면 그 값을,
// 객체/배열이면 식이 낸 leafIndex부터 조립한 값을 넘긴다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("payload_expr");
});

// props 선언 순서가 곧 고정부 leafIndex. 0=n 1=open 2=cursor 3=rows
const N = 0;
const OPEN = 1;
const CURSOR = 2;

const seed = () => ({
  n: 1,
  open: true,
  cursor: 0,
  rows: [
    { title: "A", tags: ["a1"] },
    { title: "B", tags: ["b1", "b2"] },
  ],
});

type TSent = { data: Record<string, unknown>; context: unknown };
let sent: TSent | null = null;
let picked: unknown[] = [];
let taken: unknown[] = [];

const handlers: THandlers = {
  SEND: (data, ctx) => {
    sent = { data, context: ctx.context };
  },
  "Pick[$0].PICK": (data) => {
    picked.push((data as { next: number }).next);
  },
  "Item[$0].TAKE": (data) => {
    taken.push(data.row);
  },
  "Item[$0].DROP": (_d, ctx) => {
    const removeAt = ctx.removeAt as (a: unknown, i: number) => void;
    removeAt((ctx.store as Record<string, unknown>).rows, ctx.$0 as number);
  },
};

// 발화 중 난 에러. 리스너에서 던진 에러는 click()까지 올라오지 않고 window의 error 이벤트로 간다.
let listenerError: unknown = null;
document.defaultView?.addEventListener("error", (e) => {
  listenerError = e.error;
  e.preventDefault();
});

const instantiate = () => {
  sent = null;
  picked = [];
  taken = [];
  listenerError = null;
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);
  const click = () => (host.querySelector(".send") as HTMLButtonElement).click();
  return {
    host,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
    click,
    // 클릭하고 SEND 핸들러가 받은 것을 돌려준다.
    send: (): TSent => {
      click();
      assert.ok(sent, "SEND 핸들러가 호출되지 않았다");
      return sent;
    },
  };
};

test("연산자 식을 발화 때 평가해 넘긴다", () => {
  const { data } = instantiate().send();
  assert.equal(data.next, 2);
});

test("인덱스 접근이 객체면 그 요소를 조립해 넘긴다", () => {
  const { data } = instantiate().send();
  assert.deepEqual(data.row, { title: "A", tags: ["a1"] });
});

test("인덱스 접근 뒤 원시 필드는 값을, 배열 필드는 배열을 넘긴다", () => {
  const { data } = instantiate().send();
  assert.equal(data.title, "A");
  assert.deepEqual(data.tags, ["a1"]);
  assert.equal(data.count, 2, "rows.length");
});

test("context 값의 식도 발화 때 평가한다", () => {
  const { context } = instantiate().send();
  assert.deepEqual(context, { Area: { closed: false } });
});

test("값을 바꾼 뒤 발화하면 바뀐 값으로 평가한다", () => {
  const { set, send } = instantiate();
  set(N, 10);
  set(OPEN, false);
  set(CURSOR, 1);
  const { data, context } = send();
  assert.equal(data.next, 11);
  assert.deepEqual(data.row, { title: "B", tags: ["b1", "b2"] });
  assert.equal(data.title, "B");
  assert.deepEqual(context, { Area: { closed: true } });
});

test("인덱스가 범위 밖이면 발화 때 RangeError가 나고 핸들러를 호출하지 않는다", () => {
  const { set, click } = instantiate();
  set(CURSOR, 2);
  click();
  assert.ok(listenerError instanceof RangeError, `실제: ${String(listenerError)}`);
  assert.equal(sent, null);
});

test("반복 안의 컴포넌트는 그 회차의 prop으로 평가한다", () => {
  const { host } = instantiate();
  for (const b of host.querySelectorAll<HTMLButtonElement>(".pick")) {
    b.click();
  }
  assert.deepEqual(picked, [1, 2, 3]);
});

// array-for 회차 번호는 store leaf라 removeAt이 당긴다. 넘겨받은 `at`으로 `rows[at]`을 읽는 payload는
// 당겨진 번호로 평가해야 한다 - 옛 번호(1)로 읽으면 요소가 하나 남은 rows에서 범위 밖이다.
test("removeAt으로 회차 번호가 당겨지면 rows[at]이 당겨진 번호로 평가된다", () => {
  const { host } = instantiate();
  host.querySelectorAll<HTMLButtonElement>(".drop")[0].click();
  const takes = host.querySelectorAll<HTMLButtonElement>(".take");
  assert.equal(takes.length, 1);
  takes[0].click();
  assert.equal(listenerError, null);
  assert.deepEqual(taken, [{ title: "B", tags: ["b1", "b2"] }]);
});
