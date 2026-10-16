// SSR이 그린 DOM에 resume하는 진입점. 첫 그리기는 resume-interpreter.ts의 ResumeInterpreter가 하고,
// 그 뒤의 lazy build와 @for grow는 runtime-interpreter.ts의 RuntimeInterpreter가 한다. 둘은 서로를
// 모르고 VM의 interpreter 필드에 번갈아 끼워진다. CSR만 쓰는 번들은 이 파일을 싣지 않는다.

import { decode, type TField, type TModule, type TQubleBytecode } from "./decode.ts";
import { Pool } from "./pool-allocator.ts";
import { appendArrayInfo, type TArrayInfo, THEN_INDEX } from "./region.ts";
import { ResumeInterpreter } from "./resume-interpreter.ts";
import { RuntimeInterpreter } from "./runtime-interpreter.ts";
import { leafCountOf, nodesOf, plantRoot, STORE, type THandlers, VM } from "./vm.ts";

// quble-ssr --flat-data(Rust plant_root의 직렬화)이 낸 store. plantRoot가 만드는 leaves와 같다.
//   leaves  store 배열. JSON에 undefined가 없어 그 자리는 null이고 undef에 인덱스가 적혀 있다.
//   arrays  arrayInfoIndex 순서의 [요소 타입, 첫 요소 시작 leafIndex, 요소 수]. 한 배열의 요소는 연속이다.
export type TFlatData = {
  leaves: unknown[];
  undef: number[];
  arrays: [elemTypeRef: number, start: number, count: number][];
};

// 펴진 데이터를 plantRoot 대신 store에 넣는다. 반환은 plantRoot와 같다 - leaves와 rootFlat([STORE, base, ...]).
// 루트 prop의 base는 앞 prop들의 고정 칸 수의 합이라 타입에서 구한다. arrayPool은 빈 것이어야 한다
// (appendArrayInfo가 0부터 매기는 arrayInfoIndex가 펴진 데이터의 배열 순서와 같다).
export const adoptFlatData = (module: TModule, flatData: TFlatData, arrayPool: Pool<TArrayInfo>) => {
  const { leaves, undef, arrays } = flatData;
  for (const i of undef) {
    leaves[i] = undefined;
  }
  for (const [elemTypeRef, start, count] of arrays) {
    const elemSize = leafCountOf(module, elemTypeRef);
    const info = arrayPool.entries[appendArrayInfo(arrayPool, elemSize, elemTypeRef)];
    for (let k = 0; k < count; k++) {
      info.elemStartLeafIndices.push(start + k * elemSize);
    }
  }
  const rootType = module.types[module.defs[0].propsTypeRef] as { fields: TField[] };
  const rootFlat: number[] = [];
  let base = 0;
  for (const [, childTypeRef] of rootType.fields) {
    rootFlat.push(STORE, base);
    base += leafCountOf(module, childTypeRef);
  }
  return { leaves, rootFlat };
};

// store를 심은 뒤 SSR 노드를 이어서 한 인스턴스를 만든다. root의 자식들이 SSR이 그린 노드들이다.
// 반환은 runtime.ts의 instantiate와 같고, nodes가 바로 그 SSR 노드들이다. 첫 그리기를 마치면 VM의
// 해석기를 RuntimeInterpreter로 바꿔, 그 뒤의 lazy build와 @for grow가 노드를 새로 만들게 한다.
const instantiate = (
  module: TModule,
  resources: string[],
  loadedHrefs: Set<unknown>,
  compId: number,
  handlers: THandlers,
  { leaves, rootFlat }: { leaves: unknown[]; rootFlat: number[] },
  arrayPool: Pool<TArrayInfo>,
  root: Node,
) => {
  const resumeInterpreter = new ResumeInterpreter(module.code, root);
  const vm = new VM(module, handlers, resources, loadedHrefs, leaves, arrayPool, rootFlat, resumeInterpreter);
  const { store, regionPool, branchPool } = vm;
  const rootRegion = vm.openRootRegion(resumeInterpreter.anchor());

  const built = vm.interpretRoot(compId, rootRegion);
  resumeInterpreter.finish();
  vm.interpreter = new RuntimeInterpreter();
  branchPool.entries[rootRegion.branchIndices[THEN_INDEX]].nodes = nodesOf(built);
  rootRegion.attach(store, regionPool, branchPool, rootRegion);
  // 붙인 뒤 root 아래가 이 인스턴스의 루트 노드들이다(앵커 + 붙은 트리).
  const nodes = Array.from(root.childNodes) as ChildNode[];
  return vm.instanceOf(rootRegion, nodes);
};

// compile과 같은 모양이다. 인스턴스를 만들 때 options.resumeFrom(SSR이 그린 노드들의 부모)의 노드를
// 새로 만들지 않고 resume한다. 반환한 nodes가 바로 그 노드들이다.
// options.flatData - quble-ssr --flat-data가 낸 store. 주면 plantRoot 없이 그것으로 시작하고 rootValue는 안 본다.
// 없으면 rootValue로 plantRoot를 하며, 그 값은 SSR에 넘긴 data와 같아야 한다.
export const resume = (bytes: TQubleBytecode, resources: string[] = []) => {
  const module = decode(bytes);
  const loadedHrefs = new Set();
  return (compId: number) =>
    (rootValue: unknown, handlers: THandlers, options: { resumeFrom: Node; flatData?: TFlatData }) => {
      const arrayPool: Pool<TArrayInfo> = new Pool();
      const planted = options.flatData
        ? adoptFlatData(module, options.flatData, arrayPool)
        : plantRoot(module, rootValue, arrayPool);
      return instantiate(module, resources, loadedHrefs, compId, handlers, planted, arrayPool, options.resumeFrom);
    };
};
