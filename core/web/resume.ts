// SSR이 그린 DOM을 이어받는(resume) 진입점. 인터프리터는 runtime.ts의 것을 그대로 쓰고, 노드를 새로
// 만들던 자리에 SSR 노드를 꺼내 주는 TNodeSource만 바꿔 끼운다. CSR만 쓰는 번들은 이 파일을 싣지 않는다.

import { decode, type TField, type TModule } from "./decode.ts";
import { Pool } from "./pool-allocator.ts";
import { appendArrayInfo, type TArrayInfo } from "./region.ts";
import { ResumeCursor } from "./resume-cursor.ts";
import { instantiate, leafCountOf, plantRoot, STORE, type THandlers, type TNodeSource } from "./runtime.ts";

// quble-ssr --snapshot(Rust plant_root의 직렬화)이 낸 store. plantRoot가 만드는 leaves와 같다.
//   leaves  store 배열. JSON에 undefined가 없어 그 자리는 null이고 undef에 인덱스가 적혀 있다.
//   arrays  arrayInfoIndex 순서의 [요소 타입, 첫 요소 시작 leafIndex, 요소 수]. 한 배열의 요소는 연속이다.
export type TLeafSnapshot = {
  leaves: unknown[];
  undef: number[];
  arrays: [elemTypeRef: number, start: number, count: number][];
};

// 스냅샷을 plantRoot 대신 store에 넣는다. 반환은 plantRoot와 같다 - leaves와 rootFlat([STORE, base, ...]).
// 루트 prop의 base는 앞 prop들의 고정 칸 수의 합이라 타입에서 구한다. arrayPool은 빈 것이어야 한다
// (appendArrayInfo가 0부터 매기는 arrayInfoIndex가 스냅샷의 배열 순서와 같다).
export const adoptSnapshot = (module: TModule, snapshot: TLeafSnapshot, arrayPool: Pool<TArrayInfo>) => {
  const { leaves, undef, arrays } = snapshot;
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

// SSR 페이지가 head에 이미 넣은 리소스 - <link href>, 또는 인라인한 <style data-qb-href>.
const inHead = (url: string): boolean =>
  [...document.head.querySelectorAll("link, style[data-qb-href]")].some(
    (el) => (el.getAttribute("href") ?? el.getAttribute("data-qb-href")) === url,
  );

const resumeNodeSource = (cursor: ResumeCursor): TNodeSource => ({
  reuses: true,
  element: cursor.element,
  text: () => cursor.text(),
  anchor: cursor.anchor,
  hasResource: inHead,
  finish: cursor.finish,
});

// compile과 같은 모양이다. 인스턴스를 만들 때 options.resumeFrom(SSR이 그린 노드들의 부모)의 노드를
// 새로 만들지 않고 이어받는다. 반환한 nodes가 바로 그 노드들이다.
// options.snapshot - quble-ssr --snapshot이 낸 store. 주면 plantRoot 없이 그것으로 시작하고 rootValue는 안 본다.
// 없으면 rootValue로 plantRoot를 하며, 그 값은 SSR에 넘긴 data와 같아야 한다.
export const resume = (bytes: Uint8Array, resources: string[] = []) => {
  const module = decode(bytes);
  const loadedHrefs = new Set();
  return (compId: number) =>
    (rootValue: unknown, handlers: THandlers, options: { resumeFrom: Node; snapshot?: TLeafSnapshot }) => {
      const arrayPool: Pool<TArrayInfo> = new Pool();
      const planted = options.snapshot
        ? adoptSnapshot(module, options.snapshot, arrayPool)
        : plantRoot(module, rootValue, arrayPool);
      return instantiate(
        module,
        resources,
        loadedHrefs,
        compId,
        handlers,
        planted,
        arrayPool,
        resumeNodeSource(new ResumeCursor(options.resumeFrom)),
      );
    };
};
