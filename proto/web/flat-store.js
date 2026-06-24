// Quble 클라이언트 상태 저장소 — 중첩 입력을 평탄한 leaf 배열로 펼쳐 보관하고, 그 위에 반응성을 얹는다.
//
//   createFlatStore(values)        → { resolve, get, set, setPath }              (데이터만)
//   createFlatStoreSubject(values) → 위 + { subscribe, unsubscribe }, set·setPath가 통지  (반응성)
//
// runtime.js의 blueprint가 받는 ctx가 곧 createFlatStoreSubject의 반환물이다.

// 점 표기 경로로 객체를 파고들어 값을 읽는다("a.b.c" → obj.a.b.c).
//
// @param defaultValue 뿌리 객체
// @param path         점으로 구분된 경로 문자열
// @returns            경로가 가리키는 값
const readPath = (defaultValue, path) => {
  let cur = defaultValue;
  for (const key of path.split(".")) {
    cur = cur[key];
  }
  return cur;
};

// ── flatStore (데이터만) ─────────────────────────────────────────────
// 중첩 입력을 평탄한 leaf 배열로 펼쳐 보관한다 — path를 안정적 leafIndex로 발급하고
// 그 index로 값을 읽고/쓴다. 반응성(구독·통지)은 없다 — createFlatStoreSubject가 위에 얹는다.
//
// leaves 배열은 비공개 — get/set이 유일한 관문이다(외부가 임의 index에 써서 불변식을 깨지 못하게).
//
// @param rootValue 경로 해석의 뿌리 객체(resolve가 path를 이 객체에서 읽어 초기값 발급)
// @returns         { resolve, get, set, setPath }
const createFlatStore = (rootValue) => {
  const leaves = [];
  const pathCache = new Map(); // path → leafIndex

  // path를 안정적 leafIndex로. 처음 보는 path면 rootValue에서 값을 읽어 leaf를 발급하고
  // index를 고정한다 — 같은 path는 늘 같은 index.
  const resolve = (path) => {
    let leafIndex = pathCache.get(path);
    if (leafIndex !== undefined) {
      return leafIndex;
    }
    leafIndex = leaves.length;
    leaves[leafIndex] = readPath(rootValue, path);
    pathCache.set(path, leafIndex);
    return leafIndex;
  };

  // leafIndex로 값 읽기. 미설정이면 undefined(JS 기본 — 없는 값은 undefined).
  const get = (leafIndex) => leaves[leafIndex];

  // leafIndex로 값 쓰기. 통지하지 않는다(순수 저장).
  const set = (leafIndex, value) => {
    leaves[leafIndex] = value;
  };

  // path로 바로 쓰기 — set(resolve(path), value)의 진입점.
  const setPath = (path, value) => {
    set(resolve(path), value);
  };

  return { resolve, get, set, setPath };
};

// ── flatStoreSubject (flatStore + 반응성) ────────────────────────────
// flatStore를 감싸 구독·통지를 얹는다(Subject — 값을 들고 변경을 구독자에게 통지하는 주체).
// resolve·get은 flatStore에 위임하고, set·setPath는 통지하는 버전으로 덮어쓴다.
//
// @param rootValue flatStore에 넘길 뿌리 객체
// @returns         { resolve, get, set, setPath, subscribe, unsubscribe }
export const createFlatStoreSubject = (rootValue) => {
  const flat = createFlatStore(rootValue);
  const subscribers = []; // leafIndex → Set<(v)=>void>. Set이라 unsubscribe가 O(1).

  const set = (leafIndex, value) => {
    flat.set(leafIndex, value);
    const subs = subscribers[leafIndex];
    if (subs) {
      // 스냅샷 순회 — 콜백(cond)이 activateBranch로 구독을 해제할 수 있어 원본 순회는 깨진다.
      for (const fn of [...subs]) {
        fn(value);
      }
    }
  };

  const setPath = (path, value) => {
    set(flat.resolve(path), value); // 통지하는 set 경유
  };

  const subscribe = (leafIndex, fn) => {
    (subscribers[leafIndex] ??= new Set()).add(fn);
  };

  const unsubscribe = (leafIndex, fn) => {
    subscribers[leafIndex]?.delete(fn);
  };

  return { resolve: flat.resolve, get: flat.get, set, setPath, subscribe, unsubscribe };
};
