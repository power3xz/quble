// x.qubc.d.ts의 핸들러 맵(THandlers)에서 props와 핸들러 컨텍스트의 update 타입을 파생한다.
// 컴파일러가 내는 leaf 타입에는 브랜드(__leaf, __obj, __arr)가 붙어 있어 값 타입으로 되돌릴 수 있다.

import type { THandlers } from "../../../core/web/runtime-entry.ts";

// leaf 트리의 한 자리를 값 타입으로 되돌린다. partial이면 객체는 필드를 다 안 적어도 된다.
type TLeafValue<TLeaf, TPartial extends boolean> = TLeaf extends { readonly __leaf: infer TValue }
  ? TValue
  : TLeaf extends { readonly __arr: infer TElement }
    ? TElement[]
    : TLeaf extends { readonly __obj: infer TObject }
      ? TPartial extends true
        ? Partial<TObject>
        : TObject
      : never;

// 핸들러의 params.store 타입 - 트리 전체에서 루트 하나라 어느 핸들러에서 꺼내도 같다. 핸들러가 없으면 never다.
type TStoreOf<THandlerMap> = {
  [K in keyof THandlerMap]: THandlerMap[K] extends (data: never, params: infer TParams) => unknown
    ? TParams extends { store: infer TStore }
      ? TStore
      : never
    : never;
}[keyof THandlerMap];

type TUpdateMode = "replace" | "merge";

// update(values)가 받는 값 - 루트 props 중 바꿀 것만.
export type TUpdateValues<TStore> = { [K in keyof TStore]?: TLeafValue<TStore[K], true> };

// 컴포넌트가 받는 props - 루트 props 전부. 핸들러가 하나도 없으면 루트 props를 알 수 없어 느슨하게 둔다.
export type TRootProps<THandlerMap> = [TStoreOf<THandlerMap>] extends [never]
  ? Record<string, unknown>
  : { [K in keyof TStoreOf<THandlerMap>]: TLeafValue<TStoreOf<THandlerMap>[K], false> };

// 컴포넌트의 props 전체 - 루트 props와 예약 prop handlers. 핸들러 맵 타입을 모르는 바이트코드(unknown)는
// 키와 컨텍스트를 느슨하게 받는다.
export type TComponentProps<THandlerMap> = TRootProps<THandlerMap> & {
  handlers?: [unknown] extends [THandlerMap] ? THandlers : Partial<TWithUpdate<THandlerMap>>;
};

// 각 핸들러의 params에 update를 얹는다.
export type TWithUpdate<THandlerMap> = {
  [K in keyof THandlerMap]: THandlerMap[K] extends (data: infer TData, params: infer TParams) => infer TReturn
    ? (
        data: TData,
        params: TParams & { update: (values: TUpdateValues<TStoreOf<THandlerMap>>, mode?: TUpdateMode) => void },
      ) => TReturn
    : never;
};
