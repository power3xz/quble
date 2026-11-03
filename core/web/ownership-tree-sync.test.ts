// 소유 트리의 위쪽 간선(ownership-tree.ts)이 Region과 가지가 든 아래쪽 간선과 늘 맞는지 본다. 가지를 만들고
// 고르고 지우는 모든 경로에서 둘을 함께 고쳐야 하므로, 경로마다 지난 뒤 살아 있는 가지, Region, 식 인스턴스 전부를
// 맞춰 본다.
//
// 픽스처(ownership_tree):
//   @for (i of n) { @if (i < limit) { ${i * rate} } @else { ${rate + 1} } }   개수 @for, IF_EXPR 조건, lazy build
//   @for (row of rows) { @if (row > limit) { ${rate * 2} } }                  배열 @for, removeAt
// rate + 1과 rate * 2는 props만 읽어 행마다 같은 인스턴스를 공유한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NO_PARENT } from "./ownership-tree.ts";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("ownership_tree");
});

const instantiate = (delQueue: number[] = []) => {
  const handlers: THandlers = {
    DEL: (_d, ctx) => {
      const removeAt = ctx.removeAt as (array: number, index: number) => void;
      const props = ctx.props as Record<string, number>;
      const index = delQueue.shift();
      if (index !== undefined) {
        removeAt(props.rows, index);
      }
    },
  };
  const inst = compile(qubb)(0)({ n: 3, limit: 2, rate: 10, rows: [1, 5, 7] }, handlers);
  const host = mount(inst);
  return { inst, del: () => (host.querySelector(".del") as HTMLButtonElement).click() };
};

type TInstance = ReturnType<typeof instantiate>["inst"];

const asList = (branches: number | number[]): number[] => (typeof branches === "number" ? [branches] : [...branches]);

// 풀의 살아 있는 칸 번호. 반납된 칸은 null이다(pool-allocator.ts).
const liveIndices = (entries: unknown[]): number[] =>
  entries.flatMap((entry, index) => (entry === null ? [] : [index]));

// 위쪽 간선 셋이 아래쪽 간선과 맞는지 본다.
const assertInSync = (inst: TInstance): void => {
  const { regionPool, branchPool, exprInstances, ownershipTree } = inst;
  for (const branchIndex of liveIndices(branchPool.entries)) {
    const regionIndex = ownershipTree.regionOfBranch(branchIndex);
    assert.ok(
      regionPool.entries[regionIndex].branchIndices.includes(branchIndex),
      `가지 ${branchIndex}의 Region ${regionIndex}가 그 가지를 품는다`,
    );
  }
  const roots: number[] = [];
  for (const regionIndex of liveIndices(regionPool.entries)) {
    const parentBranchIndex = ownershipTree.parentBranchOfRegion(regionIndex);
    if (parentBranchIndex === NO_PARENT) {
      roots.push(regionIndex);
      continue;
    }
    assert.ok(
      branchPool.entries[parentBranchIndex].childRegionIndices.includes(regionIndex),
      `Region ${regionIndex}의 부모 가지 ${parentBranchIndex}가 그 Region을 품는다`,
    );
  }
  assert.equal(roots.length, 1, "부모 가지가 없는 Region은 루트 하나다");
  for (const exprInstanceIndex of liveIndices(exprInstances.entries)) {
    // 한 가지가 같은 공유 인스턴스를 두 번 들 수 있어 횟수까지 맞춘다.
    const holders = liveIndices(branchPool.entries).flatMap((branchIndex) =>
      (branchPool.entries[branchIndex].exprInstanceIndices ?? [])
        .filter((held: number) => held === exprInstanceIndex)
        .map(() => branchIndex),
    );
    assert.deepEqual(
      asList(ownershipTree.branchesOfExprInstance(exprInstanceIndex)).sort(),
      holders.sort(),
      `식 인스턴스 ${exprInstanceIndex}를 든 가지`,
    );
  }
};

test("mount 직후 위쪽 간선이 아래쪽 간선과 맞는다", () => {
  const { inst } = instantiate();
  assertInSync(inst);
});

test("@if를 바꿔 안 만든 가지를 처음 만들고 다시 바꿔도 맞는다", () => {
  const { inst } = instantiate();
  inst.update({ limit: 0 });
  assertInSync(inst);
  inst.update({ limit: 9 });
  assertInSync(inst);
});

test("개수 @for를 늘리고 줄여도 맞는다", () => {
  const { inst } = instantiate();
  inst.update({ n: 6 });
  assertInSync(inst);
  inst.update({ n: 1 });
  assertInSync(inst);
});

test("배열 @for의 행을 removeAt으로 지워도 맞고, 공유 인스턴스는 남은 행이 계속 든다", () => {
  const { inst, del } = instantiate([1, 0]);
  inst.update({ limit: 0 });
  del();
  assertInSync(inst);
  del();
  assertInSync(inst);
});
