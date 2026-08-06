// 핸들러 d.ts 서두 - dts.rs가 include_str!로 싣고 그 뒤에 컴포넌트별 props 타입과 THandlers를
// 이어 붙인다. 여기 있는 것은 fullname마다 달라지지 않는 공통 타입뿐이다.
//
// 이 파일은 tsc의 include 밖이라(루트 tsconfig는 core/crates를 안 본다) 단독으로 검사되지 않는다.
// 유효한 TS인지는 core/wasm-compiler/dts-types.test.ts가 실제 산출물을 tsc에 걸어 확인한다.

// leaf 한 칸의 주소. 값이 아니라 주소기라 get(k)가 값을 내주고 set(k, v)가 받는다(REACTIVITY.md #7.1).
type TLeafIndex<T> = number & { readonly __leaf: T };

// 객체 노드 - 여러 leaf의 묶음이라 leafIndex 한 칸으로 못 가리킨다. setObject의 대상이다.
//
// 값 타입 T만 받아 필드로 내려가는 길을 자기가 파생한다 - 컴파일러가 두 모양(leafIndex 트리 + 값)을
// 따로 내면 중첩마다 안쪽이 바깥에 다시 실려 텍스트가 제곱으로 분다.
//
// 배열을 먼저 걸러야 한다 - JS에서 배열도 object라 순서가 뒤집히면 배열 칸이 노드로 파생돼
// push/removeAt 대상이 못 된다.
type TLeafObject<T> = { readonly __obj: T } & {
  [K in keyof T]: T[K] extends unknown[]
    ? TLeafIndex<T[K]>
    : T[K] extends object
      ? TLeafObject<T[K]>
      : TLeafIndex<T[K]>;
};

// 핸들러 하나의 모양(params 배치, 조작 함수). 각 fullname은 자기 TData/TProps/TCtx/TLoopIndices/
// TStore를 채운다. TLoopIndices는 @for 회차 인덱스들이다({ $0: number; ... }).
//
// TStore는 트리 전체에서 루트 하나라 모든 시그니처가 같은 이름을 채운다. 그래도 제네릭 자리에 두는
// 이유 - params의 다른 넷이 다 제네릭인데 store만 본문에 박으면 무엇이 채워지는지가 시그니처에서
// 안 보인다.
//
// 배열 조작(push/removeAt/replace)은 대상이 배열 leaf여야 한다 - TLeafIndex<TElement[]>로 받아
// 배열 아닌 leaf를 넘기면 타입에서 걸리고, 요소 타입도 함께 맞춘다. removeAt은 요소 타입을 안
// 쓰므로 제네릭 없이 unknown[]으로 둔다.
//
// setObject는 객체 노드 하나를 값으로 갈아끼운다 - leaf 한 칸을 쓰는 set과 대상이 달라 오버로드하지
// 않고 이름을 나눈다. 값이 Partial<T>인데도 병합이 아니라 교체다 - 안 준 필드는 undefined가 된다
// (obj = {..} 대입과 같은 뜻).
//
// 제네릭 이름을 자리별로 나눈 이유 - get의 것은 leaf가 담은 값(TValue)이고 push의 것은 그 배열의
// 요소(TElement)라 뜻이 다르다. 한 이름으로 두면 나란히 놓였을 때 같은 것으로 읽힌다.
//
// 반환이 void | Promise<void>인 이유 - 런타임은 반환값을 await하지 않지만(그래서 async 핸들러의
// 실패는 조용히 사라진다), 핸들러를 받아 감싸는 쪽이 그 Promise를 잡아 건질 수 있어야 한다.
type THandler<TData, TProps, TCtx, TLoopIndices, TStore> = (
  data: TData,
  params: {
    context: TCtx;
    props: TProps;
    event: Event;
    store: TStore;
    get: <TValue>(k: TLeafIndex<TValue>) => TValue;
    set: <TValue>(k: TLeafIndex<TValue>, v: TValue) => void;
    setObject: <TValue>(k: TLeafObject<TValue>, v: Partial<TValue>) => void;
    push: <TElement>(k: TLeafIndex<TElement[]>, v: TElement) => void;
    removeAt: (k: TLeafIndex<unknown[]>, i: number) => void;
    replace: <TElement>(k: TLeafIndex<TElement[]>, v: TElement[]) => void;
  } & TLoopIndices,
) => void | Promise<void>;
