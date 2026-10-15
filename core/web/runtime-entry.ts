// Quble 앱 CSR 진입점 -배포된 산출물(qubb + manifest)을 fetch해 브라우저에 마운트한다.
// qubc 컴파일은 빌드가 이미 끝났고, 여기선 qubb 디코드(runtime.compile) + 인스턴스화만 한다.

import { loadHandlers, type TManifest } from "./load-handlers.ts";
import { compile, type THandlers } from "./runtime.ts";

// 이 번들이 런타임을 통째로 담으므로 compile도 함께 내보낸다 - 바이트코드를 이미 손에 든 쪽은
// mount의 fetch 단계 없이 이것만 있으면 된다.
export { compile, type THandlers } from "./runtime.ts";
export { loadHandlers } from "./load-handlers.ts";

type TMountOptions = {
  data: unknown;
  handlers?: THandlers;
  resources?: string[];
};

/**
 * 바이트코드를 container에 마운트한다. fetch 없이 동기로 돈다 - 바이트코드를 어떻게 얻었는지(번들에 실림,
 * 직접 fetch)는 호출자의 몫이다. 루트(comp 0)를 인스턴스화하며, data를 루트 props 타입 구조대로 store에
 * 펴 심고(plant) container의 기존 자식을 인스턴스 노드로 바꾼다.
 * @param bytes      qubb 바이트
 * @param container  마운트 대상 DOM 요소
 * @param options    data 루트 props 초기값 객체, handlers 핸들러 맵(없으면 {}), resources LOAD_RES가 <link>로 삽입할 절대 URL(없으면 로드 생략)
 * @returns          인스턴스({ nodes, store, destroy, ... }) - store로 반응성을 건다.
 */
export const mount = (
  bytes: Uint8Array,
  container: Element,
  { data, handlers = {}, resources = [] }: TMountOptions,
) => {
  const inst = compile(bytes, resources)(0)(data, handlers);
  container.replaceChildren(...inst.nodes);
  return inst;
};

/**
 * 배포된 qubb 앱을 rootEl에 마운트한다. manifest fetch -> qubb 디코드 -> 핸들러 로드 -> mount.
 * @param qubbUrl  .qubb URL (manifest는 확장자만 .manifest.json으로 바꿔 유도)
 * @param rootEl   마운트 대상 DOM 요소
 * @param data     루트 props 초기값 객체
 * @returns        인스턴스({ nodes, store, ... }) - store로 반응성을 건다.
 */
export const mountFromUrl = async (qubbUrl: string, rootEl: Element, data: unknown) => {
  const base = new URL(qubbUrl, location.href);
  const manifestUrl = `${qubbUrl.replace(/\.qubb$/, "")}.manifest.json`;
  const manifest: TManifest = await fetch(manifestUrl).then((r) => r.json());

  // manifest만 있으면 qubb fetch와 핸들러 로드는 서로 독립 - 병렬로.
  const [bytesBuf, handlers] = await Promise.all([
    fetch(qubbUrl).then((r) => r.arrayBuffer()),
    loadHandlers<THandlers>(manifest, base),
  ]);

  // 리소스 경로(res/...)를 qubb origin 기준 절대 URL로. LOAD_RES가 <link>로 삽입한다.
  const resources = manifest.resources.map((path) => new URL(path, base).href);
  return mount(new Uint8Array(bytesBuf), rootEl, { data, handlers, resources });
};
