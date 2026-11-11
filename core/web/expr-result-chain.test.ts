// 식의 결과 leaf를 다른 식이 입력으로 읽는 경우 - 합성 인자로 식을 넘기면 자식 식이 부모 식의 결과 leaf를 읽는다. 둘 사이에
// 그래프 간선이 없어, 결과 leaf에 쓴 값도 flush가 파생 구독으로 전파해야 한다.
//
// 식 바이트와 스코프를 직접 지어 풀만 검증한다(컴파일러 없이).

import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPR_ADD, EXPR_LOAD_VAR } from "./expr-opcode.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { STORE } from "./scope.ts";
import { exprPoolOf } from "./test-helpers/expr-pool.ts";

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];
const ADD = new Uint8Array([...load(0), ...load(1), EXPR_ADD]);

// 식 인스턴스를 만들어 가지가 든 것처럼 retainByBranch하고, 처음 센 값을 결과 leaf에 넣고 입력에 파생 구독을 건다.
const build = (
  pool: ReturnType<typeof exprPoolOf>,
  store: ReturnType<typeof createLeafStoreSubject>,
  globalExprIndex: number,
  pairs: number[],
  resultLeaf: number,
) => {
  const exprInstanceIndex = pool.create(globalExprIndex, pairs, 0);
  pool.retainByBranch(exprInstanceIndex);
  store.write(resultLeaf, pool.evaluate(exprInstanceIndex));
  pool.bindResultLeaf(exprInstanceIndex, resultLeaf);
  pool.subscribeInputs(exprInstanceIndex);
  return exprInstanceIndex;
};

test("식의 결과 leaf를 읽는 식은 그 식의 입력이 바뀌면 다시 센다", () => {
  // A = leaf0 + leaf1 -> 결과 leaf 2. B = leaf2 + leaf1 -> 결과 leaf 3.
  const store = createLeafStoreSubject([1, 2, 0, 0]);
  const pool = exprPoolOf(store, [ADD, ADD]);
  build(pool, store, 0, [STORE, 0, STORE, 1], 2);
  build(pool, store, 1, [STORE, 2, STORE, 1], 3);
  assert.equal(store.get(3), 5);
  const notified: unknown[] = [];
  store.subscribe(3, (value) => notified.push(value));

  store.set(0, 10);

  assert.equal(store.get(2), 12);
  assert.equal(store.get(3), 14);
  assert.deepEqual(notified, [14]);
});

test("결과 leaf를 두 단계 건너 읽어도 센다", () => {
  // A = leaf0 + leaf1 -> 2, B = leaf2 + leaf1 -> 3, C = leaf3 + leaf1 -> 4.
  const store = createLeafStoreSubject([1, 2, 0, 0, 0]);
  const pool = exprPoolOf(store, [ADD, ADD, ADD]);
  build(pool, store, 0, [STORE, 0, STORE, 1], 2);
  build(pool, store, 1, [STORE, 2, STORE, 1], 3);
  build(pool, store, 2, [STORE, 3, STORE, 1], 4);
  assert.equal(store.get(4), 7);

  store.set(0, 10);

  assert.equal(store.get(4), 16);
});

test("앞 식의 값이 그대로면 결과 leaf를 읽는 식의 결과 leaf를 통지하지 않는다", () => {
  // leaf0이 1->2, leaf1이 2->1로 바뀌어도 A = leaf0 + leaf1은 3 그대로다. B = leaf2 + leaf2도 그대로다.
  const store = createLeafStoreSubject([1, 2, 0, 0]);
  const pool = exprPoolOf(store, [ADD, ADD]);
  build(pool, store, 0, [STORE, 0, STORE, 1], 2);
  build(pool, store, 1, [STORE, 2, STORE, 2], 3);
  const notified: unknown[] = [];
  store.subscribe(3, (value) => notified.push(value));

  store.batch(() => {
    store.set(0, 2);
    store.set(1, 1);
  });

  assert.equal(store.get(2), 3);
  assert.deepEqual(notified, []);
});
