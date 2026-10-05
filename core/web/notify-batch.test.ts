// 핸들러 호출을 store.batch로 감싼다 - 핸들러 안의 set/배열 조작이 보내는 통지는 핸들러가 끝날 때 칸마다
// 한 번씩 나간다. store 단위 규칙은 leaf-store-batch.test.ts, 여기는 핸들러와 이어진 경로를 본다.
//
// 확인할 것이 둘이다. 하나는 통지가 모이는가(같은 칸을 여러 번 써도 구독자는 한 번). 다른 하나는 모아도
// 결과가 맞는가 - 배열 조작은 데이터를 먼저 맞추고 DOM을 움직이는 발화(길이 칸 set)를 뒤에 둬서 순서에
// 기대는데, 통지가 핸들러 끝으로 밀려도 한 핸들러 안의 조작 조합이 같은 결과를 내야 한다.
//
// leaf 번호: 루트 props의 스칼라는 선언 순서대로 앞에 놓인다(a=0, b=1).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("notify_batch");
});

const A = 0;
const B = 1;

type TRow = { label: string };
type TCtx = Record<string, unknown>;
type TOps = {
  set: (leafIndex: number, value: unknown) => void;
  push: (array: unknown, elem: unknown) => void;
  removeAt: (array: unknown, i: number) => void;
  setArray: (array: unknown, elems: unknown[]) => void;
  props: Record<string, number>;
};
const opsOf = (ctx: TCtx) => ctx as unknown as TOps;

const handlers: THandlers = {
  BUMP_A_THREE: (_data: Record<string, unknown>, ctx: TCtx) => {
    const { set, props } = opsOf(ctx);
    set(props.a, 1);
    set(props.a, 2);
    set(props.a, 3);
  },
  BUMP_AB: (_data: Record<string, unknown>, ctx: TCtx) => {
    const { set, props } = opsOf(ctx);
    set(props.a, 10);
    set(props.b, 20);
  },
  REMOVE_THEN_PUSH: (_data: Record<string, unknown>, ctx: TCtx) => {
    const { removeAt, push, props } = opsOf(ctx);
    removeAt(props.rows, 0);
    push(props.rows, { label: "z" });
  },
  SHRINK_THEN_GROW: (_data: Record<string, unknown>, ctx: TCtx) => {
    const { setArray, push, props } = opsOf(ctx);
    setArray(props.rows, [{ label: "x" }]);
    push(props.rows, { label: "p" });
    push(props.rows, { label: "q" });
  },
};

const instantiate = (rows: TRow[]) => {
  const inst = compile(qubb)(0)({ a: 0, b: 0, rows }, handlers);
  const host = mount(inst);
  assert.equal(inst.store.get(A), 0, "leaf 번호 가정(a=0)");
  assert.equal(inst.store.get(B), 0, "leaf 번호 가정(b=1)");
  const click = (cls: string) => (host.querySelector(`.${cls}`) as HTMLButtonElement).click();
  return { inst, host, click };
};

const text = (host: ParentNode, cls: string) => host.querySelector(`.${cls}`)?.textContent;
const labels = (host: ParentNode) => [...host.querySelectorAll(".label")].map((n) => n.textContent);
const indices = (host: ParentNode) => [...host.querySelectorAll(".idx")].map((n) => n.textContent);

test("핸들러가 같은 칸을 세 번 써도 그 칸의 구독자는 한 번 불린다", () => {
  const { inst, host, click } = instantiate([]);
  const seen: unknown[] = [];
  inst.store.subscribe(A, (value) => seen.push(value));

  click("bump-a");
  assert.deepEqual(seen, [3], "마지막 값으로 한 번");
  assert.equal(text(host, "a"), "3");
});

test("핸들러가 두 칸을 바꾸면 칸마다 한 번씩 불리고 식의 최종 값이 맞다", () => {
  const { inst, host, click } = instantiate([]);
  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  inst.store.subscribe(A, (value) => seenA.push(value));
  inst.store.subscribe(B, (value) => seenB.push(value));

  click("bump-ab");
  assert.deepEqual(seenA, [10]);
  assert.deepEqual(seenB, [20]);
  assert.equal(text(host, "sum"), "30", "a + b의 최종 값");
});

test("한 핸들러에서 removeAt 뒤 push해도 목록과 인덱스가 맞다", () => {
  const { host, click } = instantiate([{ label: "a" }, { label: "b" }]);
  assert.deepEqual(labels(host), ["a", "b"], "초기");

  click("remove-push");
  assert.deepEqual(labels(host), ["b", "z"]);
  assert.deepEqual(indices(host), ["0", "1"]);
});

test("한 핸들러에서 setArray로 줄인 뒤 push를 두 번 해도 목록과 인덱스가 맞다", () => {
  const { host, click } = instantiate([{ label: "a" }, { label: "b" }, { label: "c" }]);
  assert.deepEqual(labels(host), ["a", "b", "c"], "초기");

  click("shrink-grow");
  assert.deepEqual(labels(host), ["x", "p", "q"]);
  assert.deepEqual(indices(host), ["0", "1", "2"]);
});

test("핸들러가 끝난 뒤의 set은 다시 바로 통지한다", () => {
  const { inst, click } = instantiate([]);
  const seen: unknown[] = [];
  inst.store.subscribe(A, (value) => seen.push(value));

  click("bump-a");
  seen.length = 0;
  inst.store.set(A, 99);
  assert.deepEqual(seen, [99], "배치가 끝난 뒤라 바로");
});
