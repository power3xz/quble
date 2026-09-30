// payload/context 값 자리의 식 - `SEND({ next: n + 1, row: rows[cursor] })`, `Area { closed: !open }`.
//
// 템플릿 식과 달리 구독하지 않는다. 발화할 때 한 번 평가해 핸들러에 넘긴다. 결과가 원시면 그 값을,
// 객체/배열이면 식이 낸 leafIndex부터 조립한 값을 넘긴다. payload와 context는 바인딩하는 곳이
// 달라(BIND_EVENT / ENTER_CONTEXT) 경우마다 둘 다 본다.

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

const ROW_A = { title: "A", tags: ["a1"] };
const ROW_B = { title: "B", tags: ["b1", "b2"] };

// 핸들러가 받은 data와 context. fullName마다 호출 순서대로 쌓는다.
type TReceived = { data: Record<string, unknown>; context: Record<string, Record<string, unknown>> };
let received: Record<string, TReceived[]> = {};

const record =
  (fullName: string): NonNullable<THandlers[string]> =>
  (data, ctx) => {
    received[fullName] ??= [];
    received[fullName].push({ data, context: ctx.context as TReceived["context"] });
  };

const handlers: THandlers = {
  SEND: record("SEND"),
  PING: record("PING"),
  "Pick[$0].PICK": record("Pick[$0].PICK"),
  "Item[$0].TAKE": record("Item[$0].TAKE"),
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
  received = {};
  listenerError = null;
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);
  const clickAll = (cls: string) => {
    for (const b of host.querySelectorAll<HTMLButtonElement>(`.${cls}`)) {
      b.click();
    }
  };
  return {
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
    clickAll,
    clickFirst: (cls: string) => (host.querySelector(`.${cls}`) as HTMLButtonElement).click(),
    // SEND를 클릭하고 핸들러가 받은 것을 돌려준다.
    send: (): TReceived => {
      clickAll("send");
      const calls = received.SEND;
      assert.ok(calls, "SEND 핸들러가 호출되지 않았다");
      return calls[calls.length - 1];
    },
  };
};

test("연산자 식을 발화 때 평가해 넘긴다", () => {
  const { data, context } = instantiate().send();
  assert.equal(data.next, 2);
  assert.equal(context.Area.next, 2);
  assert.equal(context.Area.closed, false);
});

test("인덱스 접근이 객체면 그 요소를 조립해 넘긴다", () => {
  const { data, context } = instantiate().send();
  assert.deepEqual(data.row, ROW_A);
  assert.deepEqual(context.Area.row, ROW_A);
});

test("인덱스 접근 뒤 원시 필드는 값을, 배열 필드는 배열을, .length는 길이를 넘긴다", () => {
  const { data, context } = instantiate().send();
  for (const values of [data, context.Area]) {
    assert.equal(values.title, "A");
    assert.deepEqual(values.tags, ["a1"]);
    assert.equal(values.count, 2);
  }
});

test("값을 바꾼 뒤 발화하면 바뀐 값으로 평가한다", () => {
  const { set, send } = instantiate();
  set(N, 10);
  set(OPEN, false);
  set(CURSOR, 1);
  const { data, context } = send();
  const expected = { next: 11, row: ROW_B, title: "B", tags: ["b1", "b2"], count: 2 };
  assert.deepEqual(data, expected);
  assert.deepEqual(context.Area, { closed: true, ...expected });
});

test("payload의 인덱스가 범위 밖이면 발화 때 RangeError가 나고 핸들러를 호출하지 않는다", () => {
  const { set, clickAll } = instantiate();
  set(CURSOR, 2);
  clickAll("send");
  assert.ok(listenerError instanceof RangeError, `실제: ${String(listenerError)}`);
  assert.equal(received.SEND, undefined);
});

// PING은 payload가 비어 있어 context만 평가한다.
test("context의 인덱스가 범위 밖이면 발화 때 RangeError가 나고 핸들러를 호출하지 않는다", () => {
  const { set, clickAll } = instantiate();
  set(CURSOR, 2);
  clickAll("ping");
  assert.ok(listenerError instanceof RangeError, `실제: ${String(listenerError)}`);
  assert.equal(received.PING, undefined);
});

test("반복 안의 컴포넌트는 그 회차의 prop으로 평가한다", () => {
  const { clickAll } = instantiate();
  clickAll("pick");
  const calls = received["Pick[$0].PICK"];
  assert.deepEqual(
    calls.map((c) => c.data.next),
    [1, 2, 3],
  );
  assert.deepEqual(
    calls.map((c) => c.context.Slot.next),
    [1, 2, 3],
  );
});

// array-for 회차 번호는 store leaf라 removeAt이 당긴다. 넘겨받은 `at`으로 `rows[at]`을 읽는 식은
// 당겨진 번호로 평가해야 한다 - 옛 번호(1)로 읽으면 요소가 하나 남은 rows에서 범위 밖이다.
test("removeAt으로 회차 번호가 당겨지면 rows[at]이 당겨진 번호로 평가된다", () => {
  const { clickAll, clickFirst } = instantiate();
  clickFirst("drop");
  clickAll("take");
  assert.equal(listenerError, null);
  const calls = received["Item[$0].TAKE"];
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data.row, ROW_B);
  assert.deepEqual(calls[0].context.Cell.row, ROW_B);
});
