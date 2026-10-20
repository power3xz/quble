// 가지의 파생 구독 - 가지가 파생 구독(식 구독 함수)을 싣고 가지와 생애를 함께 한다. 처음 붙을 때 걸고,
// 떼면 해제하고, 다시 붙일 때 걸면서 꺼진 동안 놓친 입력을 따라잡는다.
//
// 규칙: 처음 붙을 때는 build가 방금 현재 값으로 채웠으므로 따라잡지 않는다. 떼어 둔 동안은 입력이 바뀌어도
// 파생 구독이 불리지 않는다. 다시 붙이면 가지가 든 입력 leaf마다 따라잡는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import {
  activateIf,
  addDeriveToBranch,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  removeBranchAt,
  type TBranch,
  THEN_INDEX,
  type TRegion,
} from "./region.ts";
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입

void mount;

// leaf 0은 조건, 1은 입력, 2는 결과. then 가지가 입력 leaf 1에 파생 구독 하나(결과 leaf 2)를 싣는다.
const setup = () => {
  const store = createLeafStoreSubject([true, 1, 0]);
  const regionPool: Pool<TRegion> = new Pool();
  const branchPool: Pool<TBranch> = new Pool();
  const regionIndex = appendIfRegion(regionPool, branchPool, 0);
  const region = regionPool.entries[regionIndex];
  document.createElement("div").append(region.anchor);
  const thenBranch = branchPool.entries[region.branchIndices[THEN_INDEX]];
  thenBranch.built = true;
  const received: Array<readonly number[]> = [];
  const derive = (changedLeaves: ReadonlySet<number>) => {
    received.push([...changedLeaves]);
    return (store.get(1) as number) * 10;
  };
  store.bindDeriveResult(derive, 2); // 가지가 붙을 때까지는 구독이 없는 상태(build 직후)
  thenBranch.deriveInputLeafIndices = [1];
  thenBranch.deriveFns = [derive];
  const show = () => activateIf(store, regionPool, branchPool, regionIndex, THEN_INDEX);
  const hide = () => region.detach(store, regionPool, branchPool, region);
  // detach는 shownIndex를 두므로 다시 붙일 때는 activateIf가 아니라 attach를 부른다(부모 가지가 떼였다 붙는 경우).
  const reshow = () => region.attach(store, regionPool, branchPool, region);
  return { store, received, show, hide, reshow };
};

test("처음 붙을 때 파생 구독을 걸고 따라잡지는 않는다", () => {
  const { store, received, show } = setup();
  show();
  assert.deepEqual(received, [], "처음 붙을 때는 부르지 않는다");

  store.set(1, 2);
  assert.deepEqual(received, [[1]]);
  assert.equal(store.get(2), 20);
});

test("떼면 파생 구독이 해제된다", () => {
  const { store, received, show, hide } = setup();
  show();
  store.set(1, 2);
  assert.deepEqual(received, [[1]], "붙어 있는 동안은 불린다");

  hide();
  received.length = 0;
  store.set(1, 3);

  assert.deepEqual(received, [], "뗀 뒤에는 불리지 않는다");
});

test("가지를 지우면 가지가 든 파생 구독의 결과 leaf를 반납한다", () => {
  const store = createLeafStoreSubject([1, 0, 0, 0]);
  const regionPool: Pool<TRegion> = new Pool();
  const branchPool: Pool<TBranch> = new Pool();
  const regionIndex = appendForRegion(regionPool, 0);
  document.createElement("div").append(regionPool.entries[regionIndex].anchor);
  const branchIndex = appendBranchOfForRegion(regionPool, branchPool, regionIndex);
  const branch = branchPool.entries[branchIndex];
  // 한 파생 구독이 입력 leaf 둘(0, 1)에 걸리고 결과 leaf는 2다. 가지의 목록에는 그 함수가 두 번 나온다.
  const derive = () => 1;
  store.bindDeriveResult(derive, 2);
  addDeriveToBranch(branch, 0, derive);
  addDeriveToBranch(branch, 1, derive);

  removeBranchAt(store, regionPool, branchPool, regionIndex, 0);

  assert.deepEqual([store.alloc([9]), store.alloc([9])], [2, 4], "2는 한 번만 반납되어 재사용되고 다음은 끝에 붙는다");
});

test("다시 붙이면 떼어 둔 동안 바뀐 입력을 따라잡아 결과 leaf를 맞춘다", () => {
  const { store, received, show, hide, reshow } = setup();
  show();
  hide();
  store.set(1, 3);
  received.length = 0;

  reshow();

  assert.deepEqual(received, [[1]]);
  assert.equal(store.get(2), 30);
});
