// 식 인스턴스 풀 - 식을 처음 세고, 입력 leaf에 파생 구독을 걸어 반납할 때까지 둔다. 쉬는 동안(조건이 맞지 않아 pull이
// 평가하지 않는 동안) 바뀐 입력은 pendingVarMask에 모였다가 recountPending이 센다. 인스턴스는 참조 수가 0이 되면
// 구독과 결과 leaf와 풀 번호를 반납한다.
//
// 식 바이트와 스코프를 직접 지어 풀만 검증한다(컴파일러 없이).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator } from "./expr-eval.ts";
import { LABEL_THEN } from "./expr-graph.ts";
import { ExprInstancePool, NOT_SHARED } from "./expr-layer.ts";
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

// exprBytes[globalExprIndex]가 식 바이트다. build는 픽스처의 식을 0번, leaf 하나를 그대로 읽는 조건을 1번에 둔다.
const COND_EXPR = 1;
// 이 파일의 식 인스턴스는 모두 scope 하나(root)에 있다.
const SCOPE_UID = 0;
const poolOf = (store: ReturnType<typeof createLeafStoreSubject>, exprBytes: Uint8Array[]) =>
  new ExprInstancePool(new ExprEvaluator([], exprBytes, store, new Pool()), store);

// 식 인스턴스를 만들어 가지 하나가 든 것처럼 retainByBranch하고, 처음 센 뒤 결과 leaf에 그 값을 넣고 연결한다(VM의
// addExprInstance, allocResultLeaf와 같다). 구독은 걸지 않은 상태다.
const build = (fixture: ReturnType<typeof sum>) => {
  const pool = poolOf(fixture.store, [fixture.expr, new Uint8Array(load(0))]);
  const exprInstanceIndex = pool.create(0, fixture.pairs, SCOPE_UID);
  pool.retainByBranch(exprInstanceIndex);
  const value = pool.evaluate(exprInstanceIndex);
  fixture.store.write(fixture.resultLeafIndex, value);
  pool.bindResultLeaf(exprInstanceIndex, fixture.resultLeafIndex);
  return { pool, exprInstanceIndex, value, store: fixture.store };
};

// 식 인스턴스를 false인 조건 아래 가지에 실린 것처럼 쉬게 한다. 새 leaf를 읽는 조건 식 인스턴스에서 label then
// 간선을 걸어, flush의 pull이 그 식 인스턴스를 평가하지 않는다. 조건을 true로 되돌리는 함수를 돌려준다 - 본문이
// 다시 붙어 recountPending을 호출하는 때가 조건이 true가 된 뒤다.
const rest = (
  pool: ExprInstancePool,
  store: ReturnType<typeof createLeafStoreSubject>,
  exprInstanceIndex: number,
): (() => void) => {
  const condLeaf = store.alloc([false]);
  const cond = pool.create(COND_EXPR, [STORE, condLeaf], SCOPE_UID);
  pool.retainByBranch(cond);
  pool.evaluate(cond);
  pool.subscribeInputs(cond);
  pool.graph.addEdge(cond, exprInstanceIndex, LABEL_THEN);
  return () => store.set(condLeaf, true);
};

test("create는 가지도 식도 붙들지 않은 인스턴스를 만든다", () => {
  const fixture = sum();
  const pool = poolOf(fixture.store, [fixture.expr]);
  const instance = pool.pool.entries[pool.create(0, fixture.pairs, SCOPE_UID)];
  assert.equal(instance.heldByBranchCount, 0);
  assert.equal(instance.readByExprCount, 0);
  assert.equal(instance.scopeUid, SCOPE_UID);
});

test("evaluate는 식을 세되 구독은 걸지 않는다", () => {
  const { value, store } = build(sum());
  assert.equal(value, 3);

  store.set(0, 10);

  assert.equal(store.get(2), 3, "subscribeInputs 전에는 결과 leaf에 쓰지 않는다");
});

test("evaluate를 여러 번 불러도 같은 값을 주고 구독 대상이 늘지 않는다", () => {
  const { pool, exprInstanceIndex } = build(sum());
  assert.equal(pool.evaluate(exprInstanceIndex), 3);
  assert.equal(pool.evaluate(exprInstanceIndex), 3);

  pool.subscribeInputs(exprInstanceIndex);

  assert.deepEqual(pool.pool.entries[exprInstanceIndex].readLeaves, [0, 1]);
  assert.equal(pool.deriveSubscribers[0], exprInstanceIndex, "leaf 0의 슬롯이 Set으로 바뀌지 않는다");
});

test("subscribeInputs하면 입력이 바뀔 때 결과 leaf에 쓴다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);

  store.set(0, 10);

  assert.equal(store.get(2), 12);
});

test("쉬는 식 인스턴스는 입력이 바뀌어도 세지 않고 바뀐 변수의 비트를 pendingVarMask에 모은다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);
  rest(pool, store, exprInstanceIndex);

  store.set(0, 10);
  assert.equal(store.get(2), 3, "세지 않는다");
  assert.equal(pool.pool.entries[exprInstanceIndex].pendingVarMask, 0b01);

  store.set(1, 20);
  assert.equal(store.get(2), 3);
  assert.equal(pool.pool.entries[exprInstanceIndex].pendingVarMask, 0b11, "다음 flush에 바뀐 변수의 비트가 더해진다");
});

test("pendingVarMask가 이미 0이 아닌 식 인스턴스는 push가 다시 셀 목록에 넣지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);
  rest(pool, store, exprInstanceIndex);
  // pull은 목록에 든 식 인스턴스마다 incoming edge를 본다. 그 횟수로 목록에 들었는지 본다.
  const { incomingEdgesOfNode } = pool.graph;
  let looks = 0;
  pool.graph.incomingEdgesOfNode = (node) => {
    if (node === exprInstanceIndex) {
      looks++;
    }
    return incomingEdgesOfNode(node);
  };
  store.set(0, 10);
  assert.notEqual(looks, 0, "마스크가 0이던 첫 flush에는 목록에 든다");
  const looksAfterFirstFlush = looks;

  store.set(0, 11);

  assert.equal(looks, looksAfterFirstFlush);
});

test("recountPending은 pendingVarMask가 0이면 식을 세지 않는다", () => {
  const { pool, exprInstanceIndex } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  pool.recountPending(exprInstanceIndex);

  assert.equal(runs, 0, "입력이 바뀌지 않아 결과 leaf가 최신이다");
});

test("recountPending은 쉬는 동안 바뀐 입력으로 세어 결과 leaf에 쓰고 통지한다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);
  const wake = rest(pool, store, exprInstanceIndex);
  store.set(0, 10);
  wake();
  assert.equal(store.get(2), 3, "조건이 true가 되어도 push가 다시 셀 목록에 넣지 않는다");
  const notified: unknown[] = [];
  store.subscribe(2, (value) => notified.push(value));

  pool.recountPending(exprInstanceIndex);

  assert.equal(store.get(2), 12);
  assert.deepEqual(notified, [12]);
  assert.equal(pool.pool.entries[exprInstanceIndex].pendingVarMask, 0, "세고 마스크를 지운다");
});

test("release는 heldByBranchCount가 0이 될 때 결과 leaf와 풀 번호를 반납한다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.retainByBranch(exprInstanceIndex);

  pool.releaseByBranch(exprInstanceIndex);
  assert.equal(pool.pool.entries[exprInstanceIndex].heldByBranchCount, 1, "하나 남았으니 살아 있다");
  assert.deepEqual(pool.pool.free, []);

  pool.releaseByBranch(exprInstanceIndex);
  assert.deepEqual(pool.pool.free, [exprInstanceIndex], "풀 번호가 반납된다");
  assert.equal(store.alloc([9]), 2, "결과 leaf가 반납되어 다시 쓰인다");
});

test("구독을 건 채로 release해도 구독이 풀려 반납된 결과 leaf를 건드리지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);

  pool.releaseByBranch(exprInstanceIndex);
  const reused = store.alloc([99]);
  assert.equal(reused, 2);
  store.set(0, 10);

  assert.equal(store.get(reused), 99);
});

test("가지가 놓아도 식이 읽고 있으면 반납하지 않는다", () => {
  const { pool, exprInstanceIndex } = build(sum());
  pool.retainByExpr(exprInstanceIndex);

  pool.releaseByBranch(exprInstanceIndex);

  assert.deepEqual(pool.pool.free, []);
});

test("식이 놓아도 가지가 들고 있으면 반납하지 않는다", () => {
  const { pool, exprInstanceIndex } = build(sum());
  pool.retainByExpr(exprInstanceIndex);

  pool.releaseByExpr(exprInstanceIndex);

  assert.deepEqual(pool.pool.free, []);
});

test("가지와 식이 모두 놓으면 결과 leaf와 풀 번호를 반납한다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.retainByExpr(exprInstanceIndex);

  pool.releaseByBranch(exprInstanceIndex);
  pool.releaseByExpr(exprInstanceIndex);

  assert.deepEqual(pool.pool.free, [exprInstanceIndex]);
  assert.equal(store.alloc([9]), 2, "결과 leaf가 반납되어 다시 쓰인다");
});

// 같은 풀에서 식 0의 인스턴스 둘을 scope 7과 8에 만든다(공유 조회는 풀 하나 안에서 이뤄진다). 식 1은 식 0과 바이트가
// 같은 다른 식이다. 구독은 걸지 않는다.
const buildTwo = () => {
  const fixture = sum();
  const pool = poolOf(fixture.store, [fixture.expr, fixture.expr]);
  const first = pool.create(0, fixture.pairs, 7);
  const second = pool.create(0, fixture.pairs, 8);
  pool.retainByBranch(first);
  pool.retainByBranch(second);
  return { pool, first, second, fixture };
};

test("findShared는 올리지 않은 키에는 NOT_SHARED를 돌려준다", () => {
  const { pool } = buildTwo();
  assert.equal(pool.findShared(0, 7), NOT_SHARED);
});

test("markShared는 인스턴스의 (globalExprIndex, scopeUid)로 올리고 그 키로만 찾아진다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first);

  assert.equal(pool.findShared(0, 7), first);
  assert.equal(pool.findShared(0, 8), NOT_SHARED, "scopeUid가 다르면 다른 스코프의 식이다");
  assert.equal(pool.findShared(1, 7), NOT_SHARED, "globalExprIndex가 다르면 같은 스코프의 다른 식이다");
});

test("공유한 식 인스턴스는 참조 수가 0이 될 때 공유 맵에서 빠진다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first);
  pool.retainByBranch(first);

  pool.releaseByBranch(first);
  assert.equal(pool.findShared(0, 7), first, "참조가 하나 남았으니 계속 찾아진다");

  pool.releaseByBranch(first);
  assert.equal(pool.findShared(0, 7), NOT_SHARED);
});

test("반납한 풀 번호를 새 식 인스턴스가 다시 써도 옛 키로 찾아지지 않는다", () => {
  const { pool, first, fixture } = buildTwo();
  pool.markShared(first);
  pool.releaseByBranch(first);

  const reused = pool.create(0, fixture.pairs, 7);

  assert.equal(reused, first, "풀 번호가 재사용된다");
  assert.equal(pool.findShared(0, 7), NOT_SHARED);
});

test("공유한 식 인스턴스 하나를 반납해도 다른 키의 식 인스턴스는 그대로 찾아진다", () => {
  const { pool, first, second } = buildTwo();
  pool.markShared(first);
  pool.markShared(second);

  pool.releaseByBranch(first);

  assert.equal(pool.findShared(0, 7), NOT_SHARED);
  assert.equal(pool.findShared(0, 8), second);
});

// 같은 식을 @for 안(공유)과 밖(공유 안 함)에서 쓰면 두 인스턴스의 (globalExprIndex, scopeUid)가 같다.
test("공유 맵 키가 같아도 공유하지 않은 인스턴스를 반납하면 공유한 인스턴스는 그대로 찾아진다", () => {
  const { pool, first, fixture } = buildTwo();
  pool.markShared(first);
  const unshared = pool.create(0, fixture.pairs, 7);
  pool.retainByBranch(unshared);

  pool.releaseByBranch(unshared);

  assert.equal(pool.findShared(0, 7), first);
});

test("clear하면 공유 맵도 비운다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first);

  pool.clear();

  assert.equal(pool.findShared(0, 7), NOT_SHARED);
});

test("건너뛸 부분식이 없는 식은 쉬는 동안 입력 leaf 여럿이 바뀌어도 recountPending이 식을 한 번만 센다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.subscribeInputs(exprInstanceIndex);
  const wake = rest(pool, store, exprInstanceIndex);
  store.set(0, 10);
  store.set(1, 20);
  wake();
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  pool.recountPending(exprInstanceIndex);

  assert.equal(runs, 1, "a + b는 바뀐 leaf를 보지 않아 한 번이면 된다");
  assert.equal(store.get(2), 30);
});

test("resultLeafOf는 결과 leaf를 연결하기 전에는 undefined, 연결한 뒤에는 그 leaf를 돌려준다", () => {
  const { pool, first } = buildTwo();
  assert.equal(pool.resultLeafOf(first), undefined);

  pool.bindResultLeaf(first, 2);

  assert.equal(pool.resultLeafOf(first), 2);
});

test("쉬는 동안 입력 여럿이 바뀌면 recountPending이 식을 한 번 세고 맞는 값만 통지한다", () => {
  const { pool, exprInstanceIndex, store } = build(product());
  pool.subscribeInputs(exprInstanceIndex);
  const wake = rest(pool, store, exprInstanceIndex);
  store.set(0, 4);
  store.set(2, 7);
  wake();
  const { reevalExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.reevalExpr = (...args) => {
    runs++;
    return reevalExpr(...args);
  };
  const notified: unknown[] = [];
  store.subscribe(4, (value) => notified.push(value));

  pool.recountPending(exprInstanceIndex);

  assert.equal(runs, 1, "a와 c를 함께 바뀐 변수로 넘겨 한 번에 센다");
  assert.deepEqual(notified, [24], "(4 + 2) * (7 - 3)만 통지한다 - a만 반영한 중간 값이 나가지 않는다");
});

// a + b 인스턴스 둘을 같은 풀에서 만들고 구독을 건다. 첫째는 결과 leaf 2, 둘째는 결과 leaf 3에 쓴다. 둘 다 a, b를
// 읽어 leaf 0과 1의 파생 구독 슬롯이 Set이 된다.
const buildTwoSubscribed = () => {
  const store = createLeafStoreSubject([1, 2, 0, 0]);
  const pool = poolOf(store, [new Uint8Array([...load(0), ...load(1), EXPR_ADD])]);
  const pairs = [STORE, 0, STORE, 1];
  const instances = [2, 3].map((resultLeafIndex) => {
    const exprInstanceIndex = pool.create(0, pairs, SCOPE_UID);
    pool.retainByBranch(exprInstanceIndex);
    store.write(resultLeafIndex, pool.evaluate(exprInstanceIndex));
    pool.bindResultLeaf(exprInstanceIndex, resultLeafIndex);
    pool.subscribeInputs(exprInstanceIndex);
    return exprInstanceIndex;
  });
  return { store, pool, first: instances[0], second: instances[1] };
};

test("같은 leaf를 읽는 인스턴스 둘 중 하나를 release하면 나머지만 센다", () => {
  const { store, pool, first } = buildTwoSubscribed();
  pool.releaseByBranch(first);
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  store.set(0, 10);

  assert.equal(runs, 1, "반납한 첫째는 세지 않는다");
  assert.equal(store.get(3), 12);
});

test("batch에서 인스턴스가 읽는 leaf 둘이 함께 바뀌어도 인스턴스마다 한 번 센다", () => {
  const { store, pool } = buildTwoSubscribed();
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  store.batch(() => {
    store.set(0, 10);
    store.set(1, 20);
  });

  assert.equal(runs, 2, "인스턴스 둘이 a, b 두 leaf에 걸려 있지만 각자 한 번");
  assert.deepEqual([store.get(2), store.get(3)], [30, 30]);
});

test("인스턴스 하나가 던져도 나머지 인스턴스는 세고 통지는 모두 나간 뒤 첫 예외가 올라간다", () => {
  const { store, pool } = buildTwoSubscribed();
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    if (runs === 1) {
      throw new Error("첫 식 오류");
    }
    return runExpr(...args);
  };
  const notified: number[] = [];
  store.subscribe(0, (_, leafIndex) => notified.push(leafIndex));
  store.subscribe(3, (_, leafIndex) => notified.push(leafIndex));

  assert.throws(() => store.set(0, 10), /첫 식 오류/);

  assert.equal(store.get(3), 12, "둘째는 센다");
  assert.deepEqual(notified, [0, 3]);
});

test("건너뛸 부분식이 있는 식도 같은 규칙으로 구독하고 recountPending이 센다", () => {
  const fixture = product();
  const { pool, exprInstanceIndex, value, store } = build(fixture);
  assert.notEqual(pool.evaluator.skipTable(0), null, "부분식 표가 있는 식이다");
  assert.equal(value, 6);
  pool.subscribeInputs(exprInstanceIndex);

  store.set(2, 7);
  assert.equal(store.get(4), 12, "c가 바뀌면 (a + b)는 건너뛰고 (c - d)만 다시 센다");

  const wake = rest(pool, store, exprInstanceIndex);
  store.set(0, 4);
  assert.equal(store.get(4), 12, "쉬는 동안은 세지 않는다");
  wake();
  pool.recountPending(exprInstanceIndex);
  assert.equal(store.get(4), 24, "쉬는 동안 a가 바뀐 것을 센다");
});
