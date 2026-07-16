// 배열 prop plant - rootValue의 배열 필드를 store에 "고정부 연속 + 요소는 레벨별 뒤로"(BFS)
// 심고 arrayPool에 요소 위치를 등록하는지 검증한다. @for 요소 추출(순회 렌더)은 아직이라
// 렌더가 아니라 store.get(leafIndex)와 arrayPool 레이아웃을 직접 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.ts";
import { mount } from "./fixtures/dom.ts"; // jsdom 전역 document 주입

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("array_prop_plant");
});

// props 선언 순서: title=0, tags=1(string[]), rows=2({label, cells:string[]}[]).
const rootValue = {
  title: "T",
  tags: ["a", "b"],
  rows: [
    { label: "L1", cells: ["x"] },
    { label: "L2", cells: ["y", "z"] },
  ],
};

test("고정부는 연속, 배열 요소는 레벨별로 store 끝에 BFS로 심긴다", () => {
  const inst = compile(qubb)(0)(rootValue);
  mount(inst);
  const g = (i: number) => inst.store.get(i);

  // 레벨0 고정부: title 값 + tags/rows는 arrayInfoIndex 한 칸씩(연속).
  assert.equal(g(0), "T", "title 값");
  assert.equal(g(1), 0, "tags 칸 = arrayInfoIndex 0");
  assert.equal(g(2), 1, "rows 칸 = arrayInfoIndex 1");

  // 레벨1: 먼저 tags 요소(a,b), 다음 rows 요소 고정부(L1: label+cells칸, L2: label+cells칸).
  assert.equal(g(3), "a", "tags[0]");
  assert.equal(g(4), "b", "tags[1]");
  assert.equal(g(5), "L1", "rows[0].label");
  assert.equal(g(6), 2, "rows[0].cells 칸 = arrayInfoIndex 2");
  assert.equal(g(7), "L2", "rows[1].label");
  assert.equal(g(8), 3, "rows[1].cells 칸 = arrayInfoIndex 3");

  // 레벨2: rows 요소들이 품은 cells 요소(x / y,z).
  assert.equal(g(9), "x", "rows[0].cells[0]");
  assert.equal(g(10), "y", "rows[1].cells[0]");
  assert.equal(g(11), "z", "rows[1].cells[1]");
});

test("arrayPool이 요소 시작 leafIndex와 elemSize를 등록한다", () => {
  const inst = compile(qubb)(0)(rootValue);
  mount(inst);
  const pool = inst.arrayPool;

  // #0 tags(string[]): 요소 스칼라라 elemSize=1, 요소 2개가 leafIndex 3,4에서 시작.
  assert.deepEqual(pool[0], { elemSize: 1, elemStartLeafIndices: [3, 4] }, "tags");

  // #1 rows({label,cells}[]): 요소가 label(1)+cells칸(1)=2칸이라 elemSize=2, 요소 2개가 5,7에서 시작.
  assert.deepEqual(pool[1], { elemSize: 2, elemStartLeafIndices: [5, 7] }, "rows");

  // #2 rows[0].cells: 요소 "x" 하나가 9에서.
  assert.deepEqual(pool[2], { elemSize: 1, elemStartLeafIndices: [9] }, "rows[0].cells");

  // #3 rows[1].cells: 요소 "y","z"가 10,11에서.
  assert.deepEqual(pool[3], { elemSize: 1, elemStartLeafIndices: [10, 11] }, "rows[1].cells");
});
