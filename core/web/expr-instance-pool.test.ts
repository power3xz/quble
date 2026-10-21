// 식 인스턴스 풀 - 식을 처음 세고, 가지가 붙을 때 입력 leaf에 파생 구독을 걸고 뗄 때 풀며, 다시 붙일 때 꺼진 동안
// 놓친 입력을 따라잡는다. 인스턴스는 참조 수가 0이 되면 구독과 결과 leaf와 풀 번호를 반납한다.
//
// 식 바이트와 스코프를 직접 지어 풀만 검증한다(컴파일러 없이).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator } from "./expr-eval.ts";
import { ExprInstancePool } from "./expr-layer.ts";
import { EXPR_ADD, EXPR_LOAD_VAR, EXPR_MUL, EXPR_SUB } from "./expr-opcode.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import { STORE } from "./scope.ts";

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];

// a + b. leaf 0=a, 1=b, 2=결과.
const sum = () => ({
  store: createLeafStoreSubject([1, 2, 0]),
  expr: new Uint8Array([...load(0), ...load(1), EXPR_ADD]),
  pairs: [STORE, 0, STORE, 1],
  resultLeafIndex: 2,
});

// (a + b) * (c - d). leaf 0=a, 1=b, 2=c, 3=d, 4=결과. 부분식을 건너뛰는 표가 생기는 식이다.
const product = () => ({
  store: createLeafStoreSubject([1, 2, 5, 3, 0]),
  expr: new Uint8Array([...load(0), ...load(1), EXPR_ADD, ...load(2), ...load(3), EXPR_SUB, EXPR_MUL]),
  pairs: [STORE, 0, STORE, 1, STORE, 2, STORE, 3],
  resultLeafIndex: 4,
});

const poolOf = (store: ReturnType<typeof createLeafStoreSubject>) =>
  new ExprInstancePool(new ExprEvaluator([], store, new Pool()), store);

// 식 인스턴스를 짓고 처음 센 뒤 결과 leaf를 연결한다. 구독은 걸지 않은 상태다(가지가 붙기 전).
const build = (fixture: ReturnType<typeof sum>) => {
  const pool = poolOf(fixture.store);
  const exprInstanceIndex = pool.create(fixture.expr, fixture.pairs);
  const value = pool.evaluate(exprInstanceIndex);
  pool.bindResultLeaf(exprInstanceIndex, fixture.resultLeafIndex);
  return { pool, exprInstanceIndex, value, store: fixture.store };
};

test("create는 refCount 1로 짓고 evaluate는 식을 세되 구독은 걸지 않는다", () => {
  const { pool, exprInstanceIndex, value, store } = build(sum());
  assert.equal(value, 3);
  assert.equal(pool.pool.entries[exprInstanceIndex].refCount, 1);

  store.set(0, 10);

  assert.equal(store.get(2), 0, "attach 전에는 결과 leaf에 쓰지 않는다");
});

test("evaluate를 여러 번 불러도 같은 값을 주고 구독 대상이 늘지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  assert.equal(pool.evaluate(exprInstanceIndex), 3);
  assert.equal(pool.evaluate(exprInstanceIndex), 3);
  pool.attach(exprInstanceIndex, false);
  pool.detach(exprInstanceIndex);

  store.set(0, 10);

  assert.equal(store.get(2), 0, "detach 한 번으로 모든 구독이 풀린다");
});

test("attach하면 입력이 바뀔 때 결과 leaf에 쓴다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex, false);

  store.set(0, 10);

  assert.equal(store.get(2), 12);
});

test("detach하면 입력이 바뀌어도 결과 leaf에 쓰지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex, false);
  pool.detach(exprInstanceIndex);

  store.set(0, 10);

  assert.equal(store.get(2), 0);
});

test("떼어 둔 동안 바뀐 입력은 catchUp이면 따라잡고 아니면 그대로 둔다", () => {
  const withCatchUp = build(sum());
  withCatchUp.pool.attach(withCatchUp.exprInstanceIndex, false);
  withCatchUp.pool.detach(withCatchUp.exprInstanceIndex);
  withCatchUp.store.set(0, 10);
  withCatchUp.pool.attach(withCatchUp.exprInstanceIndex, true);
  assert.equal(withCatchUp.store.get(2), 12, "catchUp이면 놓친 입력으로 결과를 맞춘다");

  const withoutCatchUp = build(sum());
  withoutCatchUp.pool.attach(withoutCatchUp.exprInstanceIndex, false);
  withoutCatchUp.pool.detach(withoutCatchUp.exprInstanceIndex);
  withoutCatchUp.store.set(0, 10);
  withoutCatchUp.pool.attach(withoutCatchUp.exprInstanceIndex, false);
  assert.equal(withoutCatchUp.store.get(2), 0, "catchUp이 아니면 따라잡지 않는다");
});

test("release는 refCount가 0이 될 때 결과 leaf와 풀 번호를 반납한다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex, false);
  pool.detach(exprInstanceIndex);
  pool.retain(exprInstanceIndex);

  pool.release(exprInstanceIndex);
  assert.equal(pool.pool.entries[exprInstanceIndex].refCount, 1, "하나 남았으니 살아 있다");
  assert.deepEqual(pool.pool.free, []);

  pool.release(exprInstanceIndex);
  assert.deepEqual(pool.pool.free, [exprInstanceIndex], "풀 번호가 반납된다");
  assert.equal(store.alloc([9]), 2, "결과 leaf가 반납되어 다시 쓰인다");
});

test("붙은 채로 release해도 구독이 풀려 반납된 결과 leaf를 건드리지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex, false);

  pool.release(exprInstanceIndex);
  const reused = store.alloc([99]);
  assert.equal(reused, 2);
  store.set(0, 10);

  assert.equal(store.get(reused), 99);
});

test("건너뛸 부분식이 있는 식도 같은 규칙으로 구독하고 따라잡는다", () => {
  const fixture = product();
  const { pool, exprInstanceIndex, value, store } = build(fixture);
  assert.notEqual(pool.evaluator.skipTable(fixture.expr), null, "부분식 표가 있는 식이다");
  assert.equal(value, 6);
  pool.attach(exprInstanceIndex, false);

  store.set(2, 7);
  assert.equal(store.get(4), 12, "c가 바뀌면 (a + b)는 건너뛰고 (c - d)만 다시 센다");

  pool.detach(exprInstanceIndex);
  store.set(0, 4);
  pool.attach(exprInstanceIndex, true);
  assert.equal(store.get(4), 24, "떼어 둔 동안 a가 바뀐 것을 따라잡는다");
});
