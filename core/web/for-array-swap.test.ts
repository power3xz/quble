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

// ── 중첩 배열은 1단계에서 막는다 ─────────────────────────────────
// rows: { label, cells: string[] }[] - 요소가 배열을 품는다. 칸 값(arrayInfoIndex)만 바꿔서는
// 안쪽 @for가 옛 arrayInfo를 계속 보므로, 조용히 어긋나는 대신 throw한다.

test("중첩 배열을 품은 요소는 throw한다", () => {
  let caught: string | null = null;
  const handlers: THandlers = {
    // 안쪽 @for의 element라 fullname에 두 익명 접미가 붙는다(for-nested-index-del.test.ts와 같은 규칙).
    "[$0][$1].DEL_CELL": (_d, ctx) => {
      const swapAt = ctx.swapAt as TSwap;
      const props = ctx.props as Record<string, number>;
      try {
        swapAt(props.rows, 0, 1);
      } catch (e) {
        caught = (e as Error).message;
      }
    },
  };
  const inst = compile(nestedQubb)(0)(
    {
      rows: [
        { label: "r0", cells: ["a", "b"] },
        { label: "r1", cells: ["c"] },
      ],
    },
    handlers,
  );
  const host = mount(inst);
  (host.querySelector(".delcell") as HTMLButtonElement).click();
  assert.match(caught ?? "", /중첩 배열/, `막혀야: ${caught}`);
});
