// 인덱스 접근 식이 더 이상 읽지 않는 leaf의 구독을 실제로 푸는지.
//
// 화면으로는 가릴 수 없다 - 구독 함수는 자기가 읽지 않는 leafIndex로 호출되면 바로 끝나므로, 풀지 않고
// 남겨도 화면은 같다. 그래서 store의 subscribe/unsubscribe를 감싸 leaf마다 건 횟수에서 푼 횟수를 뺀다.
// 식이 `${rows[cursor].title}` 하나뿐이라 그 증감이 곧 이 식의 구독이다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_index_unsubscribe");
});

// props 선언 순서가 곧 고정부 leafIndex. 0=rows 1=cursor 2=show. rows 요소는 {title} 1 leaf라 요소 i = 3 + i.
const ROWS = 0;
const CURSOR = 1;
const SHOW = 2;
const titleLeaf = (i: number) => 3 + i;

const handlers: THandlers = {
  REMOVE_FIRST_ROW: (_d, ctx) => {
    const removeAt = ctx.removeAt as (a: unknown, i: number) => void;
    removeAt((ctx.store as Record<string, unknown>).rows, 0);
  },
};

type TSubscribeFn = (leafIndex: number, fn: (v: unknown, leafIndex: number) => void) => void;

// 인스턴스를 만든 뒤부터 leaf마다 건 횟수 - 푼 횟수를 센다.
const instantiate = () => {
  const inst = compile(qubb)(0)(
    { rows: [{ title: "A" }, { title: "B" }, { title: "C" }], cursor: 0, show: true },
    handlers,
  );
  const host = mount(inst);
  const store = inst.store as unknown as { subscribe: TSubscribeFn; unsubscribe: TSubscribeFn };
  const net = new Map<number, number>();
  const count = (leafIndex: number, d: number) => net.set(leafIndex, (net.get(leafIndex) ?? 0) + d);
  const { subscribe, unsubscribe } = store;
  store.subscribe = (leafIndex, fn) => {
    count(leafIndex, 1);
    subscribe(leafIndex, fn);
  };
  store.unsubscribe = (leafIndex, fn) => {
    count(leafIndex, -1);
    unsubscribe(leafIndex, fn);
  };
  return {
    netOf: (leafIndex: number) => net.get(leafIndex) ?? 0,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
    removeFirstRow: () => (host.querySelector(".remove-first-row") as HTMLButtonElement).click(),
  };
};

test("인덱스가 바뀌면 전에 읽던 leaf의 구독을 풀고 새 leaf에 건다", () => {
  const { netOf, set } = instantiate();
  set(CURSOR, 1);
  assert.equal(netOf(titleLeaf(0)), -1, "A의 title leaf 구독을 푼다");
  assert.equal(netOf(titleLeaf(1)), 1, "B의 title leaf에 건다");
  assert.equal(netOf(CURSOR), 0, "cursor 구독은 그대로다");
});

test("앞 요소가 제거되면 빠진 요소의 leaf 구독을 풀고 당겨진 요소의 leaf에 건다", () => {
  const { netOf, removeFirstRow } = instantiate();
  removeFirstRow();
  assert.equal(netOf(titleLeaf(0)), -1, "빠진 A의 title leaf 구독을 푼다");
  assert.equal(netOf(titleLeaf(1)), 1, "당겨진 B의 title leaf에 건다");
  assert.equal(netOf(ROWS), 0, "배열 필드 leaf 구독은 그대로다");
});

test("구독을 다시 건 뒤 가지가 꺼지면 다시 건 leaf의 구독을 푼다", () => {
  const { netOf, set } = instantiate();
  set(CURSOR, 1);
  set(SHOW, false);
  assert.equal(netOf(titleLeaf(1)), 0, "다시 건 B의 title leaf 구독도 푼다");
  assert.equal(netOf(titleLeaf(0)), -1, "A의 title leaf 구독은 한 번만 푼다");
  assert.equal(netOf(ROWS), -1, "배열 필드 leaf 구독을 푼다");
  assert.equal(netOf(CURSOR), -1, "cursor 구독을 푼다");
});
