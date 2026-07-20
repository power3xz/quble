// Quble 클라이언트 상태 저장소 - 평탄 배열(leaves)의 각 칸에 leafIndex로 값을 읽고/쓰고,
// 그 위에 반응성을 얹는다. 값은 진입점(plantRoot)이 루트 props 타입 구조대로 미리 펴서 넣는다
// - store는 타입을 모르는 순수 저장소다(leafIndex가 유일한 접근 축).
//
//   createLeafStore(leaves)        → { get, set }                              (데이터만)
//   createLeafStoreSubject(leaves) → 위 + { subscribe, unsubscribe }, set이 통지  (반응성)
//
// runtime.ts의 blueprint가 만들어 인스턴스에 싣는 store가 곧 createLeafStoreSubject의 반환물이다.

type LeafIndex = number;

// ── leafStore (데이터만) ─────────────────────────────────────────────
// 평탄 leaves 배열을 감싸 leafIndex로 값을 읽고/쓴다. 반응성(구독·통지)은 없다
// - createLeafStoreSubject가 위에 얹는다. leaves는 비공개 - get/set이 유일한 관문이다.
//
// @param leaves    진입점이 타입 구조대로 펴 넣은 초기값 배열(leafIndex = 배열 인덱스)
// @returns         { get, set }
const createLeafStore = (leaves: unknown[]) => {
  // leafIndex로 값 읽기. 미설정이면 undefined(JS 기본 - 없는 값은 undefined).
  const get = (leafIndex: LeafIndex): unknown => leaves[leafIndex];

  // leafIndex로 값 쓰기. 통지하지 않는다(순수 저장).
  const set = (leafIndex: LeafIndex, value: unknown): void => {
    leaves[leafIndex] = value;
  };

  return { get, set };
};

// ── leafStoreSubject (leafStore + 반응성) ────────────────────────────
// leafStore를 감싸 구독·통지를 얹는다(Subject - 값을 들고 변경을 구독자에게 통지하는 주체).
// get은 leafStore에 위임하고, set은 통지하는 버전으로 덮어쓴다.
//
// @param leaves    leafStore에 넘길 초기값 배열
// @returns         { get, set, subscribe, unsubscribe }
export type LeafStoreSubject = {
  get: (leafIndex: LeafIndex) => unknown;
  set: (leafIndex: LeafIndex, value: unknown) => void;
  alloc: (values: unknown[]) => LeafIndex;
  subscribe: (leafIndex: LeafIndex, fn: (v: unknown) => void) => void;
  unsubscribe: (leafIndex: LeafIndex, fn: (v: unknown) => void) => void;
};
export const createLeafStoreSubject = (leaves: unknown[]): LeafStoreSubject => {
  const leafStore = createLeafStore(leaves);
  const subscribers: Array<Set<(v: unknown) => void> | undefined> = []; // leafIndex → Set<(v)=>void>. Set이라 unsubscribe가 O(1).

  const set = (leafIndex: LeafIndex, value: unknown): void => {
    if (leafStore.get(leafIndex) === value) {
      return;
    }
    leafStore.set(leafIndex, value);
    const subs = subscribers[leafIndex];
    if (subs) {
      // 스냅샷 순회 - 콜백(cond)이 activateBranch로 구독을 해제할 수 있어 원본 순회는 깨진다.
      for (const fn of [...subs]) {
        fn(value);
      }
    }
  };

  // 값 뭉치(values)를 store에 심고 시작 leafIndex를 돌려준다 - 배열 요소 추가(push)가 요소를 타입대로 펴
  // 넘긴다(해석은 호출부, store는 값만 심는다). 통지 안 함(새 칸이라 구독자 없음). 지금은 뒤에만 심는다 -
  // 요소 회수(remove)가 크기별 free list를 채우면, 여기에 "그 크기 빈 블록 있으면 그 start 재사용" 분기가 붙는다.
  const alloc = (values: unknown[]): LeafIndex => {
    const start = leaves.length;
    for (let i = 0; i < values.length; i++) {
      leaves[start + i] = values[i]; // push(...values) 대신 인덱스 대입 - 큰 요소도 콜스택 스프레드 없이 안전.
    }
    return start;
  };

  const subscribe = (leafIndex: LeafIndex, fn: (v: unknown) => void): void => {
    subscribers[leafIndex] ??= new Set();
    subscribers[leafIndex].add(fn);
  };

  const unsubscribe = (leafIndex: LeafIndex, fn: (v: unknown) => void): void => {
    subscribers[leafIndex]?.delete(fn);
  };

  return {
    get: leafStore.get,
    set,
    alloc,
    subscribe,
    unsubscribe,
  };
};
