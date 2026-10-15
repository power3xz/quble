// Quble 앱 SSR 진입점 - SSR이 그린 DOM을 이어받는다. CSR 진입점(runtime-entry.ts)과 서로 의존하지 않는다.
// 이 진입점은 SSR 프리뷰와 playground 번들에 실린다.

import { resume as resumeBlueprint, type TLeafSnapshot } from "./resume.ts";
import type { THandlers } from "./runtime.ts";

export { loadHandlers } from "./load-handlers.ts";

type TMountOptions = {
  snapshot?: TLeafSnapshot;
  data?: unknown;
  handlers?: THandlers;
  resources?: string[];
};

/**
 * resumeFrom 아래의 SSR 노드를 새로 만들지 않고 이어받는다. fetch 없이 동기로 돈다. 루트(comp 0)를
 * 인스턴스화하며, 초기 상태는 snapshot(quble-ssr --snapshot이 낸 store)이 있으면 그것으로, 없으면
 * data를 루트 props 타입 구조대로 store에 펴 심어(plant) 시작한다. data는 SSR에 넘긴 것과 같아야 한다.
 * @param bytes       qubb 바이트
 * @param resumeFrom  SSR이 그린 노드들의 부모. 안에 그 노드들만 있어야 한다.
 * @param options     snapshot 또는 data 중 하나, handlers 핸들러 맵(없으면 {}), resources LOAD_RES가 <link>로 삽입할 절대 URL(없으면 로드 생략)
 * @returns           인스턴스({ nodes, store, destroy, ... }) - nodes가 바로 그 SSR 노드들이다.
 */
export const resume = (
  bytes: Uint8Array,
  resumeFrom: ParentNode & Node,
  { snapshot, data, handlers = {}, resources = [] }: TMountOptions,
) => {
  const inst = resumeBlueprint(bytes, resources)(0)(data, handlers, { resumeFrom, snapshot });
  resumeFrom.replaceChildren(...inst.nodes);
  return inst;
};
