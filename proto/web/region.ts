import { allocInPool, freeInPool } from "./pool-allocator.ts";

// Region - 노드가 붙었다/떼였다 하는 경계. @if(then/else 중 하나만 보임)와 @for(회차 전부 보임)
// 두 종류. 모든 관계는 인덱스 기반 - 객체는 regionPool/branchPool 두 배열에만 살고 나머지는 숫자로
// 든다(숫자를 끝까지 들고, 객체는 최말단에서만 pool[i]로 푼다).
//
// 왜 lazy build: @if 비활성 가지는 안 보이니 구독 0이어야 한다(안 보이는 노드는 set에 반응 안 함).
// 그래서 비활성 가지는 최초 인스턴스화 때 build하지 않고, 처음 활성화될 때 1회 build한다(built).
// @for 회차는 늘 활성이라 즉시 build한다.
//
// 왜 자식 Region까지 재귀로 떼고/붙이나: anchor가 주석 노드라 자식을 못 가져 DOM이 평평하다 -
// 자식 Region이 swap되면 그 노드는 자식 anchor의 형제로 붙어, 부모 가지 nodes만 떼면 잔류한다.
// 그래서 detach/attach가 자식 Region까지 따라 내려간다(직속 구독은 teardown/restoreBranchSubs가,
// 트리 순회는 detach/attach가 전담).

// leaf-store.ts가 export하는 LeafStoreSubject와 동일 계약을 여기서 다시 정의한다(순환 import
// 회피). leafIndex가 유일한 접근 축 - path/leafOf는 진입점 plant로 없어졌다.
export type Store = {
  get: (leafIndex: number) => unknown;
  set: (leafIndex: number, value: unknown) => void;
  subscribe: (leafIndex: number, fn: (v: unknown) => void) => void;
  unsubscribe: (leafIndex: number, fn: (v: unknown) => void) => void;
};

export type TBranch = {
  nodes: ChildNode[];
  leafIndices: number[];
  updateFns: Array<(v: unknown) => void>;
  childRegionIndices: number[];
  built: boolean;
  lazyBuild: (() => void) | null;
};

export type TRegion = {
  branchIndices: number[];
  condLeafIndex: number;
  anchor: Comment;
  shownIndex: number;
  detach: (store: Store, regionPool: TRegion[], branchPool: TBranch[], region: TRegion) => void;
  attach: (store: Store, regionPool: TRegion[], branchPool: TBranch[], region: TRegion) => void;
};

// @for가 순회하는 배열 하나의 요소 위치. elemSize = 요소 하나가 차지하는 leaf 수(스칼라 1, 객체는
// 필드 수) - 요소 안은 시작에서 이만큼 연속. elemStartLeafIndices[i] = i번째 요소의 시작 leafIndex -
// 요소가 흩어져 할당돼 연속을 못 믿으므로 회차마다 시작을 명시로 든다(요소 사이는 리스트, 요소
// 안은 elemSize 산술). 요소 추가/제거 시 이 목록으로 유지·회수 대상을 가른다.
export type TArrayInfo = {
  elemSize: number;
  elemStartLeafIndices: number[];
};

export const THEN_INDEX = 0;
export const ELSE_INDEX = 1;

// arrayPool에 빈 배열정보를 alloc하고 그 arrayInfoIndex를 돌려준다.
export const appendArrayInfo = (arrayPool: TArrayInfo[], freeArrays: number[], elemSize: number): number =>
  allocInPool(arrayPool, freeArrays, { elemSize, elemStartLeafIndices: [] });

// branchPool에 빈 Branch를 alloc(빈 칸 재사용 or append)하고 그 branchIndex를 돌려준다.
const appendBranch = (branchPool: TBranch[], freeBranches: number[]): number =>
  allocInPool(branchPool, freeBranches, {
    nodes: [],
    leafIndices: [],
    updateFns: [],
    childRegionIndices: [],
    built: false,
    lazyBuild: null, // runtime.js가 비활성 가지에 심는다. 첫 활성화 때 1회 호출.
  });

// 한 가지의 직속 구독만 끊는다(잎 작업). 자식 Region 재귀는 detach 함수가 전담.
const teardownBranchSubs = (store: Store, branch: TBranch): void => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    store.unsubscribe(leafIndices[i], updateFns[i]);
  }
};

// 한 가지의 직속 구독만 복원(현재값 갱신 + 재구독)한다(잎 작업). 자식 재귀는 attach 함수 전담.
const restoreBranchSubs = (store: Store, branch: TBranch): void => {
  const { leafIndices, updateFns } = branch;
  for (let i = 0; i < leafIndices.length; i++) {
    updateFns[i](store.get(leafIndices[i])); // 비활성 동안 놓친 값 따라잡기
    store.subscribe(leafIndices[i], updateFns[i]);
  }
};

// 한 가지를 떼어낸다. anchor가 평평한 형제라 자식 swap 노드가 잔류하므로 자식 Region까지 재귀로 뗀다.
const detachOneBranch = (store: Store, regionPool: TRegion[], branchPool: TBranch[], branchIndex: number): void => {
  const branch = branchPool[branchIndex];
  for (const node of branch.nodes) {
    node.remove();
  }
  teardownBranchSubs(store, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    const child = regionPool[childRegionIndex];
    child.detach(store, regionPool, branchPool, child);
  }
};

// 한 가지를 붙인다. 부모 노드를 먼저 anchor 뒤에 붙여야(자식 anchor가 그 안에 들어가) 자식 노드가
// 위치를 가지므로, 부모 부착 후 자식 Region까지 재귀로 붙인다.
const attachOneBranch = (
  store: Store,
  regionPool: TRegion[],
  branchPool: TBranch[],
  anchor: ChildNode,
  branchIndex: number,
): void => {
  const branch = branchPool[branchIndex];
  anchor.after(...branch.nodes);
  restoreBranchSubs(store, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    const child = regionPool[childRegionIndex];
    child.attach(store, regionPool, branchPool, child);
  }
};

// ── @if: then/else 둘 중 shownIndex 하나만 보인다 ──────────────────────────────

// region을 받아 그 활성(shownIndex) 가지를 끈다.
const detachIf = (store: Store, regionPool: TRegion[], branchPool: TBranch[], region: TRegion): void => {
  detachOneBranch(store, regionPool, branchPool, region.branchIndices[region.shownIndex]);
};

// region을 받아 그 활성(shownIndex) 가지를 켠다. 최초 인스턴스화의 부착도 이 함수로 한다
// (runtime.js가 build로 트리만 만든 뒤 루트 Region부터 호출). 루트도 anchor를 가져 자식과
// 균일 처리된다(분기 없음).
const attachIf = (store: Store, regionPool: TRegion[], branchPool: TBranch[], region: TRegion): void => {
  attachOneBranch(store, regionPool, branchPool, region.anchor, region.branchIndices[region.shownIndex]);
};

// regionPool에 @if Region을 스폰한다 - anchor(주석 노드) 생성 + 빈 then/else Branch까지 갖춰 alloc하고
// 그 인덱스를 돌려준다. anchor를 DOM 트리 어디에 붙일지는 호출자 몫(IF는 nodeTop, 루트는 fragment).
// 인덱스는 alloc이 정한다(빈 칸 재사용 시 length와 다름) - 그래서 anchor 라벨은 alloc 후 채운다.
export const appendIfRegion = (
  regionPool: TRegion[],
  freeRegions: number[],
  branchPool: TBranch[],
  freeBranches: number[],
  condLeafIndex: number,
): number => {
  const anchor = document.createComment("");
  const regionIndex = allocInPool(regionPool, freeRegions, {
    branchIndices: [appendBranch(branchPool, freeBranches), appendBranch(branchPool, freeBranches)],
    condLeafIndex,
    anchor,
    shownIndex: -1,
    detach: detachIf,
    attach: attachIf,
  });
  anchor.data = `qb:region#${regionIndex}`;
  return regionIndex;
};

// region에서 지정 가지를 활성화한다. 현재 가지는 끄고(노드·구독 자식까지 재귀 detach),
// 다음 가지를 켠다(노드·구독 자식까지 재귀 attach). 이미 그 가지면 무동작.
// shownIndex: region.branchIndices 안의 슬롯(THEN=0/ELSE=1)이지 전역 branchPool 인덱스가 아니다.
// 전역 branchIndex는 region.branchIndices[shownIndex]로 한 번 더 푼다.
export const activateIf = (
  store: Store,
  regionPool: TRegion[],
  branchPool: TBranch[],
  regionIndex: number,
  shownIndex: number,
): void => {
  const region = regionPool[regionIndex];
  if (shownIndex === region.shownIndex) {
    return;
  }
  if (region.shownIndex !== -1) {
    detachIf(store, regionPool, branchPool, region); // 이전 shownIndex 기준으로 끈다
  }
  const nextBranch = branchPool[region.branchIndices[shownIndex]];
  if (!nextBranch.built) {
    // 생애 첫 활성화 - 지금(런타임) 처음 build해 nodes·구독을 채운다. 이후엔 detach/attach만.
    (nextBranch.lazyBuild as () => void)();
    nextBranch.built = true;
    // 방금 build하며 구독은 현재 가지에 모인 채다(즉시 구독 안 함, attachIf가 켠다).
  }
  region.shownIndex = shownIndex; // attach가 shownIndex로 가지를 찾으므로 먼저 갱신
  attachIf(store, regionPool, branchPool, region);
};

// ── @for: 가지가 회차 리스트, 전부 동시에 보인다 ──────────────────────────

// region을 받아 회차 전부를 떼어낸다.
const detachFor = (store: Store, regionPool: TRegion[], branchPool: TBranch[], region: TRegion): void => {
  for (const branchIndex of region.branchIndices) {
    detachOneBranch(store, regionPool, branchPool, branchIndex);
  }
};

// region을 받아 회차 전부를 붙인다.
const attachFor = (store: Store, regionPool: TRegion[], branchPool: TBranch[], region: TRegion): void => {
  for (const branchIndex of region.branchIndices) {
    attachOneBranch(store, regionPool, branchPool, region.anchor, branchIndex);
  }
};

// regionPool에 @for Region을 스폰한다 - anchor만 만들고 회차는 0개(회차는 appendBranchOfForRegion이
// 하나씩 더한다). countLeafIndex = 반복 횟수를 읽는 leaf(구독 대상).
export const appendForRegion = (regionPool: TRegion[], freeRegions: number[], countLeafIndex: number): number => {
  const anchor = document.createComment("");
  const regionIndex = allocInPool(regionPool, freeRegions, {
    branchIndices: [],
    condLeafIndex: countLeafIndex,
    anchor,
    shownIndex: -1,
    detach: detachFor,
    attach: attachFor,
  });
  anchor.data = `qb:region#${regionIndex}`;
  return regionIndex;
};

// @for region에 회차 Branch 하나를 더하고 그 branchIndex(전역)를 돌려준다. runtime.js가 그 인덱스를
// startBranchIndex로 interpret해 노드·구독·자식region을 이 회차에 격리한다.
export const appendBranchOfForRegion = (
  regionPool: TRegion[],
  branchPool: TBranch[],
  freeBranches: number[],
  regionIndex: number,
): number => {
  const branchIndex = appendBranch(branchPool, freeBranches);
  regionPool[regionIndex].branchIndices.push(branchIndex);
  return branchIndex;
};

// @for region에 회차 하나(branchIndex)를 붙인다(count 늘 때 새 회차만). anchor 뒤에 노드가 붙는데,
// anchor.after는 늘 anchor 바로 뒤에 끼워 순서가 뒤집힌다 - 마지막 회차의 끝 노드 뒤에 붙여야
// 회차 순서가 유지된다. 회차가 없으면 anchor 뒤, 있으면 직전 회차 끝 노드 뒤가 기준점이다.
export const attachForIteration = (
  store: Store,
  regionPool: TRegion[],
  branchPool: TBranch[],
  region: TRegion,
  branchIndex: number,
): void => {
  const branch = branchPool[branchIndex];
  const slot = region.branchIndices.indexOf(branchIndex);
  const prev = slot > 0 ? branchPool[region.branchIndices[slot - 1]] : null;
  const after = prev?.nodes.length ? prev.nodes[prev.nodes.length - 1] : region.anchor;
  after.after(...branch.nodes);
  restoreBranchSubs(store, branch);
  for (const childRegionIndex of branch.childRegionIndices) {
    const child = regionPool[childRegionIndex];
    child.attach(store, regionPool, branchPool, child);
  }
};

// branch(branchIndex)와 그 자식 region들을 리프까지 재귀로 free해 칸을 반납한다. detach(DOM/구독
// 떼기)와는 별개 - detach는 @if swap에서도 쓰여 free하면 안 되므로 안 섞는다. 호출 전 detach가
// 이미 끝난 상태를 가정한다(truncateFor가 detachOneBranch 후 부른다). 자식 먼저, 자기 나중(리프부터).
const freeBranchTree = (
  branchPool: TBranch[],
  freeBranches: number[],
  regionPool: TRegion[],
  freeRegions: number[],
  branchIndex: number,
): void => {
  for (const childRegionIndex of branchPool[branchIndex].childRegionIndices) {
    freeRegionTree(branchPool, freeBranches, regionPool, freeRegions, childRegionIndex);
  }
  freeInPool(branchPool, freeBranches, branchIndex);
};

// region(regionIndex)이 든 모든 branch를 재귀 free한 뒤 이 region 칸을 반납한다.
const freeRegionTree = (
  branchPool: TBranch[],
  freeBranches: number[],
  regionPool: TRegion[],
  freeRegions: number[],
  regionIndex: number,
): void => {
  for (const branchIndex of regionPool[regionIndex].branchIndices) {
    freeBranchTree(branchPool, freeBranches, regionPool, freeRegions, branchIndex);
  }
  freeInPool(regionPool, freeRegions, regionIndex);
};

// @for region의 꼬리 회차를 count개만 남기고 떼어낸다(count 줄 때). 회차마다 detach(떼기) 후
// freeBranchTree(칸 반납)를 부른다 - 둘이 별개인 이유는 freeBranchTree 주석 참고.
export const truncateFor = (
  store: Store,
  regionPool: TRegion[],
  freeRegions: number[],
  branchPool: TBranch[],
  freeBranches: number[],
  region: TRegion,
  count: number,
): void => {
  const branchIndices = region.branchIndices;
  for (let i = branchIndices.length - 1; i >= count; i--) {
    detachOneBranch(store, regionPool, branchPool, branchIndices[i]);
    freeBranchTree(branchPool, freeBranches, regionPool, freeRegions, branchIndices[i]);
  }
  branchIndices.length = count;
};
