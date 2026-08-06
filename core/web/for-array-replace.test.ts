// 배열 통째 교체(setArray) - 겹치는 앞자리는 값만 덮어쓰고 꼬리만 늘리거나 줄인다.
//
// 확인할 것이 둘이다. 하나는 결과가 맞는가 - 회차 DOM/인덱스 변수/중첩 배열/이벤트 바인딩이 새 목록과
// 맞아야 한다. 다른 하나는 자리를 정말 지키는가 - 겹치는 회차의 DOM 노드가 같은 객체로 남아야 한다
// (다시 지으면 결과는 같아도 화면이 통째로 깜빡이고 캐럿/포커스가 날아간다).
//
// 중첩 배열이 특히 위험하다. 요소 안 배열 칸은 값이 아니라 arrayInfoIndex라, 덮어쓰기가 그 칸에
// store.set을 하면 포인터가 깨져 그 배열의 모든 요소 leaf를 잃는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_replace");
});

type TRow = { label: string; cells: string[] };

const labels = (host: ParentNode) => [...host.querySelectorAll(".label")].map((n) => n.textContent);
const indices = (host: ParentNode) => [...host.querySelectorAll(".idx")].map((n) => n.textContent);
const cellsOf = (host: ParentNode) =>
  [...host.querySelectorAll(".row")].map((row) => [...row.querySelectorAll(".cell")].map((n) => n.textContent));

const picked: number[] = [];

// REPLACE를 누르면 큐에서 다음 목록을 꺼내 통째로 갈아끼운다.
const handlersFor = (queue: TRow[][]): THandlers => ({
  REPLACE: (_data: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const setArray = ctx.setArray as (arrayLeafIndex: number, elems: unknown[]) => void;
    const props = ctx.props as Record<string, number>;
    const next = queue.shift();
    if (next !== undefined) {
      setArray(props.rows, next);
    }
  },
  // @for 직속 element라 익명 회차 세그먼트가 앞에 붙는다(SYNTAX.md).
  "[$0].PICK": (_data: Record<string, unknown>, ctx: Record<string, unknown>) => {
    picked.push(ctx.$0 as number);
  },
});

const instantiate = (rows: TRow[], queue: TRow[][] = []) => {
  picked.length = 0;
  const inst = compile(qubb)(0)({ rows }, handlersFor(queue));
  const host = mount(inst);
  return { inst, host, button: host.querySelector(".replace") as HTMLButtonElement };
};

const ROWS: TRow[] = [
  { label: "a", cells: ["a1", "a2"] },
  { label: "b", cells: ["b1"] },
];

test("교체하면 새 목록이 렌더된다", () => {
  const { host, button } = instantiate(ROWS, [[{ label: "x", cells: ["x1"] }]]);
  assert.deepEqual(labels(host), ["a", "b"], "초기");

  button.click();
  assert.deepEqual(labels(host), ["x"], "교체 후");
  assert.deepEqual(cellsOf(host), [["x1"]], "중첩 배열도 새 값");
});

test("개수가 같아도 교체된다", () => {
  // store.set의 동등성 건너뛰기에 막히면 여기서 목록이 빈 채로 남는다.
  const { host, button } = instantiate(ROWS, [
    [
      { label: "c", cells: ["c1", "c2"] },
      { label: "d", cells: ["d1"] },
    ],
  ]);

  button.click();
  assert.deepEqual(labels(host), ["c", "d"]);
  assert.deepEqual(cellsOf(host), [["c1", "c2"], ["d1"]]);
});

test("빈 배열로 교체하면 다 사라진다", () => {
  const { host, button } = instantiate(ROWS, [[]]);

  button.click();
  assert.deepEqual(labels(host), []);
  assert.equal(host.querySelectorAll(".row").length, 0);
});

test("빈 배열에서 다시 채울 수 있다", () => {
  const { host, button } = instantiate(ROWS, [[], [{ label: "z", cells: ["z1"] }]]);

  button.click();
  assert.deepEqual(labels(host), [], "비움");
  button.click();
  assert.deepEqual(labels(host), ["z"], "다시 채움");
  assert.deepEqual(cellsOf(host), [["z1"]]);
});

test("회차 인덱스가 0부터 다시 매겨진다", () => {
  const { host, button } = instantiate(ROWS, [
    [
      { label: "p", cells: [] },
      { label: "q", cells: [] },
      { label: "r", cells: [] },
    ],
  ]);
  assert.deepEqual(indices(host), ["0", "1"], "초기");

  button.click();
  assert.deepEqual(indices(host), ["0", "1", "2"], "교체 후");
});

test("교체한 요소의 이벤트가 새 회차 번호로 잡힌다", () => {
  const { host, button } = instantiate(ROWS, [
    [
      { label: "p", cells: [] },
      { label: "q", cells: [] },
      { label: "r", cells: [] },
    ],
  ]);

  (host.querySelectorAll(".pick")[1] as HTMLButtonElement).click();
  assert.deepEqual(picked, [1], "교체 전");

  button.click();
  (host.querySelectorAll(".pick")[2] as HTMLButtonElement).click();
  assert.deepEqual(picked, [1, 2], "교체 후 새 요소도 잡힌다");
});

// 자리 유지 - 겹치는 회차는 다시 짓지 않는다.

test("겹치는 회차의 DOM 노드가 그대로 남는다", () => {
  const { host, button } = instantiate(ROWS, [
    [
      { label: "a", cells: ["a1", "a2"] },
      { label: "B", cells: ["b1"] },
    ],
  ]);
  const before = [...host.querySelectorAll(".row")];

  button.click();
  const after = [...host.querySelectorAll(".row")];
  assert.equal(after[0], before[0], "안 바뀐 회차");
  assert.equal(after[1], before[1], "값만 바뀐 회차");
  assert.deepEqual(labels(host), ["a", "B"]);
});

test("늘어날 때 기존 회차는 그대로고 꼬리만 붙는다", () => {
  const { host, button } = instantiate(ROWS, [
    [
      { label: "a", cells: ["a1", "a2"] },
      { label: "b", cells: ["b1"] },
      { label: "c", cells: ["c1"] },
    ],
  ]);
  const before = [...host.querySelectorAll(".row")];

  button.click();
  const after = [...host.querySelectorAll(".row")];
  assert.deepEqual(after.slice(0, 2), before, "앞 두 회차 유지");
  assert.deepEqual(labels(host), ["a", "b", "c"]);
  assert.deepEqual(indices(host), ["0", "1", "2"]);
  assert.deepEqual(cellsOf(host), [["a1", "a2"], ["b1"], ["c1"]]);
});

test("줄어들 때 남는 회차는 그대로고 꼬리만 떨어진다", () => {
  const three: TRow[] = [
    { label: "p", cells: ["p1"] },
    { label: "q", cells: ["q1"] },
    { label: "r", cells: ["r1"] },
  ];
  const { host, button } = instantiate(three, [[{ label: "p", cells: ["p1"] }]]);
  const before = [...host.querySelectorAll(".row")];

  button.click();
  assert.deepEqual([...host.querySelectorAll(".row")], [before[0]], "첫 회차 유지");
  assert.deepEqual(labels(host), ["p"]);
});

// 중첩 배열 - 요소 안 배열 칸은 arrayInfoIndex라 덮어쓰기가 재귀해야 한다.

test("중첩 배열이 늘고 줄어도 맞는다", () => {
  const { host, button } = instantiate(ROWS, [
    [
      { label: "a", cells: ["a1", "a2", "a3"] }, // 2 -> 3
      { label: "b", cells: [] }, // 1 -> 0
    ],
    [
      { label: "a", cells: ["z"] }, // 3 -> 1
      { label: "b", cells: ["y1", "y2"] }, // 0 -> 2
    ],
  ]);

  button.click();
  assert.deepEqual(cellsOf(host), [["a1", "a2", "a3"], []]);
  button.click();
  assert.deepEqual(cellsOf(host), [["z"], ["y1", "y2"]]);
});

test("중첩 배열을 가진 회차를 덮어써도 목록이 안 쌓인다", () => {
  // 배열 칸에 set을 하면 arrayInfo 포인터가 깨져 이전 요소가 남거나 사라진다.
  const same: TRow[] = [
    { label: "a", cells: ["1", "2"] },
    { label: "b", cells: ["3"] },
  ];
  const { host, button } = instantiate(ROWS, [same, same, same]);

  button.click();
  button.click();
  button.click();
  assert.deepEqual(cellsOf(host), [["1", "2"], ["3"]]);
});

test("여러 번 교체해도 목록이 쌓이지 않는다", () => {
  // 회수가 새는지 본다 - 매번 지우고 심으므로 개수가 누적되면 안 된다.
  const { host, button } = instantiate(ROWS, [
    [{ label: "1", cells: [] }],
    [{ label: "2", cells: [] }],
    [{ label: "3", cells: [] }],
  ]);

  button.click();
  button.click();
  button.click();
  assert.deepEqual(labels(host), ["3"]);
});
