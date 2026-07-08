// Region - 노드가 붙었다/떼였다 하는 경계. 두 종류다.
//   @if : branches 중 shownIndex 하나만 보인다(then/else swap). appendIfRegion 계열.
//   @for: branches가 회차 리스트라 전부 동시에 보인다(회차 하나=Branch 하나). count가 바뀌면
//         꼬리 회차만 늘리고 줄인다(append / truncateFor). appendForRegion 계열.
//
// "해석 ≠ build": @if는 활성 가지만 보이고 비활성 가지의 구독은 0이어야 한다(안 보이는 노드는
// set에 반응하지 않는다). lazy build: 비활성 가지는 최초 인스턴스화 때 build하지 않고
// (노드 0·구독 0), 그 가지가 처음 활성화될 때(런타임 swap) 비로소 build한다. 각 가지는 생애
// 첫 활성화 때 딱 한 번 build되고(branch.built), 이후엔 detach/attach만 한다.
// build 자체는 runtime.js의 interpret을 캡처한 branch.lazyBuild 클로저가 한다 - region.js는
// 바이트코드/경계를 모른 채 "가지 토글"만 책임진다. @for 회차는 늘 활성이라 lazy가 아니다
// (build 즉시 보인다). truncateFor로 떼어낸 회차는 재사용 안 하고 버린다(count가 도로 늘면
// 새 회차를 build).
//
// 데이터 모양 (모든 관계는 인덱스 기반):
//   regions: Region[]            - 한 인스턴스의 모든 Region. append만, 인덱스 영구 안정.
//   Region { branches:[], condLeafIndex, anchor, shownIndex, detach, attach }
//     @if: branches[THEN_INDEX]=then, branches[ELSE_INDEX]=else, shownIndex=보이는 가지(-1=없음).
//     @for: branches=회차 리스트(0..count-1 전부 활성), shownIndex 안 씀. condLeafIndex는 @if는
//     조건 leaf, @for는 count leaf. detach/attach는 종류별 함수 포인터 - 자식 재귀가 자식이
//     @if인지 @for인지 몰라도 regions[i].detach(...)로 호출한다.
//   Branch { nodes, leafIndices, updateFns, childRegionIndices, built, lazyBuild }
//     leafIndices[i] <-> updateFns[i] (병렬). childRegionIndices = regions 배열 인덱스.
//     built = 이 가지를 build한 적 있는가(@if 처음 활성화 때 1회 build). lazyBuild = build 클로저.
//
// off/on은 노드·구독 모두 자식 Region까지 재귀로 처리한다(detach/attach).
//   anchor는 주석 노드라 자식을 못 가져 DOM 트리가 평평하다 - 자식 Region이 swap되면 그 노드는
//   부모 가지 노드가 아니라 자식 anchor의 형제로 붙는다. 그래서 부모 가지의 nodes만 떼면 자식
//   swap 노드가 잔류한다(평평한 형제는 부모를 따라 안 떨어진다). 노드도 구독처럼 자식 Region까지
//   재귀로 떼고/붙인다. 트리 순회는 detach/attach가 맡고, 한 가지의 직속 구독 처리는
//   teardown/restoreBranchSubs가 잎(leaf) 작업으로 맡는다(자식 재귀는 트리 함수가 전담).
//   (regions 매개변수는 childRegionIndices(인덱스)->객체 풀이용. 일반 노드/자식 컴포넌트는 swap
//   단위가 아니라 건너뛰고 Region끼리만 재귀한다.)

export const THEN_INDEX = 0;
export const ELSE_INDEX = 1;

const createBranch = () => ({
  nodes: [],
  leafIndices: [],
  updateFns: [],
  childRegionIndices: [],
  built: false,
  lazyBuild: null, // runtime.js가 비활성 가지에 심는다. 첫 활성화 때 1회 호출.
});

// 한 가지의 직속 구독만 끊는다(잎 작업). 자식 Region 재귀는 detach 함수가 전담.
const teardownBranchSubs = (store, branch) => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    store.unsubscribe(leafIndices[i], updateFns[i]);
  }
};

// 한 가지의 직속 구독만 복원(현재값 갱신 + 재구독)한다(잎 작업). 자식 재귀는 attach 함수 전담.
const restoreBranchSubs = (store, branch) => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    updateFns[i](store.get(leafIndices[i])); // 비활성 동안 놓친 값 따라잡기
    store.subscribe(leafIndices[i], updateFns[i]);
  }
};

// 한 가지(branch)를 떼어낸다 - 노드 detach + 직속 구독 해제 + 활성 자식 Region 재귀.
// anchor가 평평한 형제라 자식 swap 노드가 잔류하므로 자식까지 따라 내려가 떼야 한다.
const detachOneBranch = (store, regions, branch) => {
  for (const node of branch.nodes) {
    node.remove();
  }
  teardownBranchSubs(store, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    const child = regions[childRegionIndex];
    child.detach(store, regions, child);
  }
};

// 한 가지(branch)를 붙인다 - anchor 뒤에 노드 attach + 직속 구독 복원 + 활성 자식 Region 재귀.
// 부모 노드를 먼저 anchor 뒤에 붙여야(자식 anchor가 그 안에 들어가) 자식 노드가 위치를 가진다.
const attachOneBranch = (store, regions, anchor, branch) => {
  anchor.after(...branch.nodes);
  restoreBranchSubs(store, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    const child = regions[childRegionIndex];
    child.attach(store, regions, child);
  }
};

// ── @if: then/else 둘 중 shownIndex 하나만 보인다 ──────────────────────────────

// region을 받아 그 활성(shownIndex) 가지를 끈다.
const detachIf = (store, regions, region) => {
  detachOneBranch(store, regions, region.branches[region.shownIndex]);
};

// region을 받아 그 활성(shownIndex) 가지를 켠다. 최초 인스턴스화의 부착도 이 함수로 한다
// (runtime.js가 build로 트리만 만든 뒤 루트 Region부터 호출). 루트도 anchor를 가져 자식과
// 균일 처리된다(분기 없음).
const attachIf = (store, regions, region) => {
  attachOneBranch(
    store,
    regions,
    region.anchor,
    region.branches[region.shownIndex],
  );
};

// regions에 @if Region을 스폰한다 - anchor(주석 노드) 생성 + 빈 then/else Branch까지 갖춰 push하고
// 그 인덱스를 돌려준다. anchor를 DOM 트리 어디에 붙일지는 호출자 몫(IF는 nodeTop, 루트는 fragment).
// 인덱스는 append-only라 영구 안정.
export const appendIfRegion = (regions, condLeafIndex) => {
  const regionIndex = regions.length;
  const anchor = document.createComment("qb:region#" + regionIndex);
  regions.push({
    branches: [createBranch(), createBranch()],
    condLeafIndex,
    anchor,
    shownIndex: -1,
    detach: detachIf,
    attach: attachIf,
  });
  return regionIndex;
};

// region에서 branchIndex 가지를 활성화한다. 현재 가지는 끄고(노드·구독 자식까지 재귀 detach),
// 다음 가지를 켠다(노드·구독 자식까지 재귀 attach). 이미 그 가지면 무동작.
export const activateIf = (store, regions, regionIndex, branchIndex) => {
  const region = regions[regionIndex];
  if (branchIndex === region.shownIndex) {
    return;
  }
  if (region.shownIndex !== -1) {
    detachIf(store, regions, region); // 이전 shownIndex 기준으로 끈다
  }
  const nextBranch = region.branches[branchIndex];
  if (!nextBranch.built) {
    // 생애 첫 활성화 - 지금(런타임) 처음 build해 nodes·구독을 채운다. 이후엔 detach/attach만.
    nextBranch.lazyBuild();
    nextBranch.built = true;
    // 방금 build하며 구독은 현재 가지에 모인 채다(즉시 구독 안 함, attachIf가 켠다).
  }
  region.shownIndex = branchIndex; // attach가 shownIndex로 가지를 찾으므로 먼저 갱신
  attachIf(store, regions, region);
};

// ── @for: branches가 회차 리스트, 전부 동시에 보인다 ──────────────────────────

// region을 받아 회차(branches) 전부를 떼어낸다.
const detachFor = (store, regions, region) => {
  for (const branch of region.branches) {
    detachOneBranch(store, regions, branch);
  }
};

// region을 받아 회차(branches) 전부를 붙인다.
const attachFor = (store, regions, region) => {
  for (const branch of region.branches) {
    attachOneBranch(store, regions, region.anchor, branch);
  }
};

// regions에 @for Region을 스폰한다 - anchor만 만들고 Branch는 0개(회차는 appendForIteration이
// 하나씩 더한다). countLeafIndex = 반복 횟수를 읽는 leaf(구독 대상).
export const appendForRegion = (regions, countLeafIndex) => {
  const regionIndex = regions.length;
  const anchor = document.createComment("qb:region#" + regionIndex);
  regions.push({
    branches: [],
    condLeafIndex: countLeafIndex,
    anchor,
    shownIndex: -1,
    detach: detachFor,
    attach: attachFor,
  });
  return regionIndex;
};

// @for region에 회차 Branch 하나를 더하고 그 인덱스를 돌려준다. runtime.js가 그 인덱스를
// startBranchIndex로 interpret해 노드·구독·자식region을 이 회차에 격리한다.
export const appendBranchOfForRegion = (regions, regionIndex) => {
  const branches = regions[regionIndex].branches;
  const branchIndex = branches.length;
  branches.push(createBranch());
  return branchIndex;
};

// @for region에 회차 하나(branch)를 붙인다(count 늘 때 새 회차만). anchor 뒤에 노드가 붙는데,
// anchor.after는 늘 anchor 바로 뒤에 끼워 순서가 뒤집힌다 - 마지막 회차의 끝 노드 뒤에 붙여야
// 회차 순서가 유지된다. 회차가 없으면 anchor 뒤, 있으면 직전 회차 끝 노드 뒤가 기준점이다.
export const attachForIteration = (store, regions, region, branch) => {
  const branches = region.branches;
  const prev = branches[branches.indexOf(branch) - 1];
  const after =
    prev && prev.nodes.length
      ? prev.nodes[prev.nodes.length - 1]
      : region.anchor;
  after.after(...branch.nodes);
  restoreBranchSubs(store, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    const child = regions[childRegionIndex];
    child.attach(store, regions, child);
  }
};

// @for region의 꼬리 회차를 count개만 남기고 떼어 버린다(count 줄 때). 떼어낸 회차는 재사용
// 안 한다 - 노드 remove + 직속 구독 해제 + 자식 region 재귀 detach 후 branches에서 잘라낸다.
export const truncateFor = (store, regions, region, count) => {
  for (let i = region.branches.length - 1; i >= count; i--) {
    detachOneBranch(store, regions, region.branches[i]);
  }
  region.branches.length = count;
};
