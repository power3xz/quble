// 인덱스 접근 식이 더 이상 읽지 않는 leaf의 구독을 실제로 푸는지.
//
// 화면으로는 가릴 수 없다 - 구독 함수는 자기가 읽지 않는 leafIndex로 호출되면 바로 끝나므로, 풀지 않고
// 남겨도 화면은 같다. 그래서 표현식 층의 구독 표(deriveSubscribers)에서 leaf마다 구독이 걸려 있는지 본다.
// 식이 `${rows[cursor].title}` 하나뿐이라 걸려 있는 구독이 곧 이 식의 구독이다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { resume } from "./resume-entry.ts";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";
import { renderSsr } from "./test-helpers/ssr.ts";

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

// subscribed(leafIndex)는 그 leaf에 파생 구독이 걸려 있는지 표현식 층의 구독 표에서 본다. text()는 `@if (show)`
// 본문의 글이다.
const instantiate = () => {
  const inst = compile(qubb)(0)(
    { rows: [{ title: "A" }, { title: "B" }, { title: "C" }], cursor: 0, show: true },
    handlers,
  );
  const host = mount(inst);
  return {
    subscribed: (leafIndex: number) => inst.deriveSubscribers[leafIndex] !== undefined,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
    removeFirstRow: () => (host.querySelector(".remove-first-row") as HTMLButtonElement).click(),
    text: () => host.querySelector(".shown")?.textContent,
  };
};

test("인덱스가 바뀌면 전에 읽던 leaf의 구독을 풀고 새 leaf에 건다", () => {
  const { subscribed, set } = instantiate();
  assert.equal(subscribed(titleLeaf(0)), true, "처음에는 A의 title leaf를 구독한다");

  set(CURSOR, 1);

  assert.equal(subscribed(titleLeaf(0)), false, "A의 title leaf 구독을 푼다");
  assert.equal(subscribed(titleLeaf(1)), true, "B의 title leaf에 건다");
  assert.equal(subscribed(CURSOR), true, "cursor 구독은 그대로다");
});

test("앞 요소가 제거되면 빠진 요소의 leaf 구독을 풀고 당겨진 요소의 leaf에 건다", () => {
  const { subscribed, removeFirstRow } = instantiate();
  removeFirstRow();
  assert.equal(subscribed(titleLeaf(0)), false, "빠진 A의 title leaf 구독을 푼다");
  assert.equal(subscribed(titleLeaf(1)), true, "당겨진 B의 title leaf에 건다");
  assert.equal(subscribed(ROWS), true, "배열 필드 leaf 구독은 그대로다");
});

test("구독을 다시 건 뒤 가지가 꺼져도 다시 건 leaf의 구독은 남는다", () => {
  const { subscribed, set } = instantiate();
  set(CURSOR, 1);
  set(SHOW, false);
  assert.equal(subscribed(titleLeaf(1)), true, "다시 건 B의 title leaf 구독이 남는다");
  assert.equal(subscribed(titleLeaf(0)), false, "A의 title leaf 구독은 풀린 채다");
  assert.equal(subscribed(ROWS), true, "배열 필드 leaf 구독이 남는다");
  assert.equal(subscribed(CURSOR), true, "cursor 구독이 남는다");
});

test("가지가 꺼진 동안 인덱스가 바뀌면 구독을 옮기지 않고, 다시 켜질 때 옮긴다", () => {
  const { subscribed, set, text } = instantiate();
  set(SHOW, false);
  set(CURSOR, 2);
  assert.equal(subscribed(titleLeaf(0)), true, "식을 세지 않아 A의 title leaf 구독이 남는다");
  assert.equal(subscribed(titleLeaf(2)), false);

  set(SHOW, true);

  assert.equal(subscribed(titleLeaf(0)), false, "A의 title leaf 구독을 푼다");
  assert.equal(subscribed(titleLeaf(2)), true, "C의 title leaf에 건다");
  assert.equal(text(), "C");
});

test("SSR에서 resume해도 가지가 꺼진 동안 인덱스가 바뀌면 다시 켜질 때 바뀐 요소의 글을 보인다", () => {
  const data = { rows: [{ title: "A" }, { title: "B" }, { title: "C" }], cursor: 0, show: true };
  const host = document.createElement("div");
  host.innerHTML = renderSsr("expr_index_unsubscribe", [], data).html;
  const inst = resume(qubb, host, { data, handlers });
  inst.update({ show: false });
  inst.update({ cursor: 2 });

  inst.update({ show: true });

  assert.equal(host.querySelector(".shown")?.textContent, "C");
  inst.destroy();
});
