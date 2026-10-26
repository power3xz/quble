// Quble 클라이언트 상태 저장소 - 평탄 배열(leaves)의 각 칸에 leafIndex로 값을 읽고/쓰고,
// 그 위에 반응성을 얹는다. 값은 진입점(plantRoot)이 루트 props 타입 구조대로 미리 펴서 넣는다
// - store는 타입을 모르는 순수 저장소다(leafIndex가 유일한 접근 축).
//
//   createLeafStore(leaves)        -> { get, set }                                 (데이터만)
//   createLeafStoreSubject(leaves) -> 위 + { write, notify, batch, subscribe, unsubscribe, setDeriveStage,
//                                     alloc, free, clear }                         (반응성 + 동적 칸)
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

// 통지 구독 함수. leaf가 바뀌면 notify 단계에서 새 값과 어느 leaf가 바뀌었는지를 받아 불린다.
export type TSubscriber = (value: unknown, leafIndex: LeafIndex) => void;

// 통지 전 단계. flush마다 바뀐 leaf 모음을 받아, 그 leaf로 만드는 파생 leaf를 write하고 통지할 leaf 모음(바뀐
// leaf와 값이 바뀐 파생 leaf)을 돌려준다. 단계 안에서 난 예외는 onError로 넘기고 나머지를 계속한다. 받은 Set은
// 고치거나 들고 있지 않는다. 표현식 층이 setDeriveStage로 등록한다 - store는 파생 leaf를 무엇이 어떻게 만드는지
// 모른다.
export type TDeriveStage = (
  changed: ReadonlySet<LeafIndex>,
  onError: (error: unknown) => void,
) => ReadonlySet<LeafIndex>;

// 단계를 등록하지 않았을 때의 단계. 파생 leaf가 없으므로 바뀐 leaf만 통지한다.
const noDeriveStage: TDeriveStage = (changed) => changed;

export type LeafStoreSubject = {
  get: (leafIndex: LeafIndex) => unknown;
  set: (leafIndex: LeafIndex, value: unknown) => void;
  // leaf에 값만 쓴다 - 통지 전 단계도 통지 구독도 트리거하지 않는다.
  write: (leafIndex: LeafIndex, value: unknown) => void;
  notify: (leafIndex: LeafIndex) => void;
  batch: (fn: () => void) => void;
  alloc: (values: unknown[]) => LeafIndex;
  free: (start: LeafIndex, size: number) => void;
  subscribe: (leafIndex: LeafIndex, fn: TSubscriber) => void;
  unsubscribe: (leafIndex: LeafIndex, fn: TSubscriber) => void;
  // 통지 전 단계를 등록한다. store가 표현식 층보다 먼저 만들어지므로 생성 뒤에 등록한다.
  setDeriveStage: (stage: TDeriveStage) => void;
  clear: () => void;
};
// leaf마다 구독을 담는 슬롯. 구독이 하나뿐인 leaf가 대부분이라 하나면 Set 없이 함수를 그대로 담고, 둘째가
// 들어올 때 Set으로 바꾼다 - leaf마다 Set을 두면 힙을 크게 차지하고, 가지를 껐다 켤 때 구독을 걸고 푸는 일이 Set의
// 표를 다시 짓는 할당이 된다. 같은 함수를 두 번 걸어도 한 번만 든다.
type TSubscriberFn = (...args: never[]) => unknown;
type TSlot<T extends TSubscriberFn> = T | Set<T> | undefined;

const addToSlot = <T extends TSubscriberFn>(slots: Array<TSlot<T>>, leafIndex: LeafIndex, fn: T): void => {
  const current = slots[leafIndex];
  if (current === undefined) {
    slots[leafIndex] = fn;
  } else if (typeof current === "function") {
    if (current !== fn) {
      slots[leafIndex] = new Set<T>([current, fn]);
    }
  } else {
    current.add(fn);
  }
};

const removeFromSlot = <T extends TSubscriberFn>(slots: Array<TSlot<T>>, leafIndex: LeafIndex, fn: T): void => {
  const current = slots[leafIndex];
  if (current === fn) {
    slots[leafIndex] = undefined;
  } else if (current !== undefined && typeof current !== "function") {
    current.delete(fn);
  }
};

export const createLeafStoreSubject = (leaves: unknown[]): LeafStoreSubject => {
  const leafStore = createLeafStore(leaves);
  const subscribers: Array<TSlot<TSubscriber>> = []; // leafIndex -> 그 leaf의 통지 구독들.
  // setDeriveStage로 등록한 통지 전 단계.
  let deriveStage = noDeriveStage;
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
    write(leafIndex, value);
    notify(leafIndex);
  };

  // leaf에 값만 쓴다. 구독을 트리거하지 않아, 부른 쪽이 통지할 leaf를 직접 모아야 한다.
  const write = (leafIndex: LeafIndex, value: unknown): void => {
    leafStore.set(leafIndex, value);
  };

  // leaf의 값은 바꾸지 않고, 그 leaf에 걸린 구독 함수들을 호출한다. set은 값이 같으면 구독 함수를
  // 호출하지 않아, 값은 그대로인데 구독자가 다시 읽어야 할 때 set 대신 호출한다. batch 안이면 부르지
  // 않고 칸만 모아 둔다 - 가장 바깥 batch가 끝날 때 칸마다 한 번 부른다.
  const notify = (leafIndex: LeafIndex): void => {
    if (batchDepth > 0) {
      pendingLeaves.add(leafIndex);
      return;
    }
    propagate(new Set([leafIndex]));
  };

  // 통지 전 단계를 거친 뒤 통지 구독을 부른다. 통지할 leaf는 단계가 돌려준 모음이다. 단계나 통지 구독이 던져도
  // 나머지는 모두 부르고 첫 예외를 마지막에 다시 던진다 - 값은 이미 다 기록됐는데 통지만 건너뛰면 화면이 값을
  // 따라오지 못한다.
  const propagate = (changed: ReadonlySet<LeafIndex>): void => {
    let failed = false;
    let firstError: unknown;
    const onError = (error: unknown): void => {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    };
    for (const leafIndex of deriveStage(changed, onError)) {
      try {
        fire(leafIndex);
      } catch (error) {
        onError(error);
      }
    }
    if (failed) {
      throw firstError;
    }
  };

  // 통지 구독 함수들을 지금 호출한다. 그 칸의 현재 값(마지막으로 쓴 값)을 넘긴다.
  const fire = (leafIndex: LeafIndex): void => {
    const subs = subscribers[leafIndex];
    if (subs === undefined) {
      return;
    }
    const value = leafStore.get(leafIndex);
    if (typeof subs === "function") {
      subs(value, leafIndex);
      return;
    }
    // 스냅샷 순회 - 콜백(cond)이 activateIf로 구독을 해제할 수 있어 원본 순회는 깨진다.
    for (const fn of [...subs]) {
      fn(value, leafIndex);
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
    addToSlot(subscribers, leafIndex, fn);
  };

  const unsubscribe = (leafIndex: LeafIndex, fn: TSubscriber): void => {
    removeFromSlot(subscribers, leafIndex, fn);
  };

  const setDeriveStage = (stage: TDeriveStage): void => {
    deriveStage = stage;
  };

  // 값, 구독, 통지 전 단계, 빈 블록 기록, 미룬 통지를 모두 비운다 - 인스턴스를 해체할 때 store가 값과 구독
  // 함수를 놓는다.
  const clear = (): void => {
    leaves.length = 0;
    subscribers.length = 0;
    deriveStage = noDeriveStage;
    freeBySize.clear();
    pendingLeaves.clear();
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
  // 집합을 이번 flush의 것으로 넘기고 새 집합으로 바꾼 뒤 부른다.
  const flushPending = (): void => {
    const flushLeaves = pendingLeaves;
    pendingLeaves = new Set();
    propagate(flushLeaves);
  };

  return {
    get: leafStore.get,
    set,
    write,
    notify,
    batch,
    alloc,
    free,
    subscribe,
    unsubscribe,
    setDeriveStage,
    clear,
  };
};
