// Quble 클라이언트 상태 저장소 - 평탄 배열(leaves)의 각 칸에 leafIndex로 값을 읽고/쓰고,
// 그 위에 반응성을 얹는다. 값은 진입점(plantRoot)이 루트 props 타입 구조대로 미리 펴서 넣는다
// - store는 타입을 모르는 순수 저장소다(leafIndex가 유일한 접근 축).
//
//   createLeafStore(leaves)        -> { get, set }                                 (데이터만)
//   createLeafStoreSubject(leaves) -> 위 + { notify, subscribe, unsubscribe, alloc, free }  (반응성 + 동적 칸)
//
// runtime.ts의 blueprint가 만들어 인스턴스에 싣는 store가 곧 createLeafStoreSubject의 반환물이다.

type LeafIndex = number;

// ── leafStore (데이터만) ─────────────────────────────────────────────
// 평탄 leaves 배열을 감싸 leafIndex로 값을 읽고/쓴다. 반응성(구독/통지)은 없다
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

// ── leafStoreSubject (leafStore + 반응성 + 동적 칸) ──────────────────
// leafStore를 감싸 구독/통지(subscribe/set 통지)와 동적 칸(alloc/free - 배열 요소 추가/제거)을
// 얹는다(Subject - 값을 들고 변경을 구독자에게 통지하는 주체).

// 칸이 바뀌면 불리는 함수. 새 값과 함께 어느 칸이 바뀌었는지 받는다 - 식 하나가 칸 a, b를 함께
// 구독하면 두 칸에 같은 함수 하나를 걸고, 불릴 때 leafIndex로 a인지 b인지 가린다.
//
// 셋째 인자 flushLeaves는 batch가 끝날 때의 통지에서만 온다. 이번 flush에서 바뀐 leaf 전체(구독하지 않은
// leaf 포함)이고, 한 flush 안에서는 같은 Set이다 - 식이 첫 호출에서 한꺼번에 다시 세고 나머지 호출은
// 같은 Set인지로 건너뛴다. 배치 밖의 통지에서는 오지 않는다.
export type TSubscriber = (value: unknown, leafIndex: LeafIndex, flushLeaves?: ReadonlySet<LeafIndex>) => void;

export type LeafStoreSubject = {
  get: (leafIndex: LeafIndex) => unknown;
  set: (leafIndex: LeafIndex, value: unknown) => void;
  notify: (leafIndex: LeafIndex) => void;
  batch: (fn: () => void) => void;
  alloc: (values: unknown[]) => LeafIndex;
  free: (start: LeafIndex, size: number) => void;
  subscribe: (leafIndex: LeafIndex, fn: TSubscriber) => void;
  unsubscribe: (leafIndex: LeafIndex, fn: TSubscriber) => void;
};
export const createLeafStoreSubject = (leaves: unknown[]): LeafStoreSubject => {
  const leafStore = createLeafStore(leaves);
  const subscribers: Array<Set<TSubscriber> | undefined> = []; // leafIndex -> Set<TSubscriber>. Set이라 unsubscribe가 O(1).
  // 요소 회수(free)로 반납된 빈 블록의 시작 leafIndex를 크기별로 모은 free list. 배열 요소 크기 집합은
  // 정적/유한이라(타입이 정함) 크기별 정확 매칭이면 충분 - 병합/split/정렬 없이 O(1) 재사용/반납.
  const freeBySize = new Map<number, LeafIndex[]>();
  // 열려 있는 batch의 수와, 그동안 통지를 미룬 칸(Set이라 같은 칸은 한 번만 든다).
  let batchDepth = 0;
  let pendingLeaves = new Set<LeafIndex>();

  const set = (leafIndex: LeafIndex, value: unknown): void => {
    if (leafStore.get(leafIndex) === value) {
      return;
    }
    leafStore.set(leafIndex, value);
    notify(leafIndex);
  };

  // leaf의 값은 바꾸지 않고, 그 leaf에 걸린 구독 함수들을 호출한다. set은 값이 같으면 구독 함수를
  // 호출하지 않아, 값은 그대로인데 구독자가 다시 읽어야 할 때 set 대신 호출한다. batch 안이면 부르지
  // 않고 칸만 모아 둔다 - 가장 바깥 batch가 끝날 때 칸마다 한 번 부른다.
  const notify = (leafIndex: LeafIndex): void => {
    if (batchDepth > 0) {
      pendingLeaves.add(leafIndex);
      return;
    }
    fire(leafIndex);
  };

  // 구독 함수들을 지금 호출한다. 모아 둔 칸을 비울 때는 그 칸의 현재 값(마지막으로 쓴 값)을 넘긴다.
  // flushLeaves는 모아 둔 칸을 비울 때만 넘어온다.
  const fire = (leafIndex: LeafIndex, flushLeaves?: ReadonlySet<LeafIndex>): void => {
    const subs = subscribers[leafIndex];
    if (subs) {
      const value = leafStore.get(leafIndex);
      // 스냅샷 순회 - 콜백(cond)이 activateIf로 구독을 해제할 수 있어 원본 순회는 깨진다.
      for (const fn of [...subs]) {
        fn(value, leafIndex, flushLeaves);
      }
    }
  };

  // 값 뭉치(values)를 store에 심고 시작 leafIndex를 돌려준다 - 배열 요소 추가(push)가 요소를 타입대로 펴
  // 넘긴다(해석은 호출부, store는 값만 심는다). 통지 안 함(새 칸이라 구독자 없음). 같은 크기 빈 블록이
  // free list에 있으면 그 자리를 재사용하고(뒤로 안 늘림), 없으면 leaves 끝에 확보한다. 둘 다 O(1).
  const alloc = (values: unknown[]): LeafIndex => {
    const reused = freeBySize.get(values.length)?.pop();
    const start = reused ?? leaves.length;
    for (let i = 0; i < values.length; i++) {
      leaves[start + i] = values[i]; // push(...values) 대신 인덱스 대입 - 큰 요소도 콜스택 스프레드 없이 안전.
    }
    return start;
  };

  // 요소 하나의 고정 칸([start, start+size))을 회수한다 - 배열 요소 제거(removeAt)가 부른다. 그 블록이 leaves
  // 끝이면 length를 줄여 실제로 되감고(pool 축소), 중간이면 크기별 free list에 반납해 다음 alloc이 재사용한다.
  const free = (start: LeafIndex, size: number): void => {
    if (start + size === leaves.length) {
      leaves.length = start; // 꼬리 회수 - 크기 무관, pool 실제 축소
      return;
    }
    let bucket = freeBySize.get(size);
    if (!bucket) {
      bucket = [];
      freeBySize.set(size, bucket);
    }
    bucket.push(start);
  };

  const subscribe = (leafIndex: LeafIndex, fn: TSubscriber): void => {
    subscribers[leafIndex] ??= new Set();
    subscribers[leafIndex].add(fn);
  };

  const unsubscribe = (leafIndex: LeafIndex, fn: TSubscriber): void => {
    subscribers[leafIndex]?.delete(fn);
  };

  // fn 안의 set/notify가 보낼 통지를 모았다가 가장 바깥 batch가 끝날 때 칸마다 한 번 보낸다. 값은 set이
  // 바로 기록하므로 fn 안의 get은 새 값을 읽는다. fn이 예외를 throw해도 모은 통지는 나가고 예외는 올라간다.
  const batch = (fn: () => void): void => {
    batchDepth += 1;
    try {
      fn();
    } finally {
      batchDepth -= 1;
      if (batchDepth === 0) {
        flushPending();
      }
    }
  };

  // 모은 칸을 처음 모은 순서대로 비운다. 구독자가 통지 중에 쓰는 값이 같은 집합을 건드리지 않게 모은
  // 집합을 이번 flush의 것으로 넘기고 새 집합으로 바꾼 뒤 부른다. 구독자가 예외를 throw해도 나머지 칸은
  // 모두 통지한다 - 값은 이미 다 기록됐는데 통지만 건너뛰면 화면이 값을 따라오지 못한다. 첫 예외는 모두
  // 통지한 뒤 다시 throw한다.
  const flushPending = (): void => {
    const flushLeaves = pendingLeaves;
    pendingLeaves = new Set();
    let failed = false;
    let firstError: unknown;
    for (const leafIndex of flushLeaves) {
      try {
        fire(leafIndex, flushLeaves);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) {
      throw firstError;
    }
  };

  return {
    get: leafStore.get,
    set,
    notify,
    batch,
    alloc,
    free,
    subscribe,
    unsubscribe,
  };
};
