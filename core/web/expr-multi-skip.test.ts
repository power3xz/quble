// 한 flush에서 읽는 leaf 여럿이 바뀌어도 바뀐 변수를 하나도 품지 않은 부분식은 건너뛴다.
// 변수마다의 건너뛰기 표(skipPastOpByVar)를 바뀐 변수 수만큼 함께 참조해, 잎 위치에서 모든 표에 항목이
// 있을 때만 건너뛴다(expr-skip-table.ts).
//
// ((a + b) * c) - (d + e)
//   위치  0          3          6    7          10   11         14         17   18
//         LOAD_VAR a LOAD_VAR b ADD  LOAD_VAR c MUL  LOAD_VAR d LOAD_VAR e ADD  SUB
//   a가 바뀌면 { 11: 17 }(d + e), c가 바뀌면 { 0: 6, 11: 17 }(a + b, d + e), d가 바뀌면 { 0: 10 }
//   ((a + b) * c)를 건너뛴다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_multi_skip");
});

// props 선언 순서가 곧 leafIndex.
const A = 0;
const B = 1;
const C = 2;
const D = 3;
const E = 4;

// ((1 + 2) * 3) - (4 + 5) = 0
const instantiate = () => {
  const inst = compile(qubb)(0)({ a: 1, b: 2, c: 3, d: 4, e: 5 }, {});
  const host = mount(inst);
  const store = inst.store;
  const sum = host.querySelector(".sum") as HTMLElement;
  const observer = new (host.ownerDocument.defaultView as unknown as typeof globalThis).MutationObserver(() => {});
  observer.observe(sum, { subtree: true, childList: true, characterData: true });
  return {
    store,
    text: () => sum.textContent,
    writeCount: () => observer.takeRecords().length,
    // action 동안 런타임이 store에서 읽은 leaf들.
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

test("a와 c가 함께 바뀌면 둘 다 품지 않은 d + e만 건너뛴다", () => {
  const { store, text, writeCount, readsDuring } = instantiate();
  assert.equal(text(), "0");
  const reads = readsDuring(() =>
    store.batch(() => {
      store.set(A, 2);
      store.set(C, 10);
    }),
  );
  assert.equal(text(), "31", "((2 + 2) * 10) - (4 + 5)");
  assert.deepEqual(reads, [A, B, C], "d, e는 읽지 않는다");
  assert.equal(writeCount(), 1);
});

test("a와 b가 함께 바뀌면 같은 부분식이라 d + e를 건너뛰고 한 번만 센다", () => {
  const { store, text, writeCount, readsDuring } = instantiate();
  const reads = readsDuring(() =>
    store.batch(() => {
      store.set(A, 5);
      store.set(B, 5);
    }),
  );
  assert.equal(text(), "21", "((5 + 5) * 3) - (4 + 5)");
  assert.deepEqual(reads, [A, B, C]);
  assert.equal(writeCount(), 1);
});

test("a와 d가 함께 바뀌면 건너뛸 부분식이 없어 처음부터 센다", () => {
  const { store, text, readsDuring } = instantiate();
  const reads = readsDuring(() =>
    store.batch(() => {
      store.set(A, 2);
      store.set(D, 1);
    }),
  );
  assert.equal(text(), "6", "((2 + 2) * 3) - (1 + 5)");
  assert.deepEqual(reads, [A, B, C, D, E]);
});
