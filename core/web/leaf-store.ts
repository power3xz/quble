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

// 통지 구독 함수. leaf가 바뀌면 notify 단계에서 새 값과 어느 leaf가 바뀌었는지를 받아 불린다.
export type TSubscriber = (value: unknown, leafIndex: LeafIndex) => void;

// 파생 구독 함수. 이번 flush에서 바뀐 leaf 전체(등록하지 않은 leaf도 든다)를 받아 파생값을 돌려준다. 자기가
// 읽는 leaf를 가려내는 것은 함수 몫이고, has로 O(1)에 묻는다(바뀐 leaf가 수천 개인 batch에서 배열을 훑으면 함수
// 수만큼 곱해진다). 입력은 store.get으로 읽고 store에 쓰지 않는다 - 돌려준 값은 구독 층이 결과 leaf에
// write한다. 함수 하나를 여러 leaf에 걸 수 있고, flush마다 한 번만 불린다. 받은 Set은 모든 함수가 공유하므로
// 고치거나 들고 있지 않는다.
export type TDeriveSubscriber = (changedLeaves: ReadonlySet<LeafIndex>) => unknown;

export type LeafStoreSubject = {
  get: (leafIndex: LeafIndex) => unknown;
  set: (leafIndex: LeafIndex, value: unknown) => void;
  // leaf에 값만 쓴다 - 파생 구독도 통지 구독도 트리거하지 않는다.
  write: (leafIndex: LeafIndex, value: unknown) => void;
  notify: (leafIndex: LeafIndex) => void;
  batch: (fn: () => void) => void;
  alloc: (values: unknown[]) => LeafIndex;
  free: (start: LeafIndex, size: number) => void;
  subscribe: (leafIndex: LeafIndex, fn: TSubscriber) => void;
  unsubscribe: (leafIndex: LeafIndex, fn: TSubscriber) => void;
  // resultLeafIndex는 fn이 돌려준 값이 write될 leaf다. 없으면 돌려준 값을 쓰지 않는다. 같은 fn은 같은
  // 결과 leaf로만 등록한다.
  subscribeDerive: (leafIndex: LeafIndex, fn: TDeriveSubscriber, resultLeafIndex?: LeafIndex) => void;
  unsubscribeDerive: (leafIndex: LeafIndex, fn: TDeriveSubscriber) => void;
  // fn이 돌려준 값을 write할 결과 leaf를 연결한다. 구독 등록과 별개라, 가지가 붙기 전(build 중)에 먼저
  // 연결해 두고 붙을 때 subscribeDerive(leafIndex, fn)만 해도 값이 결과 leaf로 간다.
  bindDeriveResult: (fn: TDeriveSubscriber, resultLeafIndex: LeafIndex) => void;
  // fn의 결과 leaf를 반납하고 연결을 푼다 - 파생 구독을 가진 가지가 없어질 때 부른다. fn이 입력 leaf 여러 개에
  // 걸려 같은 fn으로 여러 번 불려도 첫 번째만 반납한다.
  freeDeriveResult: (fn: TDeriveSubscriber) => void;
  // set이 아닌 경로에서 파생 구독 fn 하나만 지금 한 번 부른다 - 가지를 다시 붙일 때 놓친 입력을 따라잡는다.
  // 돌려준 값을 결과 leaf에 write하고, 값이 바뀌었으면 그 leaf를 notify한다.
  refreshDerive: (fn: TDeriveSubscriber, leafIndex: LeafIndex) => void;
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
  // 입력 leafIndex -> 그 leaf에 걸린 파생 구독들. 함수 하나가 입력 leaf 여러 개의 슬롯에 들 수 있다.
  const deriveSubscribers: Array<TSlot<TDeriveSubscriber>> = [];
  const resultLeafOf = new WeakMap<TDeriveSubscriber, LeafIndex>(); // 파생 구독 함수 -> 돌려준 값을 write할 결과 leaf.
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
    const derives = deriveSubscribers[leafIndex];
    if (derives === undefined) {
      fire(leafIndex);
      return;
    }
    propagateOne(leafIndex, derives, new Set([leafIndex]));
  };

  // 바뀐 leaf가 하나인 flush(batch 밖의 set과 notify, 또는 batch가 끝날 때 하나만 모인 경우). 같은 함수가 두 번
  // 불릴 일이 없어 이미 부른 함수를 기억하지 않고 차례로 부른다. 바뀐 leaf 하나를 담은 Set(changedLeaves)을
  // 모든 함수가 공유한다. 한 leaf에 파생 구독이 수천 개 걸린 식(1000행의 같은 기준값을 읽는 식)에서 함수마다
  // 배열을 만들고 Map을 채우는 비용이 클릭 한 번보다 컸다. 예외는 propagate와 같다 - 나머지를 모두 부르고 첫
  // 예외를 마지막에 다시 던진다.
  const propagateOne = (
    leafIndex: LeafIndex,
    derives: TDeriveSubscriber | ReadonlySet<TDeriveSubscriber>,
    changedLeaves: ReadonlySet<LeafIndex>,
  ): void => {
    let failed = false;
    let firstError: unknown;
    let resultLeaves: LeafIndex[] | undefined;
    const runDerive = (fn: TDeriveSubscriber): void => {
      try {
        const value = fn(changedLeaves);
        const resultLeaf = resultLeafOf.get(fn);
        if (resultLeaf !== undefined && leafStore.get(resultLeaf) !== value) {
          write(resultLeaf, value);
          resultLeaves ??= [];
          resultLeaves.push(resultLeaf);
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    };
    if (typeof derives === "function") {
      runDerive(derives);
    } else {
      // 스냅샷 순회 - 파생 구독이 읽는 leaf를 다시 걸며 이 Set을 고칠 수 있다.
      for (const fn of [...derives]) {
        runDerive(fn);
      }
    }
    try {
      fire(leafIndex);
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
    if (resultLeaves !== undefined) {
      for (const resultLeaf of resultLeaves) {
        try {
          fire(resultLeaf);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    }
    if (failed) {
      throw firstError;
    }
  };

  // 바뀐 leaf들로 파생 구독을 함수당 한 번 부른다. 바뀐 leaf 모음(changed)을 모든 함수가 그대로 공유한다 -
  // 함수마다 자기가 읽는 leaf를 has로 가려내므로 함수별 배열과 Map을 만들 필요가 없다(1000행의 식이 함께
  // 바뀌면 그 할당이 클릭 한 번의 시간을 늘렸다). 이미 부른 함수는 Set으로 건너뛴다. 돌려준 값을 결과 leaf에
  // write하고, 바뀐 leaf에 값이 바뀐 결과 leaf를 더한 모음을 돌려준다. 파생 구독이 던지면 onError로 넘기고
  // 나머지는 계속 부른다.
  const runDerives = (changed: ReadonlySet<LeafIndex>, onError: (error: unknown) => void): ReadonlySet<LeafIndex> => {
    let called: Set<TDeriveSubscriber> | undefined;
    let toNotify: Set<LeafIndex> | undefined;
    const runDerive = (fn: TDeriveSubscriber): void => {
      if ((called as Set<TDeriveSubscriber>).has(fn)) {
        return;
      }
      (called as Set<TDeriveSubscriber>).add(fn);
      try {
        const value = fn(changed);
        const resultLeaf = resultLeafOf.get(fn);
        if (resultLeaf !== undefined && leafStore.get(resultLeaf) !== value) {
          write(resultLeaf, value);
          toNotify ??= new Set(changed);
          toNotify.add(resultLeaf);
        }
      } catch (error) {
        onError(error);
      }
    };
    for (const leafIndex of changed) {
      const derives = deriveSubscribers[leafIndex];
      if (derives === undefined) {
        continue;
      }
      called ??= new Set();
      if (typeof derives === "function") {
        runDerive(derives);
      } else {
        for (const fn of derives) {
          runDerive(fn);
        }
      }
    }
    return toNotify ?? changed;
  };

  // 파생 구독을 모두 부른 뒤 통지 구독을 부른다. 통지할 leaf는 바뀐 leaf와 값이 바뀐 결과 leaf다. 파생 구독이나
  // 통지 구독이 던져도 나머지는 모두 부르고 첫 예외를 마지막에 다시 던진다 - 값은 이미 다 기록됐는데 통지만
  // 건너뛰면 화면이 값을 따라오지 못한다.
  const propagate = (changed: ReadonlySet<LeafIndex>): void => {
    let failed = false;
    let firstError: unknown;
    const onError = (error: unknown): void => {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    };
    for (const leafIndex of runDerives(changed, onError)) {
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

  const subscribeDerive = (leafIndex: LeafIndex, fn: TDeriveSubscriber, resultLeafIndex?: LeafIndex): void => {
    addToSlot(deriveSubscribers, leafIndex, fn);
    if (resultLeafIndex !== undefined) {
      bindDeriveResult(fn, resultLeafIndex);
    }
  };

  const unsubscribeDerive = (leafIndex: LeafIndex, fn: TDeriveSubscriber): void => {
    removeFromSlot(deriveSubscribers, leafIndex, fn);
  };

  const bindDeriveResult = (fn: TDeriveSubscriber, resultLeafIndex: LeafIndex): void => {
    resultLeafOf.set(fn, resultLeafIndex);
  };

  const freeDeriveResult = (fn: TDeriveSubscriber): void => {
    const resultLeaf = resultLeafOf.get(fn);
    if (resultLeaf !== undefined) {
      resultLeafOf.delete(fn);
      free(resultLeaf, 1);
    }
  };

  // 따라잡기는 leaf 하나씩 부르므로 바뀐 leaf를 담는 Set 하나를 비우고 채우며 재사용한다. 가지를 켤 때 행마다
  // Set을 만들면 그 할당이 GC로 드러났다. fn이 끝난 뒤에는 쓰지 않으므로 통지가 이어서 따라잡기를 다시 불러도
  // 안전하다.
  const refreshedLeaf = new Set<LeafIndex>();
  const refreshDerive = (fn: TDeriveSubscriber, leafIndex: LeafIndex): void => {
    refreshedLeaf.clear();
    refreshedLeaf.add(leafIndex);
    const value = fn(refreshedLeaf);
    const resultLeaf = resultLeafOf.get(fn);
    if (resultLeaf !== undefined && leafStore.get(resultLeaf) !== value) {
      write(resultLeaf, value);
      notify(resultLeaf);
    }
  };

  // 값, 구독, 빈 블록 기록, 미룬 통지를 모두 비운다 - 인스턴스를 해체할 때 store가 값과 구독 함수를 놓는다.
  const clear = (): void => {
    leaves.length = 0;
    subscribers.length = 0;
    deriveSubscribers.length = 0;
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
    if (flushLeaves.size === 1) {
      const leafIndex = flushLeaves.values().next().value as LeafIndex;
      const derives = deriveSubscribers[leafIndex];
      if (derives !== undefined) {
        propagateOne(leafIndex, derives, flushLeaves);
        return;
      }
    }
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
    subscribeDerive,
    unsubscribeDerive,
    bindDeriveResult,
    freeDeriveResult,
    refreshDerive,
    clear,
  };
};
