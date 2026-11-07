// 가지의 식 인스턴스 - 가지가 식 인스턴스를 싣고 가지와 생애를 함께 한다. 파생 구독은 식 인스턴스를 만들 때 걸고
// 반납할 때 푼다. 가지를 떼고 붙여도 파생 구독은 그대로다.
//
// 규칙: 처음 붙을 때는 build가 방금 현재 값으로 채웠으므로 세지 않는다. 쉬는 동안은 입력이 바뀌어도 결과 leaf가
// 바뀌지 않는다. 다시 붙이면 쉬는 동안 바뀐 입력으로 결과 leaf를 맞춘다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator } from "./expr-eval.ts";
import { LABEL_THEN } from "./expr-graph.ts";
import { ExprInstancePool } from "./expr-layer.ts";
import { EXPR_ADD, EXPR_LOAD_SMALL_INT, EXPR_LOAD_VAR, EXPR_MUL } from "./expr-opcode.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import {
  activateIf,
  addExprInstanceToBranch,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  removeBranchAt,
  type TBranch,
  THEN_INDEX,
  type TRegion,
} from "./region.ts";
import { STORE } from "./scope.ts";
import type { TScopeParentPool } from "./scope-uid.ts";
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입

void mount;

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];
// 이 파일의 식 인스턴스는 모두 scope 하나(root)에 있다.
const SCOPE_UID = 0;

// leaf 0은 조건, 1은 입력 a, 2는 `a * 10`의 결과, 3은 조건 식 인스턴스의 결과다. then 가지가 `a * 10` 식 인스턴스
// 하나를 싣고, 조건 식 인스턴스에서 label then 간선을 받는다(vm의 addExprInstance가 거는 것과 같다). 결과 leaf 2는
// 식의 첫 값(10)이 아닌 0으로 시작해, 식을 다시 셌는지를 결과 leaf로 구별한다.
const setup = () => {
  const store = createLeafStoreSubject([true, 1, 0, true]);
  const timesTen = new Uint8Array([...load(0), EXPR_LOAD_SMALL_INT, 10, EXPR_MUL]);
  const exprBytes = [timesTen, new Uint8Array(load(0))];
  const exprs = new ExprInstancePool(new ExprEvaluator([], exprBytes, store, new Pool()), store);
  const regionPool: Pool<TRegion> = new Pool();
  const branchPool: Pool<TBranch> = new Pool();
  const regionIndex = appendIfRegion(regionPool, branchPool, 0);
  const region = regionPool.entries[regionIndex];
  document.createElement("div").append(region.anchor);
  const cond = exprs.create(1, [STORE, 0], SCOPE_UID);
  exprs.retainByBranch(cond);
  exprs.evaluate(cond);
  exprs.bindResultLeaf(cond, 3);
  exprs.subscribeInputs(cond);
  const thenBranch = branchPool.entries[region.branchIndices[THEN_INDEX]];
  thenBranch.built = true;
  thenBranch.edgeStartNode = cond;
  thenBranch.edgeLabel = LABEL_THEN;
  const exprInstanceIndex = exprs.create(0, [STORE, 1], SCOPE_UID);
  exprs.retainByBranch(exprInstanceIndex);
  exprs.evaluate(exprInstanceIndex);
  exprs.bindResultLeaf(exprInstanceIndex, 2);
  exprs.subscribeInputs(exprInstanceIndex);
  addExprInstanceToBranch(thenBranch, exprInstanceIndex);
  exprs.graph.addEdge(cond, exprInstanceIndex, LABEL_THEN);
  const show = () => activateIf(store, exprs, regionPool, branchPool, regionIndex, THEN_INDEX);
  // 조건을 false로 바꾸고 가지를 뗀다. 테스트에는 조건 leaf를 구독해 가지를 바꾸는 region 구독이 없어 직접 뗀다.
  const hide = () => {
    store.set(0, false);
    region.detach(store, regionPool, branchPool, region);
  };
  // detach는 shownIndex를 두므로 다시 붙일 때는 activateIf가 아니라 attach를 부른다(부모 가지가 떼였다 붙는 경우).
  const reshow = () => {
    store.set(0, true);
    region.attach(store, exprs, regionPool, branchPool, region);
  };
  // `a * 10`을 센 횟수. 조건 식은 세지 않는다.
  const timesTenRuns = () => {
    const { runExpr } = exprs.evaluator;
    let runs = 0;
    exprs.evaluator.runExpr = (...args) => {
      if (args[0] === timesTen) {
        runs++;
      }
      return runExpr(...args);
    };
    return () => runs;
  };
  return { store, exprs, exprInstanceIndex, show, hide, reshow, timesTenRuns };
};

test("처음 붙을 때는 식을 다시 세지 않는다", () => {
  const { store, show } = setup();
  show();
  assert.equal(store.get(2), 0, "결과 leaf가 그대로다");

  store.set(1, 2);
  assert.equal(store.get(2), 20);
});

test("떼어도 파생 구독은 남는다", () => {
  const { exprs, exprInstanceIndex, show, hide } = setup();
  show();

  hide();

  assert.equal(exprs.deriveSubscribers[1], exprInstanceIndex);
});

test("가지를 지우면 가지가 든 식 인스턴스의 결과 leaf를 반납한다", () => {
  const store = createLeafStoreSubject([1, 1, 0, 0]);
  const exprBytes = [new Uint8Array([...load(0), ...load(1), EXPR_ADD])];
  const exprs = new ExprInstancePool(new ExprEvaluator([], exprBytes, store, new Pool()), store);
  const regionPool: Pool<TRegion> = new Pool();
  const branchPool: Pool<TBranch> = new Pool();
  const scopeParentPool: TScopeParentPool = new Pool<number>();
  const regionIndex = appendForRegion(regionPool, 0);
  document.createElement("div").append(regionPool.entries[regionIndex].anchor);
  const branchIndex = appendBranchOfForRegion(regionPool, branchPool, regionIndex);
  // 식 인스턴스 하나가 입력 leaf 둘(0, 1)을 읽고 결과 leaf는 2다.
  const exprInstanceIndex = exprs.create(0, [STORE, 0, STORE, 1], SCOPE_UID);
  exprs.retainByBranch(exprInstanceIndex);
  exprs.evaluate(exprInstanceIndex);
  exprs.bindResultLeaf(exprInstanceIndex, 2);
  addExprInstanceToBranch(branchPool.entries[branchIndex], exprInstanceIndex);

  removeBranchAt(store, exprs, scopeParentPool, regionPool, branchPool, regionIndex, 0);

  assert.deepEqual([store.alloc([9]), store.alloc([9])], [2, 4], "2는 한 번만 반납되어 재사용되고 다음은 끝에 붙는다");
});

test("쉬는 동안은 입력이 바뀌어도 세지 않고, 다시 붙이면 바뀐 입력으로 한 번 세어 결과 leaf를 맞춘다", () => {
  const { store, show, hide, reshow, timesTenRuns } = setup();
  show();
  hide();
  const runs = timesTenRuns();
  store.set(1, 2);
  store.set(1, 3);
  assert.equal(runs(), 0, "쉬는 동안은 세지 않는다");

  reshow();

  assert.equal(runs(), 1);
  assert.equal(store.get(2), 30);
});

test("쉬는 동안 입력이 바뀌지 않았으면 다시 붙여도 식을 세지 않는다", () => {
  const { show, hide, reshow, timesTenRuns } = setup();
  show();
  hide();
  const runs = timesTenRuns();

  reshow();

  assert.equal(runs(), 0);
});
