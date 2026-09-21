// 값 자리 식의 배열 인덱스 접근 - `${rows[cursor].title}`.
//
// 잎 하나로 접히는 참조(`${row.title}`)와 달리 어느 칸을 읽는지가 컴파일타임에 안 정해진다.
// 인덱스를 세어 봐야 알므로 식이 `ElemAt`/`FieldAt`/`ReadLeaf`로 실행 중에 칸을 찾는다.
//
// 확인할 것은 둘로 갈린다.
//   - 요소 값이 바뀌는 경우 - 읽는 칸은 그대로고 그 칸의 값만 바뀐다. 기존 구독으로 닿는다.
//   - 인덱스가 바뀌는 경우 - 읽는 칸 자체가 옮겨간다. 구독을 떼고 새 칸에 다시 걸어야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_array_index");
});

// props 선언 순서가 곧 고정부 leafIndex. 배열은 칸 하나(arrayInfoIndex).
//   0=rows 1=scalars 2=cursor
// 요소는 store 끝에 레벨별로 몰린다. rows 요소는 {title, score} 2칸이라 요소 i의 base = 3 + 2*i,
// 그 뒤에 scalars 요소 3개가 이어진다.
const CURSOR = 2;
const titleLeaf = (i: number) => 3 + 2 * i;
const scoreLeaf = (i: number) => 4 + 2 * i;

const seed = () => ({
  rows: [
    { title: "A", score: 10 },
    { title: "B", score: 20 },
    { title: "C", score: 30 },
  ],
  scalars: [7, 8, 9],
  cursor: 0,
});

const instantiate = () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);
  return {
    host,
    textOf: (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
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

test("인덱스가 바뀌면 읽는 칸이 옮겨간다", () => {
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
  assert.equal(textOf("field"), "B2", "옮겨간 칸의 값 변경이 닿는다");
});

test("인덱스가 바뀐 뒤에는 전에 읽던 요소를 구독하지 않는다", () => {
  const { textOf, set } = instantiate();
  set(CURSOR, 1);
  set(titleLeaf(0), "A2"); // 더 이상 안 읽는 칸
  assert.equal(textOf("field"), "B", "떠난 칸이 바뀌어도 그대로다");
});
