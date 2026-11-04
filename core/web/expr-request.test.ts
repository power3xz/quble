// flush의 pull이 incoming labeled edge로 식 인스턴스를 평가할지 정한다 - `[c] --(then)--> [x]`면 c의 값이 then과
// 맞을 때만 x를 평가한다. 간선은 테스트가 graph.addEdge로 직접 건다(가지에 연결하는 일은 vm이 할 일이다).
//
// x가 평가되었는지는 x의 결과 leaf로 본다. x는 `v * 10`이라, 평가되지 않으면 v가 바뀌어도 결과 leaf가 그대로다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator } from "./expr-eval.ts";
import { LABEL_ELSE, LABEL_THEN } from "./expr-graph.ts";
import { ExprInstancePool } from "./expr-layer.ts";
import { EXPR_LOAD_SMALL_INT, EXPR_LOAD_VAR, EXPR_MUL } from "./expr-opcode.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import { STORE } from "./scope.ts";

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];

// 식 0은 leaf 하나를 그대로 읽는 조건, 식 1은 `v * 10`이다.
const COND_EXPR = 0;
const TIMES_TEN_EXPR = 1;

const setup = (leaves: unknown[]) => {
  const store = createLeafStoreSubject(leaves);
  const exprBytes = [new Uint8Array(load(0)), new Uint8Array([...load(0), EXPR_LOAD_SMALL_INT, 10, EXPR_MUL])];
  const exprs = new ExprInstancePool(new ExprEvaluator([], exprBytes, store, new Pool()), store);
  // 식 인스턴스를 만들어 결과 leaf를 잡고 입력 leaf를 구독한다. 식 인스턴스 번호와 결과 leaf를 돌려준다.
  const make = (globalExprIndex: number, inputLeaf: number) => {
    const exprInstanceIndex = exprs.create(globalExprIndex, [STORE, inputLeaf]);
    const value = exprs.evaluate(exprInstanceIndex);
    const resultLeaf = store.alloc([value]);
    exprs.bindResultLeaf(exprInstanceIndex, resultLeaf);
    exprs.subscribeInputs(exprInstanceIndex);
    return { exprInstanceIndex, resultLeaf };
  };
  return { store, exprs, make };
};

test("label then인 incoming edge의 시작점이 false가 되면 끝점을 평가하지 않는다", () => {
  const C = 0;
  const V = 1;
  const { store, exprs, make } = setup([true, 1]);
  const c = make(COND_EXPR, C);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.graph.addEdge(c.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);

  store.batch(() => {
    store.set(C, false);
    store.set(V, 2);
  });

  assert.equal(store.get(c.resultLeaf), false, "조건은 평가된다");
  assert.equal(store.get(x.resultLeaf), 10, "x는 평가되지 않아 v = 1일 때의 값 그대로다");
});

test("label then인 incoming edge의 시작점이 true로 남으면 끝점을 평가한다", () => {
  const C = 0;
  const V = 1;
  const { store, exprs, make } = setup([true, 1]);
  const c = make(COND_EXPR, C);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.graph.addEdge(c.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);

  store.set(V, 2);

  assert.equal(store.get(x.resultLeaf), 20);
});

test("label else인 incoming edge의 시작점이 true가 되면 끝점을 평가하지 않는다", () => {
  const C = 0;
  const V = 1;
  const { store, exprs, make } = setup([false, 1]);
  const c = make(COND_EXPR, C);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.graph.addEdge(c.exprInstanceIndex, x.exprInstanceIndex, LABEL_ELSE);

  store.batch(() => {
    store.set(C, true);
    store.set(V, 2);
  });

  assert.equal(store.get(x.resultLeaf), 10);
});

test("label이 행 k인 incoming edge는 k < 시작점의 값일 때만 끝점을 평가한다", () => {
  const N = 0;
  const V = 1;
  const { store, exprs, make } = setup([3, 1]);
  const n = make(COND_EXPR, N);
  const row1 = make(TIMES_TEN_EXPR, V);
  const row2 = make(TIMES_TEN_EXPR, V);
  // label 1과 2는 행 번호다. 행 k의 식 인스턴스는 k < n일 때 평가한다.
  exprs.graph.addEdge(n.exprInstanceIndex, row1.exprInstanceIndex, 1);
  exprs.graph.addEdge(n.exprInstanceIndex, row2.exprInstanceIndex, 2);

  store.batch(() => {
    store.set(N, 2);
    store.set(V, 2);
  });

  assert.equal(store.get(row1.resultLeaf), 20, "1 < 2라 평가한다");
  assert.equal(store.get(row2.resultLeaf), 10, "2 < 2가 아니라 평가하지 않는다");
});

test("바깥 조건이 false면 안쪽 조건이 true로 남아 있어도 안쪽 본문을 평가하지 않는다", () => {
  const C1 = 0;
  const C2 = 1;
  const V = 2;
  const { store, exprs, make } = setup([true, true, 1]);
  const c1 = make(COND_EXPR, C1);
  const c2 = make(COND_EXPR, C2);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.graph.addEdge(c1.exprInstanceIndex, c2.exprInstanceIndex, LABEL_THEN);
  exprs.graph.addEdge(c2.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);

  store.batch(() => {
    store.set(C1, false);
    store.set(V, 2);
  });

  assert.equal(store.get(x.resultLeaf), 10);
});

test("평가하지 않은 식 인스턴스는 pendingVarMask를 남기고, 조건이 다시 맞은 뒤 recountPending이 평가한다", () => {
  // 조건이 다시 맞으면 본문이 다시 붙고 region이 recountPending을 호출한다. 이 테스트는 그 호출을 직접 한다.
  const C = 0;
  const V = 1;
  const { store, exprs, make } = setup([true, 1]);
  const c = make(COND_EXPR, C);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.graph.addEdge(c.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);
  assert.equal(exprs.pool.entries[x.exprInstanceIndex].pendingVarMask, 0);

  store.batch(() => {
    store.set(C, false);
    store.set(V, 2);
  });
  assert.notEqual(exprs.pool.entries[x.exprInstanceIndex].pendingVarMask, 0, "평가하지 않아 마스크가 남는다");

  store.batch(() => {
    store.set(C, true);
    store.set(V, 3);
  });
  assert.equal(store.get(x.resultLeaf), 10, "마스크가 남은 x는 push가 다시 셀 목록에 넣지 않는다");

  exprs.recountPending(x.exprInstanceIndex);

  assert.equal(store.get(x.resultLeaf), 30);
  assert.equal(exprs.pool.entries[x.exprInstanceIndex].pendingVarMask, 0, "평가하고 마스크를 지운다");
});

test("recountPending은 incoming edge의 시작점을 먼저 평가하고 그 값으로 평가 여부를 정한다", () => {
  // `[c1] --(then)--> [c2] --(then)--> [x]`에서 c1이 false인 동안 c2의 입력이 false로, x의 입력이 2로 바뀐다. c2와
  // x는 평가되지 않아 마스크가 남고, c2의 lastValue는 true인 채다. c1이 true가 된 뒤 x를 recountPending하면 c2를
  // 먼저 평가해 false를 얻으므로 x를 평가하지 않는다. c2를 먼저 평가하지 않으면 낡은 true로 x를 평가한다.
  const C1 = 0;
  const C2 = 1;
  const V = 2;
  const { store, exprs, make } = setup([true, true, 1]);
  const c1 = make(COND_EXPR, C1);
  const c2 = make(COND_EXPR, C2);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.graph.addEdge(c1.exprInstanceIndex, c2.exprInstanceIndex, LABEL_THEN);
  exprs.graph.addEdge(c2.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);
  store.batch(() => {
    store.set(C1, false);
    store.set(C2, false);
    store.set(V, 2);
  });
  store.set(C1, true);
  assert.equal(store.get(c2.resultLeaf), true, "c2는 아직 평가되지 않았다");

  exprs.recountPending(x.exprInstanceIndex);

  assert.equal(store.get(c2.resultLeaf), false, "c2를 먼저 평가한다");
  assert.equal(store.get(x.resultLeaf), 10, "c2가 false라 x를 평가하지 않는다");
});

test("incoming labeled edge가 둘이면 그중 하나만 맞아도 끝점을 평가한다", () => {
  const C1 = 0;
  const C2 = 1;
  const V = 2;
  const { store, exprs, make } = setup([true, true, 1]);
  const c1 = make(COND_EXPR, C1);
  const c2 = make(COND_EXPR, C2);
  const x = make(TIMES_TEN_EXPR, V);
  // c1 아래 가지와 c2 아래 가지가 x를 함께 가진다. 가지마다 refCount 하나와 간선 하나다.
  exprs.retain(x.exprInstanceIndex);
  exprs.graph.addEdge(c1.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);
  exprs.graph.addEdge(c2.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);

  store.batch(() => {
    store.set(C1, false);
    store.set(V, 2);
  });

  assert.equal(store.get(x.resultLeaf), 20);
});

test("조건 없는 가지가 함께 가진 식 인스턴스는 incoming labeled edge의 시작점이 false여도 평가한다", () => {
  // `${x}`가 root와 `@if (c) { ${x} }`에 함께 있는 경우다. refCount는 2, 간선은 @if 가지의 하나다.
  const C = 0;
  const V = 1;
  const { store, exprs, make } = setup([true, 1]);
  const c = make(COND_EXPR, C);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.retain(x.exprInstanceIndex);
  exprs.graph.addEdge(c.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);

  store.batch(() => {
    store.set(C, false);
    store.set(V, 2);
  });

  assert.equal(store.get(x.resultLeaf), 20);
});

test("조건 없는 가지가 식 인스턴스를 놓으면 그다음부터는 incoming labeled edge로 평가 여부를 정한다", () => {
  const C = 0;
  const V = 1;
  const { store, exprs, make } = setup([true, 1]);
  const c = make(COND_EXPR, C);
  const x = make(TIMES_TEN_EXPR, V);
  exprs.retain(x.exprInstanceIndex);
  exprs.graph.addEdge(c.exprInstanceIndex, x.exprInstanceIndex, LABEL_THEN);
  store.batch(() => {
    store.set(C, false);
    store.set(V, 2);
  });
  assert.equal(store.get(x.resultLeaf), 20, "조건 없는 가지가 있어 평가한다");

  exprs.release(x.exprInstanceIndex);
  store.set(V, 3);

  assert.equal(store.get(x.resultLeaf), 20, "남은 가지는 @if 가지뿐이고 c가 false라 평가하지 않는다");
});
