// Quble 클라이언트 상태 저장소 - 중첩 객체의 말단(leaf)마다 안정적 번호(leafIndex)를 붙이고,
// 그 번호로 값을 읽고/쓴다. 그 위에 반응성을 얹는다.
//
// 멘탈 모델: 중첩 트리가 있고 각 말단에 번호표가 붙어있다고 본다 - leafOf(path)가 그 말단의 번호다.
// (구현은 평탄 배열이지만, 다루는 단위는 "트리의 말단"이다.)
//
//   createLeafStore(values)        → { leafOf, get, set }                         (데이터만)
//   createLeafStoreSubject(values) → 위 + { setPath, subscribe, unsubscribe }, set·setPath가 통지  (반응성)
//
// runtime.js의 blueprint가 받는 store가 곧 createLeafStoreSubject의 반환물이다.

type LeafIndex = number;

// 점 표기 경로로 객체를 파고들어 값을 읽는다("a.b.c" → obj.a.b.c).
// 중간 객체가 없으면(예: 아직 안 채운 폼의 user - 초기값이 부분적일 수 있다) undefined를
// 돌려준다. 그 아래 leaf도 undefined이고, payload 조립은 그대로 흘러 껍데기 객체를 만든다.
//
// @param rootValue 뿌리 객체(초기값 - 부분적일 수 있다)
// @param path      점으로 구분된 경로 문자열
// @returns         경로가 가리키는 값(중간이 비면 undefined)
const readPath = (rootValue: unknown, path: string): unknown => {
  let cur = rootValue;
  for (const key of path.split(".")) {
    cur = (cur as Record<string, unknown> | undefined)?.[key];
  }
  return cur;
};

// ── leafStore (데이터만) ─────────────────────────────────────────────
// 중첩 객체의 말단마다 안정적 leafIndex를 발급하고 그 번호로 값을 읽고/쓴다.
// 반응성(구독·통지)은 없다 - createLeafStoreSubject가 위에 얹는다.
//
// leaves 배열은 비공개 - get/set이 유일한 관문이다(외부가 임의 index에 써서 불변식을 깨지 못하게).
//
// @param rootValue 경로 해석의 뿌리 객체(leafOf가 path를 이 객체에서 읽어 초기값 발급)
// @returns         { leafOf, get, set }
const createLeafStore = (rootValue: unknown) => {
  const leaves: unknown[] = [];
  const pathCache = new Map<string, LeafIndex>(); // path → leafIndex

  // path가 가리키는 말단의 안정적 leafIndex. 처음 보는 path면 rootValue에서 값을 읽어 leaf를
  // 발급하고 번호를 고정한다 - 같은 path는 늘 같은 번호.
  const leafOf = (path: string): LeafIndex => {
    let leafIndex = pathCache.get(path);
    if (leafIndex !== undefined) {
      return leafIndex;
    }
    leafIndex = leaves.length;
    leaves[leafIndex] = readPath(rootValue, path);
    pathCache.set(path, leafIndex);
    return leafIndex;
  };

  // leafIndex로 값 읽기. 미설정이면 undefined(JS 기본 - 없는 값은 undefined).
  const get = (leafIndex: LeafIndex): unknown => leaves[leafIndex];

  // leafIndex로 값 쓰기. 통지하지 않는다(순수 저장).
  const set = (leafIndex: LeafIndex, value: unknown): void => {
    leaves[leafIndex] = value;
  };

  return { leafOf, get, set };
};

// ── leafStoreSubject (leafStore + 반응성) ────────────────────────────
// leafStore를 감싸 구독·통지를 얹는다(Subject - 값을 들고 변경을 구독자에게 통지하는 주체).
// leafOf·get은 leafStore에 위임하고, set은 통지하는 버전으로 덮어쓴다. setPath(path로 쓰는
// 진입점)는 통지가 본질이라 여기서만 정의한다 - 통지하는 set을 경유한다.
//
// @param rootValue leafStore에 넘길 뿌리 객체
// @returns         { leafOf, get, set, setPath, subscribe, unsubscribe }
export const createLeafStoreSubject = (rootValue: unknown) => {
  const leafStore = createLeafStore(rootValue);
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

  const setPath = (path: string, value: unknown): void => {
    set(leafStore.leafOf(path), value); // 통지하는 set 경유
  };

  const subscribe = (leafIndex: LeafIndex, fn: (v: unknown) => void): void => {
    (subscribers[leafIndex] ??= new Set()).add(fn);
  };

  const unsubscribe = (leafIndex: LeafIndex, fn: (v: unknown) => void): void => {
    subscribers[leafIndex]?.delete(fn);
  };

  return {
    leafOf: leafStore.leafOf,
    get: leafStore.get,
    set,
    setPath,
    subscribe,
    unsubscribe,
  };
};
