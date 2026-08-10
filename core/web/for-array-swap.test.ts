// 배열 요소 자리 맞바꾸기(swapAt) - i번째와 j번째 요소의 값을 서로 set한다. 노드를 옮기지 않고
// 값만 맞바꾸는 것이 요점이다(DECISIONS.md _배열 항목 식별자(key) - 도입 안 함_의 재정렬 절) -
// 회차 DOM과 구독은 자리에 그대로 있고, 각 회차가 보던 leaf의 값이 바뀌어 구독 발화로 화면이 따라온다.
//
// 그래서 인덱스 칸(indexLeafIndices)은 안 건드린다 - [i]의 값은 늘 i라 자리 번호이지 요소의 것이 아니다.
// swap 후에도 0번 회차는 0을 표시하고, 값만 서로 바뀌어야 한다.
//
// 1단계는 스칼라 배열과 평평한 객체 배열까지다 - 요소가 중첩 배열을 품으면 칸 값이 arrayInfoIndex라
// 그것만 바꿔서는 안쪽 @for가 따라오지 않는다(reactiveArrayFor가 build 때 읽은 arrayInfo를 클로저로
// 붙들어 칸을 다시 안 읽는다). 조용히 어긋난 화면을 내느니 throw로 막는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let scalarQubb: Uint8Array;
let objQubb: Uint8Array;
let nestedQubb: Uint8Array;
before(() => {
  scalarQubb = buildFixture("for_array_index_del");
  objQubb = buildFixture("for_array_push_obj");
  nestedQubb = buildFixture("for_nested_index_del");
});

type TSwap = (arrayLeafIndex: number, i: number, j: number) => void;

// ── 스칼라 배열 ──────────────────────────────────────────────────
// for_array_index_del은 각 행에 인덱스({i})와 값({tag})을 나란히 표시한다 - 자리 번호는 그대로고
// 값만 바뀌는 것을 한 화면에서 본다. ADD 버튼 하나가 유일한 @for 밖 진입점이라 거기에 swap을 매단다.

const rows = (host: ParentNode) =>
  [...host.querySelectorAll(".tag")].map(
    (li) => `${li.querySelector(".idx")?.textContent}:${li.querySelector(".val")?.textContent}`,
  );

// ADD 버튼 한 번에 swap 한 번 - 핸들러 안에서만 배열을 만질 수 있어서다(array-index.test.ts와 같은 결).
const scalarFixture = (tags: string[], i: number, j: number) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const swapAt = ctx.swapAt as TSwap;
      const props = ctx.props as Record<string, number>;
      swapAt(props.tags, i, j);
    },
  };
  const inst = compile(scalarQubb)(0)({ tags }, handlers);
  const host = mount(inst);
  return { host, swap: () => (host.querySelector(".add") as HTMLButtonElement).click() };
};

test("스칼라 배열: 두 요소의 값이 서로 바뀐다", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 0, 2);
  swap();
  assert.deepEqual(rows(host), ["0:c", "1:b", "2:a"], "값만 교환(a<->c)");
});

// 인덱스 칸은 자리 번호라 안 건드린다 - 요소를 따라가면 안 된다.
test("스칼라 배열: 자리 번호({i})는 swap을 따라가지 않는다", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 0, 1);
  swap();
  const indices = [...host.querySelectorAll(".tag")].map((li) => li.querySelector(".idx")?.textContent);
  assert.deepEqual(indices, ["0", "1", "2"], "자리 번호는 그대로");
});

test("스칼라 배열: 이웃 교환", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 1, 2);
  swap();
  assert.deepEqual(rows(host), ["0:a", "1:c", "2:b"], "b<->c");
});

// i===j는 같은 칸끼리의 교환이라 값이 제자리에 돌아온다 - 따로 막지 않아도 결과가 같다.
// 걷기가 같은 주소를 두 번 읽고 쓰는 것을 견디는지 본다.
test("스칼라 배열: i===j도 안전하다(같은 칸끼리 교환)", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 1, 1);
  swap();
  assert.deepEqual(rows(host), ["0:a", "1:b", "2:c"], "그대로");
});

// 순서를 뒤집어 불러도 같은 결과여야 한다 - swap은 대칭이다.
test("스칼라 배열: 인자 순서를 뒤집어도 같다", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 2, 0);
  swap();
  assert.deepEqual(rows(host), ["0:c", "1:b", "2:a"], "swapAt(2,0) == swapAt(0,2)");
});

// 노드를 옮기지 않는다는 것의 직접 확인 - swap 전후로 같은 DOM 노드가 같은 자리에 있어야 한다.
// 노드를 옮기거나 다시 지었다면 이 동일성이 깨진다.
test("스칼라 배열: 회차 DOM 노드가 그대로다(재생성/이동 없음)", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 0, 2);
  const before = [...host.querySelectorAll(".tag")];
  swap();
  const after = [...host.querySelectorAll(".tag")];
  assert.equal(after.length, 3, "회차 수 유지");
  for (let i = 0; i < 3; i++) {
    assert.equal(after[i], before[i], `${i}번 자리의 노드가 같은 노드`);
  }
});

// swap 뒤에도 요소 leaf가 살아 있어야 한다 - 두 번 부르면 원래대로 돌아온다.
test("스칼라 배열: 두 번 swap하면 원래대로", () => {
  const { host, swap } = scalarFixture(["a", "b", "c"], 0, 2);
  swap();
  swap();
  assert.deepEqual(rows(host), ["0:a", "1:b", "2:c"], "왕복");
});

// ── 평평한 객체 배열 ─────────────────────────────────────────────
// 요소가 {label,value} 두 칸이라, 한 칸만 옮기는 실수를 잡는다.

const statTexts = (host: ParentNode) => [...host.querySelectorAll(".stat")].map((s) => s.textContent);

const objFixture = (stats: Array<{ label: string; value: string }>, i: number, j: number) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const swapAt = ctx.swapAt as TSwap;
      const props = ctx.props as Record<string, number>;
      swapAt(props.stats, i, j);
    },
  };
  const inst = compile(objQubb)(0)({ stats }, handlers);
  const host = mount(inst);
  return { host, swap: () => (host.querySelector(".add") as HTMLButtonElement).click() };
};

test("객체 배열: 요소의 모든 필드가 함께 바뀐다", () => {
  const { host, swap } = objFixture(
    [
      { label: "HP", value: "100" },
      { label: "MP", value: "50" },
    ],
    0,
    1,
  );
  swap();
  assert.deepEqual(statTexts(host), ["MP: 50", "HP: 100"], "label과 value가 짝을 유지한 채 교환");
});

// 필드 하나만 옮기면 여기서 "HP: 50"처럼 섞인 짝이 나온다.
test("객체 배열: 필드가 섞이지 않는다(세 요소 중 양끝 교환)", () => {
  const { host, swap } = objFixture(
    [
      { label: "HP", value: "100" },
      { label: "MP", value: "50" },
      { label: "ATK", value: "12" },
    ],
    0,
    2,
  );
  swap();
  assert.deepEqual(statTexts(host), ["ATK: 12", "MP: 50", "HP: 100"], "가운데는 그대로");
});

// ── 중첩 배열을 품은 요소 ────────────────────────────────────────
// rows: { label, cells: string[] }[] - 요소가 배열을 품는다. 여기서는 칸 값(arrayInfoIndex)을
// 맞바꾸지 않는다 - reactiveArrayFor가 build 때 읽은 arrayInfo를 클로저로 붙들어 칸을 다시 안 읽어,
// 바꿔도 안쪽 @for가 안 따라온다. 목록(elemStartLeafIndices) 교환도 같은 이유로 안 된다 -
// 이미 지어진 회차는 build 때 실은 요소 leaf 주소를 계속 본다.
//
// 그래서 안쪽도 바깥과 같은 방식이다 - 겹치는 앞자리는 요소 값을 서로 교환하고, 길이 차이가 나는
// 꼬리만 긴 쪽에서 짧은 쪽으로 옮긴다(setArrayInto의 자리 유지 전략과 같은 뼈대).

const nestedFixture = (rows: Array<{ label: string; cells: string[] }>, i: number, j: number) => {
  const handlers: THandlers = {
    // 안쪽 @for의 element라 fullname에 두 익명 접미가 붙는다(for-nested-index-del.test.ts와 같은 규칙).
    "[$0][$1].DEL_CELL": (_d, ctx) => {
      const swapAt = ctx.swapAt as TSwap;
      const props = ctx.props as Record<string, number>;
      swapAt(props.rows, i, j);
    },
  };
  const inst = compile(nestedQubb)(0)({ rows }, handlers);
  const host = mount(inst);
  return { host, swap: () => (host.querySelector(".delcell") as HTMLButtonElement).click() };
};

// 각 행을 "라벨[셀들]"로 - 안쪽 인덱스({j})와 값을 함께 본다. 자리 번호가 요소를 따라가지 않는 것을
// 바깥({i})과 안쪽({j}) 양쪽에서 확인한다.
const grid = (host: ParentNode) =>
  [...host.querySelectorAll(".row")].map((r) => {
    const cells = [...r.querySelectorAll(".cell")]
      .map((c) => `${c.querySelector(".cellidx")?.textContent}:${c.querySelector(".cellval")?.textContent}`)
      .join(",");
    return `${r.querySelector(".rowidx")?.textContent}:${r.querySelector(".label")?.textContent}[${cells}]`;
  });

test("중첩 배열: 안쪽 길이가 같으면 값만 교환된다", () => {
  const { host, swap } = nestedFixture(
    [
      { label: "R0", cells: ["a", "b"] },
      { label: "R1", cells: ["c", "d"] },
    ],
    0,
    1,
  );
  swap();
  assert.deepEqual(grid(host), ["0:R1[0:c,1:d]", "1:R0[0:a,1:b]"], "label과 cells가 짝을 유지한 채 교환");
});

// 길이가 다르면 안쪽 @for 회차 수도 따라와야 한다 - 2개짜리 자리가 1개로 줄고, 1개짜리 자리가 2개로 는다.
test("중첩 배열: 안쪽 길이가 다르면 회차 수도 따라온다", () => {
  const { host, swap } = nestedFixture(
    [
      { label: "R0", cells: ["a", "b"] },
      { label: "R1", cells: ["c"] },
    ],
    0,
    1,
  );
  swap();
  assert.deepEqual(grid(host), ["0:R1[0:c]", "1:R0[0:a,1:b]"], "0번은 2->1개, 1번은 1->2개");
});

// 반대 방향(짧은 쪽이 앞) - 꼬리를 옮기는 방향이 뒤집힌다.
test("중첩 배열: 짧은 쪽이 앞에 있어도 된다", () => {
  const { host, swap } = nestedFixture(
    [
      { label: "R0", cells: ["a"] },
      { label: "R1", cells: ["b", "c", "d"] },
    ],
    0,
    1,
  );
  swap();
  assert.deepEqual(grid(host), ["0:R1[0:b,1:c,2:d]", "1:R0[0:a]"], "0번은 1->3개, 1번은 3->1개");
});

// 빈 배열이 끼면 한쪽 회차가 0개가 된다 - 꼬리 전량 이동.
test("중첩 배열: 한쪽이 빈 배열이어도 된다", () => {
  const { host, swap } = nestedFixture(
    [
      { label: "R0", cells: [] },
      { label: "R1", cells: ["a", "b"] },
    ],
    0,
    1,
  );
  swap();
  assert.deepEqual(grid(host), ["0:R1[0:a,1:b]", "1:R0[]"], "0번은 0->2개, 1번은 2->0개");
});

// 두 번 부르면 원래대로 - 꼬리를 옮기는 과정에서 요소를 잃거나 중복하지 않았는지 본다.
test("중첩 배열: 두 번 swap하면 원래대로", () => {
  const { host, swap } = nestedFixture(
    [
      { label: "R0", cells: ["a", "b"] },
      { label: "R1", cells: ["c"] },
    ],
    0,
    1,
  );
  swap();
  swap();
  assert.deepEqual(grid(host), ["0:R0[0:a,1:b]", "1:R1[0:c]"], "왕복");
});

// 바깥 회차 DOM은 그대로여야 한다 - 안쪽이 늘고 줄어도 행 자체를 다시 짓지는 않는다.
test("중첩 배열: 바깥 회차 DOM은 재생성되지 않는다", () => {
  const { host, swap } = nestedFixture(
    [
      { label: "R0", cells: ["a", "b"] },
      { label: "R1", cells: ["c"] },
    ],
    0,
    1,
  );
  const before = [...host.querySelectorAll(".row")];
  swap();
  const after = [...host.querySelectorAll(".row")];
  assert.equal(after.length, 2, "행 수 유지");
  for (let i = 0; i < 2; i++) {
    assert.equal(after[i], before[i], `${i}번 행이 같은 노드`);
  }
});

// swap 뒤에도 안쪽 배열이 살아 있어야 한다 - 옮겨진 자리에서 제거가 정상 동작하는지.
test("중첩 배열: swap 뒤 안쪽 제거가 정상 동작한다", () => {
  let swapped = false;
  const handlers: THandlers = {
    "[$0][$1].DEL_CELL": (_d, ctx) => {
      const swapAt = ctx.swapAt as TSwap;
      const removeAt = ctx.removeAt as (a: unknown, i: number) => void;
      const props = ctx.props as { rows: Record<number, { cells: unknown }> & number };
      // 첫 클릭은 swap, 그 뒤 클릭은 자기 셀 제거 - 한 이벤트뿐이라 한 핸들러에서 갈라 쓴다.
      if (!swapped) {
        swapped = true;
        swapAt(props.rows, 0, 1);
        return;
      }
      removeAt(props.rows[ctx.$0 as number].cells, ctx.$1 as number);
    },
  };
  const inst = compile(nestedQubb)(0)(
    {
      rows: [
        { label: "R0", cells: ["a", "b"] },
        { label: "R1", cells: ["c"] },
      ],
    },
    handlers,
  );
  const host = mount(inst);
  const cellButton = (row: number, cell: number) =>
    [...[...host.querySelectorAll(".row")][row].querySelectorAll(".cell")][cell].querySelector(
      ".delcell",
    ) as HTMLButtonElement;

  cellButton(0, 0).click(); // swap - 0번 행이 ["c"], 1번 행이 ["a","b"]
  assert.deepEqual(grid(host), ["0:R1[0:c]", "1:R0[0:a,1:b]"], "swap 완료");
  cellButton(1, 0).click(); // 1번 행의 "a" 제거
  assert.deepEqual(grid(host), ["0:R1[0:c]", "1:R0[0:b]"], "옮겨진 자리에서 제거/당김 정상");
});
