// 가지의 식 인스턴스 - 가지가 식 인스턴스를 싣고 가지와 생애를 함께 한다. 처음 붙을 때 파생 구독을 걸고, 떼면
// 풀고, 다시 붙일 때 걸면서 꺼진 동안 놓친 입력을 따라잡는다.
//
// 규칙: 처음 붙을 때는 build가 방금 현재 값으로 채웠으므로 따라잡지 않는다. 떼어 둔 동안은 입력이 바뀌어도
// 결과 leaf가 바뀌지 않는다. 다시 붙이면 놓친 입력으로 결과 leaf를 맞춘다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator } from "./expr-eval.ts";
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
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입

void mount;

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];

// leaf 0은 조건, 1은 입력 a, 2는 결과. then 가지가 `a * 10` 식 인스턴스 하나(결과 leaf 2)를 싣는다. 결과 leaf는
// 식의 첫 값(10)이 아닌 0으로 시작해, 따라잡았는지를 결과 leaf로 구별한다.
const setup = () => {
  const store = createLeafStoreSubject([true, 1, 0]);
  const exprs = new ExprInstancePool(new ExprEvaluator([], store, new Pool()), store);
  const regionPool: Pool<TRegion> = new Pool();
  const branchPool: Pool<TBranch> = new Pool();
  const regionIndex = appendIfRegion(regionPool, branchPool, 0);
  const region = regionPool.entries[regionIndex];
  document.createElement("div").append(region.anchor);
  const thenBranch = branchPool.entries[region.branchIndices[THEN_INDEX]];
  thenBranch.built = true;
  const exprInstanceIndex = exprs.create(new Uint8Array([...load(0), EXPR_LOAD_SMALL_INT, 10, EXPR_MUL]), [STORE, 1]);
  exprs.evaluate(exprInstanceIndex);
  exprs.bindResultLeaf(exprInstanceIndex, 2); // 가지가 붙을 때까지는 구독이 없는 상태(build 직후)
  addExprInstanceToBranch(thenBranch, exprInstanceIndex);
  const show = () => activateIf(store, exprs, regionPool, branchPool, regionIndex, THEN_INDEX);
  const hide = () => region.detach(store, exprs, regionPool, branchPool, region);
  // detach는 shownIndex를 두므로 다시 붙일 때는 activateIf가 아니라 attach를 부른다(부모 가지가 떼였다 붙는 경우).
  const reshow = () => region.attach(store, exprs, regionPool, branchPool, region);
  return { store, show, hide, reshow };
};

test("처음 붙을 때 파생 구독을 걸고 따라잡지는 않는다", () => {
  const { store, show } = setup();
  show();
  assert.equal(store.get(2), 0, "처음 붙을 때는 따라잡지 않아 결과 leaf가 그대로다");

  store.set(1, 2);
  assert.equal(store.get(2), 20);
});

test("떼면 파생 구독이 해제된다", () => {
  const { store, show, hide } = setup();
  show();
  store.set(1, 2);
  assert.equal(store.get(2), 20, "붙어 있는 동안은 따라간다");

  hide();
  store.set(1, 3);

  assert.equal(store.get(2), 20, "뗀 뒤에는 따라가지 않는다");
});

test("가지를 지우면 가지가 든 식 인스턴스의 결과 leaf를 반납한다", () => {
  const store = createLeafStoreSubject([1, 1, 0, 0]);
  const exprs = new ExprInstancePool(new ExprEvaluator([], store, new Pool()), store);
  const regionPool: Pool<TRegion> = new Pool();
  const branchPool: Pool<TBranch> = new Pool();
  const regionIndex = appendForRegion(regionPool, 0);
  document.createElement("div").append(regionPool.entries[regionIndex].anchor);
  const branchIndex = appendBranchOfForRegion(regionPool, branchPool, regionIndex);
  // 식 인스턴스 하나가 입력 leaf 둘(0, 1)을 읽고 결과 leaf는 2다.
  const exprInstanceIndex = exprs.create(new Uint8Array([...load(0), ...load(1), EXPR_ADD]), [STORE, 0, STORE, 1]);
  exprs.evaluate(exprInstanceIndex);
  exprs.bindResultLeaf(exprInstanceIndex, 2);
  addExprInstanceToBranch(branchPool.entries[branchIndex], exprInstanceIndex);

  removeBranchAt(store, exprs, regionPool, branchPool, regionIndex, 0);

  assert.deepEqual([store.alloc([9]), store.alloc([9])], [2, 4], "2는 한 번만 반납되어 재사용되고 다음은 끝에 붙는다");
});

test("다시 붙이면 떼어 둔 동안 바뀐 입력을 따라잡아 결과 leaf를 맞춘다", () => {
  const { store, show, hide, reshow } = setup();
  show();
  hide();
  store.set(1, 3);

  reshow();

  assert.equal(store.get(2), 30);
});
