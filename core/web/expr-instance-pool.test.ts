// 식 인스턴스 풀 - 식을 처음 세고, 가지가 붙을 때 입력 leaf에 파생 구독을 걸고 뗄 때 풀며, 구독이 풀렸다가 다시
// 걸릴 때 그동안 놓친 입력을 따라잡는다. release하면 구독과 결과 leaf와 풀 번호를 반납한다. 언제 release할지(인스턴스를
// 든 가지가 더 없을 때)는 소유 트리가 정한다(ownership-tree.test.ts, ownership-tree-sync.test.ts).
//
// 식 바이트와 스코프를 직접 지어 풀만 검증한다(컴파일러 없이).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator } from "./expr-eval.ts";
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

// exprBytes[globalExprIndex]가 식 바이트다. 이 테스트의 픽스처는 식이 하나라 globalExprIndex가 0이다.
const poolOf = (store: ReturnType<typeof createLeafStoreSubject>, exprBytes: Uint8Array[]) =>
  new ExprInstancePool(new ExprEvaluator([], exprBytes, store, new Pool()), store);

// 식 인스턴스를 짓고 처음 센 뒤 결과 leaf에 그 값을 넣고 연결한다(VM의 allocResultLeaf와 같다). 구독은 걸지
// 않은 상태다(가지가 붙기 전).
const build = (fixture: ReturnType<typeof sum>) => {
  const pool = poolOf(fixture.store, [fixture.expr]);
  const exprInstanceIndex = pool.create(0, fixture.pairs);
  const value = pool.evaluate(exprInstanceIndex);
  fixture.store.write(fixture.resultLeafIndex, value);
  pool.bindResultLeaf(exprInstanceIndex, fixture.resultLeafIndex);
  return { pool, exprInstanceIndex, value, store: fixture.store };
};

test("evaluate는 식을 세되 구독은 걸지 않는다", () => {
  const { value, store } = build(sum());
  assert.equal(value, 3);

  store.set(0, 10);

  assert.equal(store.get(2), 3, "attach 전에는 결과 leaf에 쓰지 않는다");
});

test("evaluate를 여러 번 불러도 같은 값을 주고 구독 대상이 늘지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  assert.equal(pool.evaluate(exprInstanceIndex), 3);
  assert.equal(pool.evaluate(exprInstanceIndex), 3);
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);

  store.set(0, 10);

  assert.equal(store.get(2), 3, "detach 한 번으로 모든 구독이 풀린다");
});

test("attach하면 입력이 바뀔 때 결과 leaf에 쓴다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);

  store.set(0, 10);

  assert.equal(store.get(2), 12);
});

test("detach하면 입력이 바뀌어도 결과 leaf에 쓰지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);

  store.set(0, 10);

  assert.equal(store.get(2), 3);
});

test("처음 붙을 때는 따라잡지 않는다", () => {
  const { pool, exprInstanceIndex } = build(sum());
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  pool.attach(exprInstanceIndex);

  assert.equal(runs, 0, "evaluate가 방금 센 값이 최신이라 식을 다시 세지 않는다");
});

test("떼어 둔 동안 바뀐 입력은 다시 붙을 때 따라잡는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);
  store.set(0, 10);

  pool.attach(exprInstanceIndex);

  assert.equal(store.get(2), 12);
});

test("이미 붙은 인스턴스에 가지가 더 붙으면 따라잡지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);
  pool.attach(exprInstanceIndex);
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  pool.attach(exprInstanceIndex);

  assert.equal(runs, 0, "구독 중이라 결과 leaf가 최신이다");
  assert.equal(store.get(2), 3);
});

test("release는 결과 leaf와 풀 번호를 반납한다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);

  pool.release(exprInstanceIndex);
  assert.deepEqual(pool.pool.free, [exprInstanceIndex], "풀 번호가 반납된다");
  assert.equal(store.alloc([9]), 2, "결과 leaf가 반납되어 다시 쓰인다");
});

test("붙은 채로 release해도 구독이 풀려 반납된 결과 leaf를 건드리지 않는다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);

  pool.release(exprInstanceIndex);
  const reused = store.alloc([99]);
  assert.equal(reused, 2);
  store.set(0, 10);

  assert.equal(store.get(reused), 99);
});

// 같은 풀에서 식 인스턴스 둘을 만든다(공유 조회는 풀 하나 안에서 이뤄진다). 구독은 걸지 않는다.
const buildTwo = () => {
  const fixture = sum();
  const pool = poolOf(fixture.store, [fixture.expr]);
  const first = pool.create(0, fixture.pairs);
  const second = pool.create(0, fixture.pairs);
  return { pool, first, second };
};

test("findShared는 올리지 않은 키에는 NOT_SHARED를 돌려준다", () => {
  const { pool } = buildTwo();
  assert.equal(pool.findShared(0, 7), NOT_SHARED);
});

test("markShared로 올린 (globalExprIndex, scopeUid)로만 그 식 인스턴스가 찾아진다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first, 3, 7);

  assert.equal(pool.findShared(3, 7), first);
  assert.equal(pool.findShared(3, 8), NOT_SHARED, "scopeUid가 다르면 다른 스코프의 식이다");
  assert.equal(pool.findShared(4, 7), NOT_SHARED, "globalExprIndex가 다르면 같은 스코프의 다른 식이다");
});

test("공유한 식 인스턴스는 release하면 공유 맵에서 빠진다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first, 3, 7);

  pool.release(first);

  assert.equal(pool.findShared(3, 7), NOT_SHARED);
});

test("반납한 풀 번호를 새 식 인스턴스가 다시 써도 옛 키로 찾아지지 않는다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first, 3, 7);
  pool.release(first);

  const fixture = sum();
  const reused = pool.create(0, fixture.pairs);

  assert.equal(reused, first, "풀 번호가 재사용된다");
  assert.equal(pool.findShared(3, 7), NOT_SHARED);
});

test("공유한 식 인스턴스 하나를 반납해도 다른 키의 식 인스턴스는 그대로 찾아진다", () => {
  const { pool, first, second } = buildTwo();
  pool.markShared(first, 3, 7);
  pool.markShared(second, 3, 8);

  pool.release(first);

  assert.equal(pool.findShared(3, 7), NOT_SHARED);
  assert.equal(pool.findShared(3, 8), second);
});

test("clear하면 공유 맵도 비운다", () => {
  const { pool, first } = buildTwo();
  pool.markShared(first, 3, 7);

  pool.clear();

  assert.equal(pool.findShared(3, 7), NOT_SHARED);
});

test("건너뛸 부분식이 없는 식은 따라잡을 때 입력 leaf가 여럿이어도 식을 한 번만 센다", () => {
  const { pool, exprInstanceIndex, store } = build(sum());
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);
  store.set(0, 10);
  const { runExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.runExpr = (...args) => {
    runs++;
    return runExpr(...args);
  };

  pool.attach(exprInstanceIndex);

  assert.equal(runs, 1, "a + b는 입력 leaf가 둘이지만 바뀐 leaf를 보지 않아 한 번이면 된다");
  assert.equal(store.get(2), 12);
});

test("resultLeafOf는 결과 leaf를 연결하기 전에는 undefined, 연결한 뒤에는 그 leaf를 돌려준다", () => {
  const { pool, first } = buildTwo();
  assert.equal(pool.resultLeafOf(first), undefined);

  pool.bindResultLeaf(first, 2);

  assert.equal(pool.resultLeafOf(first), 2);
});

test("떼어 둔 동안 입력 여럿이 바뀌면 따라잡을 때 식을 한 번 세고 맞는 값만 통지한다", () => {
  const { pool, exprInstanceIndex, store } = build(product());
  pool.attach(exprInstanceIndex);
  pool.detach(exprInstanceIndex);
  store.set(0, 4);
  store.set(2, 7);
  const { reevalExpr } = pool.evaluator;
  let runs = 0;
  pool.evaluator.reevalExpr = (...args) => {
    runs++;
    return reevalExpr(...args);
  };
  const notified: unknown[] = [];
  store.subscribe(4, (value) => notified.push(value));

  pool.attach(exprInstanceIndex);

  assert.equal(runs, 1, "a와 c를 함께 바뀐 변수로 넘겨 한 번에 센다");
  assert.deepEqual(notified, [24], "(4 + 2) * (7 - 3)만 통지한다 - a만 반영한 중간 값이 나가지 않는다");
});

// a + b 인스턴스 둘을 같은 풀에서 짓는다. 첫째는 결과 leaf 2, 둘째는 결과 leaf 3에 쓴다. 둘 다 a, b를 읽어 leaf
// 0과 1의 파생 구독 슬롯이 Set이 된다.
const buildTwoAttached = () => {
  const store = createLeafStoreSubject([1, 2, 0, 0]);
  const pool = poolOf(store, [new Uint8Array([...load(0), ...load(1), EXPR_ADD])]);
  const pairs = [STORE, 0, STORE, 1];
  const instances = [2, 3].map((resultLeafIndex) => {
    const exprInstanceIndex = pool.create(0, pairs);
    store.write(resultLeafIndex, pool.evaluate(exprInstanceIndex));
    pool.bindResultLeaf(exprInstanceIndex, resultLeafIndex);
    pool.attach(exprInstanceIndex);
    return exprInstanceIndex;
  });
  return { store, pool, first: instances[0], second: instances[1] };
};

test("같은 leaf를 읽는 인스턴스 둘 중 하나를 떼면 나머지만 센다", () => {
  const { store, pool, first } = buildTwoAttached();

  pool.detach(first);
  store.set(0, 10);

  assert.deepEqual([store.get(2), store.get(3)], [3, 12], "뗀 첫째의 결과 leaf는 그대로다");
});

test("batch에서 인스턴스가 읽는 leaf 둘이 함께 바뀌어도 인스턴스마다 한 번 센다", () => {
  const { store, pool } = buildTwoAttached();
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
  const { store, pool } = buildTwoAttached();
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

test("건너뛸 부분식이 있는 식도 같은 규칙으로 구독하고 따라잡는다", () => {
  const fixture = product();
  const { pool, exprInstanceIndex, value, store } = build(fixture);
  assert.notEqual(pool.evaluator.skipTable(0), null, "부분식 표가 있는 식이다");
  assert.equal(value, 6);
  pool.attach(exprInstanceIndex);

  store.set(2, 7);
  assert.equal(store.get(4), 12, "c가 바뀌면 (a + b)는 건너뛰고 (c - d)만 다시 센다");

  pool.detach(exprInstanceIndex);
  store.set(0, 4);
  pool.attach(exprInstanceIndex);
  assert.equal(store.get(4), 24, "떼어 둔 동안 a가 바뀐 것을 따라잡는다");
});
