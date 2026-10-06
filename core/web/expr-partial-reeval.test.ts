// 값 자리 식의 부분 재평가 - 식이 읽는 칸 하나가 바뀌면, 그 칸을 품지 않은 부분식은 계산하지 않고
// 지난번 값을 쓴다(expr-skip-table.ts).
//
// 확인할 것은 셋이다.
//   - 값: 어느 칸이 바뀌든 결과가 처음부터 센 것과 같다.
//   - 건너뛰기: 바뀐 칸을 품지 않은 부분식의 칸은 다시 읽지 않는다. 인스턴스가 내놓는 store는
//     런타임이 쓰는 store와 같은 객체라, get을 감싸 어느 칸을 읽었는지 기록해 본다.
//   - 부모가 같은 칸을 두 prop으로 넘겨 식의 두 변수가 같은 칸을 가리켜도 값이 맞다.
//   - 구독: 식 하나가 칸을 여럿 읽어도 구독 함수는 하나다. 다시 센 값이 지난번과 같으면 DOM에 안
//     쓴다. 식이 든 가지가 꺼진 동안 칸이 바뀌어도 다시 켜면 맞게 센다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_partial_reeval");
});

// props 선언 순서가 곧 고정부 leafIndex. 배열은 칸 하나(arrayInfoIndex).
//   0=a 1=b 2=c 3=d 4=rows 5=cursor 6=x 7=shared 8=z 9=show 10=big
// rows 요소는 {score} 1칸이라 요소 i의 score = 11 + i.
const A = 0;
const B = 1;
const C = 2;
const D = 3;
const ROWS = 4;
const CURSOR = 5;
const X = 6;
const SHARED = 7;
const Z = 8;
const SHOW = 9;
const BIG = 10;
const scoreLeaf = (i: number) => 11 + i;

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
  // 켜 두면 @if 안의 (a + b) * (c - d)도 a~d를 읽어, 읽은 칸을 세는 테스트가 두 식 몫을 본다.
  show: false,
  big: 100,
});

const instantiate = () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);
  const store = inst.store;
  return {
    inst,
    host,
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

test("식 하나가 칸을 여럿 읽어도 구독 함수는 하나다", () => {
  const { inst } = instantiate();
  // (a + b) * (c - d)는 루트 가지에 있고, a~d 네 칸을 구독한다. 칸마다 함수를 따로 만들면 1만 행에서
  // 함수가 수만 개 늘어 메모리가 CPU 캐시를 넘친다.
  const root = inst.branchPool.entries.find((b: { leafIndices: number[] }) => b.leafIndices.includes(A));
  assert.ok(root);
  const subscriberOf = (leafIndex: number) => root.updateFns[root.leafIndices.indexOf(leafIndex)];
  assert.equal(new Set([A, B, C, D].map(subscriberOf)).size, 1);
});

test("다시 센 값이 지난번과 같으면 DOM에 쓰지 않는다", () => {
  const { host, set, textOf } = instantiate();
  const flag = host.querySelector(".flag") as HTMLElement;
  const observer = new (host.ownerDocument.defaultView as unknown as typeof globalThis).MutationObserver(() => {});
  observer.observe(flag, { subtree: true, childList: true, characterData: true });
  set(BIG, 200);
  assert.deepEqual(observer.takeRecords(), [], "big > 50은 true 그대로라 쓰지 않는다");
  set(BIG, 1);
  assert.notDeepEqual(observer.takeRecords(), [], "false로 바뀌어 쓴다");
  assert.equal(textOf("flag"), "false");
  observer.disconnect();
});

test("식이 든 가지가 꺼진 동안 칸 둘이 바뀌어도 다시 켜면 맞게 센다", () => {
  const { set, textOf } = instantiate();
  set(SHOW, true);
  assert.equal(textOf("shown"), "6", "(1 + 2) * (5 - 3)");
  set(SHOW, false);
  set(A, 4);
  set(C, 7);
  // 다시 켤 때 구독한 칸마다 한 번씩 다시 센다. a가 바뀐 몫과 c가 바뀐 몫을 둘 다 반영해야 한다.
  set(SHOW, true);
  assert.equal(textOf("shown"), "24", "(4 + 2) * (7 - 3)");
});

// 한 batch에서 서로 다른 부분식의 칸이 함께 바뀌면 flush의 첫 통지가 바뀐 칸 전체로 한 번에 다시 센다.
// 칸마다 따로 세면 첫 통지에서 새 a와 cache의 옛 c가 섞인 중간 값이 DOM에 쓰인다.

// cls 요소 아래에 DOM 쓰기가 몇 번 일어났는지 센다. takeRecords는 동기라 batch 직후 바로 읽는다.
const observeWrites = (host: HTMLElement, cls: string) => {
  const target = host.querySelector(`.${cls}`) as HTMLElement;
  const observer = new (host.ownerDocument.defaultView as unknown as typeof globalThis).MutationObserver(() => {});
  observer.observe(target, { subtree: true, childList: true, characterData: true });
  return { writeCount: () => observer.takeRecords().length };
};

test("batch에서 a와 c가 함께 바뀌면 최종 값 하나만 DOM에 쓴다", () => {
  const { inst, host, textOf } = instantiate();
  const arith = observeWrites(host, "arith");
  inst.store.batch(() => {
    inst.store.set(A, 2);
    inst.store.set(C, 10);
  });
  assert.equal(textOf("arith"), "28", "(2 + 2) * (10 - 3)");
  assert.equal(arith.writeCount(), 1, "섞인 중간 값 (2 + 2) * (5 - 3) = 8을 쓰지 않는다");
});

test("batch에서 cursor와 x가 함께 바뀌면 최종 값 하나만 쓰고 구독도 옮겨 간다", () => {
  const { inst, host, textOf, set } = instantiate();
  assert.equal(textOf("index"), "110", "rows[0].score + x");
  const index = observeWrites(host, "index");
  inst.store.batch(() => {
    inst.store.set(CURSOR, 1);
    inst.store.set(X, 200);
  });
  assert.equal(textOf("index"), "220", "rows[1].score + x");
  assert.equal(index.writeCount(), 1, "중간 값 20 + 100 = 120을 쓰지 않는다");
  set(scoreLeaf(1), 50);
  assert.equal(textOf("index"), "250", "새 요소의 score 구독이 걸려 있다");
  set(scoreLeaf(0), 999);
  assert.equal(textOf("index"), "250", "옛 요소의 score는 더는 읽지 않는다");
});

test("batch에서 읽는 칸 둘이 함께 바뀌어도 건너뛴 부분식 없이 한 번 센다", () => {
  const { inst, host, readsDuring } = instantiate();
  const arith = observeWrites(host, "arith");
  const reads = readsDuring(() =>
    inst.store.batch(() => {
      inst.store.set(A, 2);
      inst.store.set(C, 10);
    }),
  );
  assert.deepEqual(reads, [A, B, C, D], "식을 한 번 처음부터 센다");
  assert.equal(arith.writeCount(), 1);
});
