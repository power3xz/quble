// 잠재 버그 확인 - 중첩 @for에서 안쪽 배열이 grow(onSize 발화)로 늘 때, 새 회차 build가 쓰는
// ws(walk 스택)는 build 시점 공유 스택이라 발화 시점엔 바깥 회차가 이미 pop돼 있다. 그럼 grow된
// 셀의 이벤트가 바깥 인덱스 $0를 잃어 fullname([$0][$1])·발화 $n이 어긋날 수 있다.
// (@if lazyBuild와 동형의 지연 실행인데 snapshotStacks가 없다 - 확인용 테스트.)

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
  push: (arrayLeafIndex: number, elem: unknown) => void;
};

const cellsOf = (host: ParentNode) =>
  [...host.querySelectorAll(".row")].map(
    (r) =>
      `[${[...r.querySelectorAll(".cell")]
        .map((c) => `${c.querySelector(".cellidx")?.textContent}:${c.querySelector(".cellval")?.textContent}`)
        .join(",")}]`,
  );

// DEL_CELL 핸들러를 "push + 발화 인덱스 기록"으로 재활용한다 - 버튼 클릭이 자기 ($0, $1)을 남기고,
// 첫 클릭이 자기 행(cells)에 "x"를 push해 grow를 일으킨다. 요소 레이아웃: label 1칸 + cells 배열 칸 1.
const instantiate = (values: unknown, pushOnFirst: boolean) => {
  let inst: TInstance;
  const fired: [number, number][] = [];
  let pushed = false;
  const handlers: THandlers = {
    "[$0][$1].DEL_CELL": (_d, c) => {
      const ctx = c as unknown as Ctx;
      fired.push([ctx.$0, ctx.$1]);
      if (pushOnFirst && !pushed) {
        pushed = true;
        const rowsInfo = inst.arrayPool.entries[Number(ctx.get(ctx.props.rows))];
        const cellsArrayLeaf = rowsInfo.elemStartLeafIndices[ctx.$0] + 1;
        ctx.push(cellsArrayLeaf, "x");
      }
    },
  };
  inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return { host, fired };
};

const initial = {
  rows: [
    { label: "R0", cells: ["a"] },
    { label: "R1", cells: ["d", "e"] },
  ],
};

const cellButton = (host: ParentNode, row: number, cell: number) =>
  [...host.querySelectorAll(".row")][row]
    .querySelectorAll(".cell")
    [cell].querySelector(".delcell") as HTMLButtonElement;

test("안쪽 배열 grow로 생긴 셀의 이벤트도 바깥 인덱스 $0가 정합한다", () => {
  const { host, fired } = instantiate(initial, true);
  cellButton(host, 1, 0).click(); // R1의 d 클릭 -> ($0=1,$1=0) 기록 + R1.cells에 "x" push(grow)
  assert.deepEqual(cellsOf(host), ["[0:a]", "[0:d,1:e,2:x]"], "x가 R1 꼬리에 j=2로");
  cellButton(host, 1, 2).click(); // grow된 x의 버튼 - 발화 시점 ws가 아니라 자기 행 인덱스를 봐야
  assert.deepEqual(
    fired,
    [
      [1, 0],
      [1, 2],
    ],
    "grow된 셀의 발화 인덱스 ($0=1, $1=2)",
  );
});
