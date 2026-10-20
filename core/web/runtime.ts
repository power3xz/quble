// Quble 클라이언트 런타임 진입점 - .qubb를 두 단계로 인스턴스화한다.
//
//   compile(bytes)  -> blueprintOf(compId) => Blueprint  (def를 청사진으로)
//   Blueprint(store, argumentSourcePairs) -> Instance     (청사진 호출 = 인스턴스화. DOM/구독 생성)
//
// 바이트코드를 훑어 DOM/구독을 짓는 VM은 vm.ts에 있다.

import type { TArrayInfo } from "./array-info.ts";
import { decode, type TModule, type TQubleBytecode } from "./decode.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import { THEN_INDEX } from "./region.ts";
import { RuntimeInterpreter } from "./runtime-interpreter.ts";
import { nodesOf, plantRoot, type THandlers, VM } from "./vm.ts";

// 다른 파일이 runtime.ts에서 가져다 쓰는 이름들.
export { leafCountOf, plantRoot, STORE, swapDeleteAt, type THandlers } from "./vm.ts";

// ── 공개 API ─────────────────────────────────────────────────────────
// qubb 바이트를 디코드해 blueprintOf(compId)를 돌려준다.
//
// 사용: const blueprintOf = compile(bytes);
//       const inst = blueprintOf(0)(rootValue, handlers);
//       root.append(...inst.nodes);
//
// @param bytes  qubb 바이트
// @param resources resId -> URL 매핑(LOAD_RES가 <link>로 삽입). manifest.resources. 없으면 로드 생략.
// @returns      blueprintOf: (compId) => Blueprint
export const compile = (bytes: TQubleBytecode, resources: string[] = []) => {
  const module = decode(bytes);
  // LOAD_RES dedup 집합은 compile 단위 - 이 compile에서 나온 모든 blueprint/인스턴스가 공유하되,
  // 다른 compile(다른 렌더 세션)은 깨끗한 Set으로 시작한다.
  const loadedHrefs = new Set();
  return (compId: number) =>
    (rootValue: unknown, handlers: THandlers = {}) => {
      // @for가 순회하는 배열마다 요소 leaf 위치(entries). 요소 추가/제거 시 참조. free는 빈 칸 인덱스(freelist).
      const arrayPool: Pool<TArrayInfo> = new Pool();
      // rootValue를 루트 props 타입대로 store에 펴 심고(고정부 연속 + 배열 요소는 뒤로), 각 루트
      // 슬롯의 base leafIndex를 rootFlat([STORE, base, ...])으로 얻는다. 배열 요소는 arrayPool에 등록된다.
      const planted = plantRoot(module, rootValue, arrayPool);
      return instantiate(module, resources, loadedHrefs, compId, handlers, planted, arrayPool);
    };
};

// store를 심은 뒤 한 인스턴스를 짓는다. code는 전체 module.code를 그대로 쓰고 pc는 절대 오프셋으로 다룬다 -
// def/자식 구간마다 subarray 뷰를 새로 할당하지 않는다(자식 RENDER가 많으면 그 할당이 누적된다).
export const instantiate = (
  module: TModule,
  resources: string[],
  loadedHrefs: Set<unknown>,
  compId: number,
  handlers: THandlers,
  { leaves, rootFlat }: { leaves: unknown[]; rootFlat: number[] },
  arrayPool: Pool<TArrayInfo>,
) => {
  // rootFlat은 plantRoot가 준 [STORE, base, ...] - 루트 슬롯은 정의상 전부 외부 데이터 바인딩이라 STORE.
  const vm = new VM(module, handlers, resources, loadedHrefs, leaves, arrayPool, rootFlat, new RuntimeInterpreter());
  const { store, regionPool, branchPool } = vm;
  // 루트 anchor 주석은 인스턴스 노드의 맨 앞에 선다.
  const rootRegion = vm.openRootRegion();

  // build: 트리(regionPool/branch.nodes/shownIndex)만 만든다. 루트 직속 노드는 fragment에 모여
  // 루트 가지에 담긴다(자식 region 노드는 아직 안 붙음 - 부모 nodes 오염 방지). 그 뒤
  // attachIf가 루트부터 재귀로 노드를 anchor 뒤에 끼우고 구독을 건다.
  const built = vm.interpretRoot(compId, rootRegion);
  const rootNodes = nodesOf(built);
  branchPool.entries[rootRegion.branchIndices[THEN_INDEX]].nodes = rootNodes;
  // anchor를 루트 노드 앞에 - attach가 anchor.after로 채운다
  const fragment = document.createDocumentFragment();
  fragment.append(rootRegion.anchor, ...rootNodes);
  rootRegion.attach(store, regionPool, branchPool, rootRegion);
  // fragment 자식 전체(anchor + 붙은 트리)가 이 인스턴스의 루트 노드들(append 시 비워지므로 배열로).
  const nodes = Array.from(fragment.childNodes);
  return vm.instanceOf(rootRegion, nodes);
};

// 상태 저장소(store)는 leaf-store.ts가 정의한다. blueprint가 받는 store가 이것 - 편의상 여기서 재공개한다.
export { createLeafStoreSubject };
