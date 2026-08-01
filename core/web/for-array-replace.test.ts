// 배열 통째 교체(replace) - 기존 요소를 전부 회수하고 새 값들로 다시 심는다.
//
// push/removeAt이 "무엇이 어떻게 바뀌었나"를 아는 부분 갱신인 반면 replace는 전량 교체라, @for 회차
// DOM도 전부 다시 짓는다. 그래서 확인할 것이 회차 DOM/인덱스 변수/중첩 배열/이벤트 바인딩 넷이다.
//
// 특히 개수가 그대로인 교체(3개 -> 다른 3개)를 본다 - store.set이 값이 같으면 발화를 건너뛰므로,
// 길이 칸만 믿으면 떼어낸 DOM이 되살아나지 않는다.

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
  [...host.querySelectorAll(".row")].map((row) =>
    [...row.querySelectorAll(".cell")].map((n) => n.textContent),
  );

const picked: number[] = [];

// REPLACE를 누르면 큐에서 다음 목록을 꺼내 통째로 갈아끼운다.
const handlersFor = (queue: TRow[][]): THandlers => ({
  REPLACE: (_data: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const replace = ctx.replace as (arrayLeafIndex: number, elems: unknown[]) => void;
    const props = ctx.props as Record<string, number>;
    const next = queue.shift();
    if (next !== undefined) {
      replace(props.rows, next);
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
