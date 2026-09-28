// 값 자리 식의 부분 재평가 - 식이 읽는 칸 하나가 바뀌면, 그 칸을 품지 않은 부분식은 계산하지 않고
// 지난번 값을 쓴다(expr-skip-table.ts).
//
// 확인할 것은 셋이다.
//   - 값: 어느 칸이 바뀌든 결과가 처음부터 센 것과 같다.
//   - 건너뛰기: 바뀐 칸을 품지 않은 부분식의 칸은 다시 읽지 않는다. 인스턴스가 내놓는 store는
//     런타임이 쓰는 store와 같은 객체라, get을 감싸 어느 칸을 읽었는지 기록해 본다.
//   - 부모가 같은 칸을 두 prop으로 넘겨 식의 두 변수가 같은 칸을 가리켜도 값이 맞다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_partial_reeval");
});

// props 선언 순서가 곧 고정부 leafIndex. 배열은 칸 하나(arrayInfoIndex).
//   0=a 1=b 2=c 3=d 4=rows 5=cursor 6=x 7=shared 8=z
// rows 요소는 {score} 1칸이라 요소 i의 score = 9 + i.
const A = 0;
const B = 1;
const C = 2;
const D = 3;
const ROWS = 4;
const CURSOR = 5;
const X = 6;
const SHARED = 7;
const Z = 8;
const scoreLeaf = (i: number) => 9 + i;

const seed = () => ({
  a: 1,
  b: 2,
  c: 5,
  d: 3,
  rows: [{ score: 10 }, { score: 20 }],
  cursor: 0,
  x: 100,
  shared: 2,
  z: 3,
});

const instantiate = () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);
  const store = inst.store;
  return {
    textOf: (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent,
    set: (leafIndex: number, v: unknown) => store.set(leafIndex, v),
    // action 동안 런타임이 store에서 읽은 칸들. set 안의 값 비교는 store 내부에서 get을 거치지 않아
    // 여기 잡히지 않는다 - 잡히는 것은 식을 세며 읽은 칸뿐이다.
    readsDuring: (action: () => void) => {
      const original = store.get;
      const reads: number[] = [];
      store.get = (leafIndex: number) => {
        reads.push(leafIndex);
        return original(leafIndex);
      };
      try {
        action();
      } finally {
        store.get = original;
      }
      return reads;
    },
  };
};

test("(a + b) * (c - d)가 어느 칸이 바뀌어도 맞게 센다", () => {
  const { textOf, set } = instantiate();
  assert.equal(textOf("arith"), "6", "(1 + 2) * (5 - 3)");
  set(C, 7);
  assert.equal(textOf("arith"), "12", "(1 + 2) * (7 - 3)");
  set(A, 4);
  assert.equal(textOf("arith"), "24", "(4 + 2) * (7 - 3)");
  set(D, 5);
  assert.equal(textOf("arith"), "12", "(4 + 2) * (7 - 5)");
  set(B, 0);
  assert.equal(textOf("arith"), "8", "(4 + 0) * (7 - 5)");
});

test("c가 바뀌면 a + b를 건너뛰어 a, b를 읽지 않는다", () => {
  const { readsDuring, set } = instantiate();
  // c - d를 다시 세려고 c, d만 읽는다.
  assert.deepEqual(
    readsDuring(() => set(C, 7)),
    [C, D],
  );
});

test("a가 바뀌면 c - d를 건너뛰어 c, d를 읽지 않는다", () => {
  const { readsDuring, set } = instantiate();
  assert.deepEqual(
    readsDuring(() => set(A, 4)),
    [A, B],
  );
});

test("인덱스 접근 식도 어느 칸이 바뀌어도 맞게 센다", () => {
  const { textOf, set } = instantiate();
  assert.equal(textOf("index"), "110", "rows[0].score + x");
  set(X, 1);
  assert.equal(textOf("index"), "11", "rows[0].score + 1");
  set(scoreLeaf(0), 50);
  assert.equal(textOf("index"), "51", "rows[0].score(50) + 1");
  set(CURSOR, 1);
  assert.equal(textOf("index"), "21", "rows[1].score + 1");
});

test("x가 바뀌면 rows[cursor].score를 건너뛰어 rows, cursor, 요소 칸을 읽지 않는다", () => {
  const { readsDuring, set } = instantiate();
  assert.deepEqual(
    readsDuring(() => set(X, 1)),
    [X],
  );
});

test("요소 칸이 바뀌면 그 칸의 leafIndex를 다시 찾지 않아 rows, cursor를 읽지 않는다", () => {
  const { readsDuring, set } = instantiate();
  // rows[cursor].score의 leafIndex를 내는 앞부분은 지난번 값을 쓰고, 요소 칸과 x만 읽는다.
  assert.deepEqual(
    readsDuring(() => set(scoreLeaf(0), 50)),
    [scoreLeaf(0), X],
  );
  void ROWS;
});

test("두 변수가 같은 칸을 가리켜도 그 칸이 바뀌면 맞게 센다", () => {
  const { textOf, set } = instantiate();
  // 자식의 p, q가 모두 부모의 shared 칸을 가리킨다.
  assert.equal(textOf("pair"), "8", "2 + 2 * 3");
  set(SHARED, 4);
  assert.equal(textOf("pair"), "16", "4 + 4 * 3");
  set(Z, 5);
  assert.equal(textOf("pair"), "24", "4 + 4 * 5");
});
