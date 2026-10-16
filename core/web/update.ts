// 인스턴스 update - 루트 props를 이름으로 갱신한다. VM의 store/타입/교체 기계를 인자로 받아 호출만
// 하고 VM 상태는 건드리지 않으므로 VM 밖의 함수다.

import type { TModule } from "./decode.ts";

export type TUpdateMode = "replace" | "merge";

// updateRoot가 VM에서 쓰는 것만 담는다 - vm.ts를 import하지 않아 의존이 vm.ts -> update.ts 한 방향이다.
// VM이 구조적으로 만족하며, 메서드 문법이라 VM의 leaf 트리 인자 타입(TLeafObject)과도 맞는다.
type TUpdateTarget = {
  store: { batch(run: () => void): void; set(leafIndex: number, value: unknown): void };
  module: Pick<TModule, "types" | "constpool" | "defs">;
  rootStore(): Record<string, unknown>;
  setObject(leafTree: object, value: unknown): void;
  setArrayElements(leafTree: object, elems: unknown[]): void;
};

// values에 든 키만 갱신한다. 루트는 항상 부분 갱신이고, mode는 객체 값을 어떻게 다룰지만 정한다 -
// replace는 안 준 필드를 undefined로 만들고, merge는 준 필드만 바꾼다. 스칼라는 값을 기록하고, 배열은
// 어떤 요소가 어떻게 바뀌었는지 모르니 mode와 상관없이 통째로 교체한다.
//
// 한 번의 batch 안에서 기록해 구독자 통지를 모은다. 루트에 없는 이름은 이름을 담은 예외를 throw하고,
// 이미 기록한 앞선 키는 되돌리지 않는다.
export const updateRoot = (target: TUpdateTarget, values: Record<string, unknown>, mode: TUpdateMode): void => {
  target.store.batch(() => {
    applyFields(target, target.rootStore(), target.module.defs[0].propsTypeRef, values, mode);
  });
};

// subTree(typeRef 객체의 leaf 트리)의 필드 중 values에 든 것만 갱신한다. 루트에서는 rootStore() 전체고,
// 객체 필드로 내려가면 그 필드의 부분이다. props가 { title, user: { name, age }, tags }면 이런 모양이다.
//   rootStore()  = { title: 0, user: { name: 1, age: 2 }, tags: <배열 노드, 배열 leaf 3> }
//   user의 subTree = { name: 1, age: 2 }   (NODE_BASE/NODE_TYPE 심볼 키도 얹혀 있다)
const applyFields = (
  target: TUpdateTarget,
  subTree: Record<string, unknown>,
  typeRef: number,
  values: Record<string, unknown>,
  mode: TUpdateMode,
): void => {
  const type = target.module.types[typeRef];
  if (type.tag !== "object") {
    return;
  }
  const typeRefOf = new Map<string, number>();
  for (const [nameConstIndex, fieldTypeRef] of type.fields) {
    typeRefOf.set(target.module.constpool[nameConstIndex] as string, fieldTypeRef);
  }
  // 하나라도 없으면 쓰기 전에 알린다 - 이 객체 안에서는 일부만 기록된 채 남지 않는다.
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(subTree, key)) {
      throw new Error(`prop '${key}' 없음`);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    applyField(target, subTree[key], typeRefOf.get(key) as number, value, mode);
  }
};

// leafSlot은 스칼라면 leafIndex 숫자, 배열이나 객체면 그 leaf 트리다.
const applyField = (
  target: TUpdateTarget,
  leafSlot: unknown,
  typeRef: number,
  value: unknown,
  mode: TUpdateMode,
): void => {
  const type = target.module.types[typeRef];
  if (type.tag === "array") {
    target.setArrayElements(leafSlot as object, value as unknown[]);
  } else if (type.tag === "object") {
    if (mode === "replace") {
      target.setObject(leafSlot as object, value);
    } else {
      applyFields(target, leafSlot as Record<string, unknown>, typeRef, value as Record<string, unknown>, mode);
    }
  } else {
    target.store.set(leafSlot as number, value);
  }
};
