// Region — @if의 swap 경계. 한 자리에서 두 가지(then/else) 중 하나만 보인다.
//
// "해석 ≠ build": 활성 가지만 보이고, 비활성 가지의 구독은 0이어야 한다(안 보이는 노드는
// set에 반응하지 않는다). 지금은 스킵 없는 단계 — 양쪽 다 build해 두고 activateBranch가
// 가지를 토글한다. lazy build(비활성 가지를 swap 때 처음 build)는 다음 단계(IDEAS.md 참고).
//
// 데이터 모양 (region-build 실험에서 확정. 모든 관계는 인덱스 기반):
//   regions: Region[]            — 한 인스턴스의 모든 Region. append만, 인덱스 영구 안정.
//   Region { branches:[], condLeafIndex, anchor, shownIndex }
//     branches[THEN_INDEX]=then, branches[ELSE_INDEX]=else. 가지는 build 시점에 채워진다.
//     shownIndex = 현재 보이는 가지(-1 = 아직 없음). 루트 Region은 condLeafIndex/anchor 없는 껍데기.
//   Branch { nodes, leafIndices, updateFns, childRegionIndices }
//     leafIndices[i] <-> updateFns[i] (병렬). childRegionIndices = regions 배열 인덱스.
//
// off/on의 비대칭:
//   노드 — 가지 루트에서만 detach/attach 한 번. 자손 DOM은 같이 따라간다.
//   구독 — 자식 Region까지 재귀로 끊어야 0이 된다(regions 매개변수는 인덱스->객체 풀이용).
//          일반 노드/자식 컴포넌트는 swap 단위가 아니므로 건너뛰고 Region끼리만 재귀한다.

export const THEN_INDEX = 0;
export const ELSE_INDEX = 1;

export const createRegion = (condLeafIndex, anchor) => ({
  branches: [],
  condLeafIndex,
  anchor,
  shownIndex: -1,
});

export const createBranch = () => ({
  nodes: [],
  leafIndices: [],
  updateFns: [],
  childRegionIndices: [],
});

// 한 가지의 직접 구독을 끊고, 켜져 있던 자식 Region의 구독까지 재귀로 끊는다. 노드는 안 건드림.
const teardownBranchSubs = (ctx, regions, branch) => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    ctx.unsubscribe(leafIndices[i], updateFns[i]);
  }
  for (const childRegionIndex of branch.childRegionIndices) {
    const childRegion = regions[childRegionIndex];
    teardownBranchSubs(ctx, regions, childRegion.branches[childRegion.shownIndex]);
  }
};

// 한 가지의 직접 구독을 복원(현재값 갱신 + 재구독)하고, 켜져 있던 자식까지 재귀. 노드는 안 건드림.
const restoreBranchSubs = (ctx, regions, branch) => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    updateFns[i](ctx.leaves[leafIndices[i]]); // 비활성 동안 놓친 값 따라잡기
    ctx.subscribe(leafIndices[i], updateFns[i]);
  }
  for (const childRegionIndex of branch.childRegionIndices) {
    const childRegion = regions[childRegionIndex];
    restoreBranchSubs(ctx, regions, childRegion.branches[childRegion.shownIndex]);
  }
};

// region에서 branchIndex 가지를 활성화한다. 현재 가지는 끄고(노드 detach + 구독 재귀 해제),
// 다음 가지를 켠다(구독 재귀 복원 + 노드 attach). 이미 그 가지면 무동작.
export const activateBranch = (ctx, regions, regionIndex, branchIndex) => {
  const region = regions[regionIndex];
  if (branchIndex === region.shownIndex) {
    return;
  }
  if (region.shownIndex !== -1) {
    const currentBranch = region.branches[region.shownIndex];
    for (const node of currentBranch.nodes) {
      node.remove(); // 가지 루트만 — 자손 DOM도 같이 떨어진다.
    }
    teardownBranchSubs(ctx, regions, currentBranch);
  }
  const nextBranch = region.branches[branchIndex];
  restoreBranchSubs(ctx, regions, nextBranch);
  region.anchor.after(...nextBranch.nodes); // 가지 루트만 — 자손은 따라온다.
  region.shownIndex = branchIndex;
};
