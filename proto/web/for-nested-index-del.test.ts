// 중첩 배열의 회차 인덱스 반응성 - 바깥 @for (row, i of rows) 안에 안쪽 @for (cell, j of row.cells)를 두고,
// 안쪽 셀 옆 삭제 버튼(fullname [$0][$1].DEL_CELL)이 자기 두 인덱스로 자기를 지운다. 안쪽 배열도 요소별
// 인덱스 leaf(indexLeafIndices)를 갖는지, 안쪽 중간 제거 시 그 배열의 뒤 인덱스만 당겨지고(안쪽 {j} 갱신)
// 다른 행은 무손상인지 검증한다. 바깥·안쪽이 각자 독립된 arrayInfo라 인덱스도 독립으로 재정렬된다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;
type TInstance = ReturnType<ReturnType<ReturnType<typeof compile>>>;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_nested_index_del");
});

type Ctx = {
  $0: number;
  $1: number;
  props: Record<string, number>;
  get: (leafIndex: number) => unknown;
  removeAt: (arrayLeafIndex: number, i: number) => void;
};

// 각 행을 "안쪽셀들"로 - "j:val" 목록. 안쪽 인덱스 표시({j})와 값을 함께 본다.
const cellsOf = (host: ParentNode) =>
  [...host.querySelectorAll(".row")].map(
    (r) =>
      `[${[...r.querySelectorAll(".cell")]
        .map((c) => `${c.querySelector(".cellidx")?.textContent}:${c.querySelector(".cellval")?.textContent}`)
        .join(",")}]`,
  );

const instantiate = (values: unknown) => {
  let inst: TInstance;
  const handlers: THandlers = {
    // 안쪽 셀 제거: 바깥 rows arrayInfo에서 $0번째 요소({label, cells})의 cells 배열 leafIndex에 도달해 $1 제거.
    // 요소 레이아웃은 label(스칼라 1칸) + cells(배열 칸 1)라 cells 배열 칸 = 요소 시작 + 1.
    "[$0][$1].DEL_CELL": (_d, c) => {
      const ctx = c as unknown as Ctx;
      const rowsInfo = inst.arrayPool.entries[Number(ctx.get(ctx.props.rows))];
      const cellsArrayLeaf = rowsInfo.elemStartLeafIndices[ctx.$0] + 1;
      ctx.removeAt(cellsArrayLeaf, ctx.$1);
    },
  };
  inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return { host, inst };
};

const initial = {
  rows: [
    { label: "R0", cells: ["a", "b", "c"] },
    { label: "R1", cells: ["d", "e"] },
  ],
};

const delCell = (host: ParentNode, row: number, cell: number) =>
  [...host.querySelectorAll(".row")][row]
    .querySelectorAll(".cell")
    [cell].querySelector(".delcell") as HTMLButtonElement;

test("중첩 배열의 안쪽 {j}가 회차 번호를 표시한다", () => {
  const { host } = instantiate(initial);
  assert.deepEqual(cellsOf(host), ["[0:a,1:b,2:c]", "[0:d,1:e]"], "각 행의 셀이 j:값");
});

test("안쪽 셀을 중간 제거하면 그 행의 뒤 셀 인덱스만 당겨지고 다른 행은 무손상", () => {
  const { host } = instantiate(initial);
  delCell(host, 0, 1).click(); // R0의 b(j=1) 제거
  assert.deepEqual(cellsOf(host), ["[0:a,1:c]", "[0:d,1:e]"], "R0의 c가 2->1, R1은 그대로");
});

test("안쪽 셀 옆 삭제가 자기 $1로 자기를 정확히 지운다(중간 제거 후에도)", () => {
  const { host } = instantiate(initial);
  delCell(host, 0, 1).click(); // b 제거 -> c가 j=1로 당겨짐
  delCell(host, 0, 1).click(); // 지금 j=1은 c - c의 버튼 $1=1이라 c를 지운다(옛 버그면 안쪽 인덱스 미당김으로 오작동)
  assert.deepEqual(cellsOf(host), ["[0:a]", "[0:d,1:e]"], "c가 정확히 지워짐, R1 무손상");
});

test("다른 행의 안쪽 배열은 독립 - R1 셀 제거는 R0에 영향 없음", () => {
  const { host } = instantiate(initial);
  delCell(host, 1, 0).click(); // R1의 d(j=0) 제거 -> e가 j=0으로
  assert.deepEqual(cellsOf(host), ["[0:a,1:b,2:c]", "[0:e]"], "R0 무손상, R1은 e가 0으로 당겨짐");
});
