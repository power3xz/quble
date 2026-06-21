// Region — @if의 swap 경계. 한 자리에서 두 가지(then/else) 중 하나만 보인다.
//
// "해석 ≠ build": 활성 가지만 보이고, 비활성 가지의 구독은 0이어야 한다(안 보이는 노드는
// set에 반응하지 않는다). lazy build: 비활성 가지는 최초 인스턴스화 때 build하지 않고
// (노드 0·구독 0), 그 가지가 처음 활성화될 때(런타임 swap) 비로소 build한다. 각 가지는 생애
// 첫 활성화 때 딱 한 번 build되고(branch.built), 이후엔 detach/attach만 한다.
// build 자체는 compile.js의 interpret을 캡처한 branch.lazyBuild 클로저가 한다 — region.js는
// 바이트코드/경계를 모른 채 "가지 토글"만 책임진다.
//
// 데이터 모양 (region-build 실험에서 확정. 모든 관계는 인덱스 기반):
//   regions: Region[]            — 한 인스턴스의 모든 Region. append만, 인덱스 영구 안정.
//   Region { branches:[], condLeafIndex, anchor, shownIndex }
//     branches[THEN_INDEX]=then, branches[ELSE_INDEX]=else. 가지는 build 시점에 채워진다.
//     shownIndex = 현재 보이는 가지(-1 = 아직 없음). 루트 Region은 condLeafIndex/anchor 없는 껍데기.
//   Branch { nodes, leafIndices, updateFns, childRegionIndices, built, lazyBuild }
//     leafIndices[i] <-> updateFns[i] (병렬). childRegionIndices = regions 배열 인덱스.
//     built = 이 가지를 build한 적 있는가(처음 활성화 때 1회 build). lazyBuild = build 클로저.
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
  built: false,
  lazyBuild: null, // compile.js가 비활성 가지에 심는다. 첫 활성화 때 1회 호출.
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
  if (!nextBranch.built) {
    // 생애 첫 활성화 — 지금(런타임) 처음 build해 nodes·구독을 채운다. 이후엔 detach/attach만.
    nextBranch.lazyBuild();
    nextBranch.built = true;
    // 방금 build하며 구독은 현재 가지에 모인 채다(즉시 구독 안 함, restore가 켠다).
  }
  restoreBranchSubs(ctx, regions, nextBranch);
  region.anchor.after(...nextBranch.nodes); // 가지 루트만 — 자손은 따라온다.
  region.shownIndex = branchIndex;
};
