// 배열 안 배열의 인덱스 접근 - `${columns[lane].cards[seat].title}`.
//
// 바깥 인덱스 접근이 읽은 leaf(cards 배열 필드 leaf)의 값이 안쪽 인덱스 접근의 배열이 된다. 그래서
// 바깥 인덱스, 안쪽 인덱스, 바깥 배열, 안쪽 배열 중 무엇이 바뀌어도 마지막 READ_LEAF가 읽는 leaf가
// 바뀔 수 있다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_nested_index");
});

// props 선언 순서가 곧 고정부 leafIndex. 0=columns 1=lane 2=seat
// 깊이 1: columns 요소는 {name, cards} 2 leaf - 요소 i의 name = 3 + 2i, cards 배열 필드 = 4 + 2i
// 깊이 2: columns[0].cards 요소 둘(7, 8), columns[1].cards 요소 둘(9, 10) - 요소는 {title} 1 leaf
const LANE = 1;
const SEAT = 2;
const titleLeaf = (lane: number, seat: number) => 7 + 2 * lane + seat;

const seed = () => ({
  columns: [
    { name: "L0", cards: [{ title: "a" }, { title: "b" }] },
    { name: "L1", cards: [{ title: "c" }, { title: "d" }] },
  ],
  lane: 0,
  seat: 0,
});

// 핸들러 안에서 난 에러. 클릭으로 부른 핸들러의 에러는 click()까지 올라오지 않아 여기 담아 본다.
let handlerError: unknown = null;

const handlers: THandlers = {
  REMOVE_FIRST_COLUMN: (_d, ctx) => {
    const removeAt = ctx.removeAt as (a: unknown, i: number) => void;
    removeAt((ctx.store as Record<string, unknown>).columns, 0);
  },
  REMOVE_FIRST_CARD: (_d, ctx) => {
    const removeAt = ctx.removeAt as (a: unknown, i: number) => void;
    const columns = (ctx.store as Record<string, Record<string, unknown>[]>).columns;
    removeAt(columns[0].cards, 0);
  },
  REPLACE_COLUMNS: (_d, ctx) => {
    const setArray = ctx.setArray as (a: unknown, elems: unknown[]) => void;
    setArray((ctx.store as Record<string, unknown>).columns, [
      { name: "M0", cards: [{ title: "p" }, { title: "q" }] },
      { name: "M1", cards: [{ title: "r" }, { title: "s" }] },
    ]);
  },
  SWAP_COLUMNS: (_d, ctx) => {
    const swapAt = ctx.swapAt as (a: unknown, i: number, j: number) => void;
    swapAt((ctx.store as Record<string, unknown>).columns, 0, 1);
  },
  // 첫 열을 객체째 바꿔 cards를 하나로 줄인다. 바깥 columns 목록은 그대로다.
  SHRINK_FIRST_COLUMN: (_d, ctx) => {
    const setObject = ctx.setObject as (node: unknown, value: unknown) => void;
    const columns = (ctx.store as Record<string, unknown[]>).columns;
    try {
      setObject(columns[0], { name: "L0", cards: [{ title: "z" }] });
    } catch (e) {
      handlerError = e;
    }
  },
};

const instantiate = () => {
  handlerError = null;
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);
  return {
    card: () => (host.querySelector(".card") as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
    removeFirstColumn: () => (host.querySelector(".remove-first-column") as HTMLButtonElement).click(),
    removeFirstCard: () => (host.querySelector(".remove-first-card") as HTMLButtonElement).click(),
    replaceColumns: () => (host.querySelector(".replace-columns") as HTMLButtonElement).click(),
    swapColumns: () => (host.querySelector(".swap-columns") as HTMLButtonElement).click(),
    shrinkFirstColumn: () => (host.querySelector(".shrink-first-column") as HTMLButtonElement).click(),
    error: () => handlerError,
  };
};

test("배열 안 배열의 요소 필드를 읽는다", () => {
  const { card } = instantiate();
  assert.equal(card(), "a", "columns[0].cards[0].title");
});

test("읽고 있는 요소의 값이 바뀌면 따라온다", () => {
  const { card, set } = instantiate();
  set(titleLeaf(0, 0), "a2");
  assert.equal(card(), "a2");
});

test("안쪽 인덱스가 바뀌면 새 요소를 읽고 구독한다", () => {
  const { card, set } = instantiate();
  set(SEAT, 1);
  assert.equal(card(), "b", "columns[0].cards[1].title");
  set(titleLeaf(0, 1), "b2");
  assert.equal(card(), "b2", "새로 읽는 leaf의 값 변경이 닿는다");
  set(titleLeaf(0, 0), "a2");
  assert.equal(card(), "b2", "더 이상 안 읽는 leaf가 바뀌어도 그대로다");
});

test("바깥 인덱스가 바뀌면 다른 안쪽 배열의 요소를 읽고 구독한다", () => {
  const { card, set } = instantiate();
  set(LANE, 1);
  assert.equal(card(), "c", "columns[1].cards[0].title");
  set(titleLeaf(1, 0), "c2");
  assert.equal(card(), "c2", "새로 읽는 leaf의 값 변경이 닿는다");
  set(titleLeaf(0, 0), "a2");
  assert.equal(card(), "c2", "더 이상 안 읽는 leaf가 바뀌어도 그대로다");
});

test("안쪽 배열의 앞 요소가 제거되면 같은 인덱스가 당겨진 요소를 읽는다", () => {
  const { card, set, removeFirstCard } = instantiate();
  removeFirstCard(); // columns[0].cards = [b]
  assert.equal(card(), "b");
  set(titleLeaf(0, 1), "b2");
  assert.equal(card(), "b2", "당겨진 요소의 leaf 변경이 닿는다");
});

// setArray는 겹치는 앞자리의 요소 leaf에 새 값을 기록한다 - 요소 자리는 그대로라 읽던 leaf에 새 값이 온다.
test("바깥 배열을 통째로 바꾸면 같은 인덱스가 새 값을 읽는다", () => {
  const { card, set, replaceColumns } = instantiate();
  replaceColumns();
  assert.equal(card(), "p", "columns[0].cards[0].title");
  set(titleLeaf(0, 0), "p2");
  assert.equal(card(), "p2", "같은 leaf의 값 변경이 닿는다");
  set(LANE, 1);
  set(SEAT, 1);
  assert.equal(card(), "s", "columns[1].cards[1].title");
});

// swapAt은 두 요소의 값을 서로 기록한다 - 안쪽 배열도 요소 값끼리 맞바꾼다.
test("바깥 배열의 두 요소를 맞바꾸면 같은 인덱스가 맞바뀐 값을 읽는다", () => {
  const { card, set, swapColumns } = instantiate();
  swapColumns();
  assert.equal(card(), "c", "columns[0]이 이제 L1");
  set(titleLeaf(0, 0), "c2");
  assert.equal(card(), "c2", "같은 leaf의 값 변경이 닿는다");
  set(LANE, 1);
  assert.equal(card(), "a", "columns[1]이 이제 L0");
});

test("바깥 배열의 앞 요소가 제거되면 같은 인덱스가 당겨진 요소의 안쪽 배열을 읽는다", () => {
  const { card, set, removeFirstColumn } = instantiate();
  removeFirstColumn(); // columns = [L1]
  assert.equal(card(), "c");
  set(titleLeaf(1, 0), "c2");
  assert.equal(card(), "c2", "당겨진 요소의 leaf 변경이 닿는다");
});

test("setObject로 안쪽 배열이 줄어 인덱스가 범위 밖이 되면 에러다", () => {
  const { set, shrinkFirstColumn, error } = instantiate();
  set(SEAT, 1);
  shrinkFirstColumn(); // columns[0].cards = [z] - cards[1]이 범위 밖
  assert.ok(error() instanceof RangeError);
});
