// Region — @if의 swap 경계. 한 자리에서 두 가지(then/else) 중 하나만 보인다.
//
// "해석 ≠ build": 활성 가지만 보이고, 비활성 가지의 구독은 0이어야 한다(안 보이는 노드는
// set에 반응하지 않는다). lazy build: 비활성 가지는 최초 인스턴스화 때 build하지 않고
// (노드 0·구독 0), 그 가지가 처음 활성화될 때(런타임 swap) 비로소 build한다. 각 가지는 생애
// 첫 활성화 때 딱 한 번 build되고(branch.built), 이후엔 detach/attach만 한다.
// build 자체는 compile.js의 interpret을 캡처한 branch.lazyBuild 클로저가 한다 — region.js는
// 바이트코드/경계를 모른 채 "가지 토글"만 책임진다.
//
// 데이터 모양 (모든 관계는 인덱스 기반):
//   regions: Region[]            — 한 인스턴스의 모든 Region. append만, 인덱스 영구 안정.
//   Region { branches:[], condLeafIndex, anchor, shownIndex }
//     branches[THEN_INDEX]=then, branches[ELSE_INDEX]=else. 빈 Branch는 appendRegion이 생성
//     시점에 채우고, 각 가지의 nodes는 build 시점에 채워진다.
//     shownIndex = 현재 보이는 가지(-1 = 아직 없음). 루트 Region은 swap 없는 단일 가지지만
//     anchor·branches를 자식과 똑같이 갖춰(condLeafIndex=-1) attachBranch가 균일 처리한다.
//   Branch { nodes, leafIndices, updateFns, childRegionIndices, built, lazyBuild }
//     leafIndices[i] <-> updateFns[i] (병렬). childRegionIndices = regions 배열 인덱스.
//     built = 이 가지를 build한 적 있는가(처음 활성화 때 1회 build). lazyBuild = build 클로저.
//
// off/on은 노드·구독 모두 자식 Region까지 재귀로 처리한다(detachBranch/attachBranch).
//   anchor는 주석 노드라 자식을 못 가져 DOM 트리가 평평하다 — 자식 Region이 swap되면 그 노드는
//   부모 가지 노드가 아니라 자식 anchor의 형제로 붙는다. 그래서 부모 가지의 nodes만 떼면 자식
//   swap 노드가 잔류한다(평평한 형제는 부모를 따라 안 떨어진다). 노드도 구독처럼 자식 Region까지
//   재귀로 떼고/붙인다. 트리 순회는 detach/attachBranch가 맡고, 한 가지의 직속 구독 처리는
//   teardown/restoreBranchSubs가 잎(leaf) 작업으로 맡는다(자식 재귀는 트리 함수가 전담).
//   (regions 매개변수는 childRegionIndices(인덱스)->객체 풀이용. 일반 노드/자식 컴포넌트는 swap
//   단위가 아니라 건너뛰고 Region끼리만 재귀한다.)

export const THEN_INDEX = 0;
export const ELSE_INDEX = 1;

const createRegion = (condLeafIndex, anchor) => ({
  branches: [],
  condLeafIndex,
  anchor,
  shownIndex: -1,
});

const createBranch = () => ({
  nodes: [],
  leafIndices: [],
  updateFns: [],
  childRegionIndices: [],
  built: false,
  lazyBuild: null, // compile.js가 비활성 가지에 심는다. 첫 활성화 때 1회 호출.
});

// regions에 새 Region을 스폰한다 — anchor(주석 노드) 생성 + 빈 then/else Branch까지 갖춰 push하고
// 그 인덱스를 돌려준다. anchor를 DOM 트리 어디에 붙일지는 호출자 몫(IF는 nodeTop, 루트는 fragment).
// 인덱스는 append-only라 영구 안정. createRegion/createBranch는 이 함수의 내부 빌딩블록이다.
export const appendRegion = (regions, condLeafIndex) => {
  const regionIndex = regions.length;
  const anchor = document.createComment("qb:region#" + regionIndex);
  const region = createRegion(condLeafIndex, anchor);
  region.branches[THEN_INDEX] = createBranch();
  region.branches[ELSE_INDEX] = createBranch();
  regions.push(region);
  return regionIndex;
};

// 한 가지의 직속 구독만 끊는다(잎 작업). 자식 Region 재귀는 detachBranch가 전담.
const teardownBranchSubs = (ctx, branch) => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    ctx.unsubscribe(leafIndices[i], updateFns[i]);
  }
};

// 한 가지의 직속 구독만 복원(현재값 갱신 + 재구독)한다(잎 작업). 자식 재귀는 attachBranch 전담.
const restoreBranchSubs = (ctx, branch) => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    updateFns[i](ctx.leaves[leafIndices[i]]); // 비활성 동안 놓친 값 따라잡기
    ctx.subscribe(leafIndices[i], updateFns[i]);
  }
};

// region을 받아 그 활성(shownIndex) 가지를 끈다 — 노드 detach + 직속 구독 해제 + 활성 자식 Region 재귀.
// (인자는 region, 타겟은 그 region의 보이는 branch + 그 아래 트리.)
// anchor가 평평한 형제라 자식 swap 노드가 잔류하므로 자식까지 따라 내려가 떼야 한다.
const detachBranch = (ctx, regions, region) => {
  const branch = region.branches[region.shownIndex];
  for (const node of branch.nodes) {
    node.remove();
  }
  teardownBranchSubs(ctx, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    detachBranch(ctx, regions, regions[childRegionIndex]);
  }
};

// region을 받아 그 활성(shownIndex) 가지를 켠다 — 노드 attach + 직속 구독 복원 + 활성 자식 Region 재귀.
// (인자는 region, 타겟은 그 region의 보이는 branch + 그 아래 트리.)
// 부모 노드를 먼저 anchor 뒤에 붙여야(자식 anchor가 그 안에 들어가) 자식 노드가 위치를 가진다.
// 최초 인스턴스화의 부착도 이 함수로 한다(compile.js가 build로 트리만 만든 뒤 루트 Region부터
// 호출). 루트도 anchor를 가져 자식과 균일 처리된다(분기 없음).
export const attachBranch = (ctx, regions, region) => {
  const branch = region.branches[region.shownIndex];
  region.anchor.after(...branch.nodes);
  restoreBranchSubs(ctx, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    attachBranch(ctx, regions, regions[childRegionIndex]);
  }
};

// region에서 branchIndex 가지를 활성화한다. 현재 가지는 끄고(노드·구독 자식까지 재귀 detach),
// 다음 가지를 켠다(노드·구독 자식까지 재귀 attach). 이미 그 가지면 무동작.
export const activateBranch = (ctx, regions, regionIndex, branchIndex) => {
  const region = regions[regionIndex];
  if (branchIndex === region.shownIndex) {
    return;
  }
  if (region.shownIndex !== -1) {
    detachBranch(ctx, regions, region); // 이전 shownIndex 기준으로 끈다
  }
  const nextBranch = region.branches[branchIndex];
  if (!nextBranch.built) {
    // 생애 첫 활성화 — 지금(런타임) 처음 build해 nodes·구독을 채운다. 이후엔 detach/attach만.
    nextBranch.lazyBuild();
    nextBranch.built = true;
    // 방금 build하며 구독은 현재 가지에 모인 채다(즉시 구독 안 함, attachBranch가 켠다).
  }
  region.shownIndex = branchIndex; // attach가 shownIndex로 가지를 찾으므로 먼저 갱신
  attachBranch(ctx, regions, region);
};
