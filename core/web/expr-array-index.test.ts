// 값 자리 식의 배열 인덱스 접근 - `${rows[cursor].title}`.
//
// 잎 하나로 접히는 참조(`${row.title}`)와 달리 어느 칸을 읽는지가 컴파일타임에 안 정해진다.
// 인덱스를 세어 봐야 알므로 식이 `ElemAt`/`FieldAt`/`ReadLeaf`로 실행 중에 칸을 찾는다.
//
// 확인할 것은 둘로 갈린다.
//   - 요소 값이 바뀌는 경우 - 읽는 칸은 그대로고 그 칸의 값만 바뀐다. 기존 구독으로 닿는다.
//   - 인덱스가 바뀌는 경우 - 읽는 leafIndex 자체가 바뀐다. 구독을 떼고 새 leafIndex에 다시 걸어야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_array_index");
});

// props 선언 순서가 곧 고정부 leafIndex. 배열은 칸 하나(arrayInfoIndex).
//   0=rows 1=scalars 2=cursor 3=show
// 요소는 store 끝에 레벨별로 몰린다. rows 요소는 {title, score} 2칸이라 요소 i의 base = 4 + 2*i,
// 그 뒤에 scalars 요소 3개가 이어진다.
const CURSOR = 2;
const SHOW = 3;
const titleLeaf = (i: number) => 4 + 2 * i;
const scoreLeaf = (i: number) => 5 + 2 * i;

const seed = () => ({
  rows: [
    { title: "A", score: 10 },
    { title: "B", score: 20 },
    { title: "C", score: 30 },
  ],
  scalars: [7, 8, 9],
  cursor: 0,
  show: false,
});

const removeFirstOf =
  (key: string): THandlers[string] =>
  (_d, ctx) => {
    const removeAt = ctx.removeAt as (a: unknown, i: number) => void;
    removeAt((ctx.store as Record<string, unknown>)[key], 0);
  };

const handlers: THandlers = {
  REMOVE_FIRST_ROW: removeFirstOf("rows"),
  REMOVE_FIRST_SCALAR: removeFirstOf("scalars"),
};

const instantiate = () => {
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);
  return {
    host,
    textOf: (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
    has: (cls: string) => host.querySelector(`.${cls}`) !== null,
    removeFirstRow: () => (host.querySelector(".remove-first-row") as HTMLButtonElement).click(),
    removeFirstScalar: () => (host.querySelector(".remove-first-scalar") as HTMLButtonElement).click(),
  };
};

test("인덱스 접근이 요소의 필드를 읽는다", () => {
  const { textOf } = instantiate();
  assert.equal(textOf("field"), "A", "rows[0].title");
});

test("스칼라 배열은 필드 없이 요소를 읽는다", () => {
  const { textOf } = instantiate();
  assert.equal(textOf("scalar"), "7", "scalars[0]");
});

test("인덱스 접근 결과에 연산자가 붙는다", () => {
  const { textOf } = instantiate();
  assert.equal(textOf("arith"), "20", "rows[0].score * 2");
});

test("한 식에 인덱스 접근이 둘이면 각각 값으로 읽는다", () => {
  const { textOf } = instantiate();
  assert.equal(textOf("two"), "30", "rows[0].score + rows[1].score");
});

test("인덱스가 식이어도 세어서 읽는다", () => {
  const { textOf } = instantiate();
  assert.equal(textOf("shifted"), "B", "rows[0 + 1].title");
});

test("속성값도 인덱스 접근을 읽는다", () => {
  const { host } = instantiate();
  assert.equal((host.querySelector("[id]") as HTMLElement).id, "A", "id={rows[cursor].title}");
});

test("읽고 있는 요소의 값이 바뀌면 따라온다", () => {
  const { textOf, set } = instantiate();
  set(titleLeaf(0), "A2");
  assert.equal(textOf("field"), "A2");
  set(scoreLeaf(0), 50);
  assert.equal(textOf("arith"), "100", "50 * 2");
});

test("인덱스가 바뀌면 읽는 leafIndex가 바뀐다", () => {
  const { textOf, set } = instantiate();
  set(CURSOR, 1);
  assert.equal(textOf("field"), "B", "rows[1].title");
  assert.equal(textOf("scalar"), "8", "scalars[1]");
  assert.equal(textOf("arith"), "40", "rows[1].score * 2");
  assert.equal(textOf("shifted"), "C", "rows[2].title");
});

test("인덱스가 바뀐 뒤에는 새로 읽는 요소를 구독한다", () => {
  const { textOf, set } = instantiate();
  set(CURSOR, 1);
  set(titleLeaf(1), "B2");
  assert.equal(textOf("field"), "B2", "새로 읽는 leaf의 값 변경이 닿는다");
});

test("인덱스가 바뀐 뒤에는 전에 읽던 요소를 구독하지 않는다", () => {
  const { textOf, set } = instantiate();
  set(CURSOR, 1);
  set(titleLeaf(0), "A2"); // 더 이상 안 읽는 칸
  assert.equal(textOf("field"), "B", "떠난 칸이 바뀌어도 그대로다");
});

// rows[cursor].score + rows[0].score - cursor가 0이면 두 인덱스 접근이 같은 leaf를 읽는다.
test("같은 식의 두 인덱스 접근이 한 leaf를 읽다가 나뉘어도 각자 읽는 leaf를 따라간다", () => {
  const { textOf, set } = instantiate();
  set(scoreLeaf(0), 50);
  assert.equal(textOf("alias"), "100", "둘 다 score0: 50 + 50");

  set(CURSOR, 1);
  assert.equal(textOf("alias"), "70", "score1 + score0: 20 + 50");
  set(scoreLeaf(1), 25);
  assert.equal(textOf("alias"), "75", "새로 읽는 leaf score1의 변경이 닿는다");
  set(scoreLeaf(0), 5);
  assert.equal(textOf("alias"), "30", "계속 읽는 leaf score0의 변경도 닿는다");
});

test("같은 식의 다른 인덱스 접근이 읽던 leaf를 읽게 되어도 따라간다", () => {
  const { textOf, set } = instantiate();
  set(CURSOR, 1);
  set(CURSOR, 0);
  set(scoreLeaf(0), 7);
  assert.equal(textOf("alias"), "14", "둘 다 score0: 7 + 7");
  set(scoreLeaf(1), 99); // 이제 아무도 안 읽는 leaf
  assert.equal(textOf("alias"), "14", "더 이상 안 읽는 leaf가 바뀌어도 그대로다");
});

test("가지가 꺼진 동안 인덱스가 바뀌면 다시 켤 때 새 leaf를 읽고 구독한다", () => {
  const { textOf, set } = instantiate();
  set(SHOW, true);
  assert.equal(textOf("shown"), "A");
  set(SHOW, false);
  set(CURSOR, 2);
  set(SHOW, true);
  assert.equal(textOf("shown"), "C", "꺼진 동안 바뀐 인덱스를 따라잡는다");
  set(titleLeaf(2), "C2");
  assert.equal(textOf("shown"), "C2", "새 leaf의 변경이 닿는다");
  set(titleLeaf(0), "A2"); // 꺼지기 전에 읽던 leaf
  assert.equal(textOf("shown"), "C2", "더 이상 안 읽는 leaf가 바뀌어도 그대로다");
});

// removeAt은 목록만 당기고 요소 leaf를 옮기지 않는다 - 인덱스 값은 그대로인데 rows[cursor]가 가리키는 요소가 바뀐다.
test("앞 요소가 제거되면 같은 인덱스가 당겨진 요소를 읽는다", () => {
  const { textOf, set, removeFirstRow } = instantiate();
  removeFirstRow();
  assert.equal(textOf("field"), "B", "rows[0]이 이제 B");
  set(titleLeaf(1), "B2");
  assert.equal(textOf("field"), "B2", "당겨진 요소의 leaf 변경이 닿는다");
});

test("앞 요소가 제거되면 연산, 상수 인덱스, 식 인덱스, 속성값도 당겨진 요소를 읽는다", () => {
  const { host, textOf, removeFirstRow } = instantiate();
  removeFirstRow(); // rows = [B 20, C 30]
  assert.equal(textOf("arith"), "40", "rows[0].score * 2");
  assert.equal(textOf("two"), "50", "rows[0].score + rows[1].score");
  assert.equal(textOf("shifted"), "C", "rows[0 + 1].title");
  assert.equal((host.querySelector("[id]") as HTMLElement).id, "B", "id={rows[cursor].title}");
  assert.equal(textOf("alias"), "40", "rows[0].score + rows[0].score");
});

test("스칼라 배열도 앞 요소가 제거되면 당겨진 요소를 읽는다", () => {
  const { textOf, removeFirstScalar } = instantiate();
  removeFirstScalar(); // scalars = [8, 9]
  assert.equal(textOf("scalar"), "8", "scalars[0]");
});

test("@if 안의 인덱스 접근도 앞 요소가 제거되면 당겨진 요소를 읽는다", () => {
  const { textOf, set, removeFirstRow } = instantiate();
  set(SHOW, true);
  removeFirstRow();
  assert.equal(textOf("shown"), "B");
});

test("@if 조건의 인덱스 접근도 앞 요소가 제거되면 당겨진 요소로 다시 판정한다", () => {
  const { has, removeFirstRow } = instantiate();
  assert.equal(has("high"), false, "rows[0].score = 10");
  removeFirstRow();
  assert.equal(has("high"), true, "rows[0].score = 20");
});
