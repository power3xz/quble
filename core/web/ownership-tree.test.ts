// 소유 트리의 위쪽 간선. 식 인스턴스를 든 가지는 하나면 번호, 둘 이상이면 배열로 두고, 빼서 하나가 남으면 다시
// 번호로 둔다. 남은 가지 수가 0이면 그 인스턴스를 반납할 때다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_PARENT, OwnershipTree } from "./ownership-tree.ts";

test("가지 -> Region, Region -> 부모 가지를 기록한 대로 돌려준다", () => {
  const tree = new OwnershipTree();
  tree.setParentBranchOfRegion(0, NO_PARENT);
  tree.setRegionOfBranch(0, 0);
  tree.setParentBranchOfRegion(1, 0);
  tree.setRegionOfBranch(1, 1);
  tree.setRegionOfBranch(2, 1);

  assert.equal(tree.regionOfBranch(2), 1);
  assert.equal(tree.parentBranchOfRegion(1), 0);
  assert.equal(tree.parentBranchOfRegion(0), NO_PARENT);
});

test("풀이 번호를 재사용하면 새로 기록한 값이 옛 값을 덮는다", () => {
  const tree = new OwnershipTree();
  tree.setRegionOfBranch(3, 1);

  tree.setRegionOfBranch(3, 5);

  assert.equal(tree.regionOfBranch(3), 5);
});

test("든 가지가 하나면 번호, 둘째가 들어오면 배열이다", () => {
  const tree = new OwnershipTree();
  tree.addBranchOfExprInstance(7, 2);
  assert.equal(tree.branchesOfExprInstance(7), 2);

  tree.addBranchOfExprInstance(7, 4);

  assert.deepEqual(tree.branchesOfExprInstance(7), [2, 4]);
});

test("가지를 빼면 남은 수를 돌려주고, 하나가 남으면 번호로 되돌린다", () => {
  const tree = new OwnershipTree();
  tree.addBranchOfExprInstance(7, 2);
  tree.addBranchOfExprInstance(7, 4);
  tree.addBranchOfExprInstance(7, 6);

  assert.equal(tree.removeBranchOfExprInstance(7, 4), 2);
  assert.deepEqual(tree.branchesOfExprInstance(7), [2, 6]);
  assert.equal(tree.removeBranchOfExprInstance(7, 2), 1);
  assert.equal(tree.branchesOfExprInstance(7), 6);
  assert.equal(tree.removeBranchOfExprInstance(7, 6), 0);
});

test("마지막 가지를 뺀 번호에 새 인스턴스가 들어오면 그 가지 하나만 든다", () => {
  const tree = new OwnershipTree();
  tree.addBranchOfExprInstance(7, 2);
  tree.removeBranchOfExprInstance(7, 2);

  tree.addBranchOfExprInstance(7, 9);

  assert.equal(tree.branchesOfExprInstance(7), 9);
});

test("clear하면 기록이 모두 사라진다", () => {
  const tree = new OwnershipTree();
  tree.addBranchOfExprInstance(7, 2);
  tree.setRegionOfBranch(2, 1);

  tree.clear();
  tree.addBranchOfExprInstance(7, 3);

  assert.equal(tree.branchesOfExprInstance(7), 3, "옛 가지 2가 남아 배열이 되지 않는다");
  assert.equal(tree.regionOfBranch(2), undefined);
});
