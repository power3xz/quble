// Quble 앱 진입점 - 배포된 산출물(qubb + manifest)을 fetch해 브라우저에 마운트한다.
// qubc 컴파일은 빌드가 이미 끝났고, 여기선 qubb 디코드(runtime.compile) + 인스턴스화만 한다.

import { compile, type THandlers } from "./runtime.ts";

type TManifest = {
  resources: string[];
  handlers?: string;
};

/**
 * manifest.handlers가 가리키는 JS를 로드해 fullname -> handler 맵(default export)을 돌려준다.
 * handlers 필드가 없으면 빈 맵. 핸들러 경로는 manifest 기준 상대경로라 base로 해소한다.
 * @param manifest  파싱된 manifest 객체 ({ resources, handlers? })
 * @param base      manifest.handlers 상대경로 해소 기준 URL
 * @returns         fullname -> handler 맵 (핸들러 없으면 {})
 */
export const loadHandlers = async (manifest: TManifest, base: string | URL): Promise<THandlers> => {
  if (!manifest.handlers) {
    return {};
  }
  const url = new URL(manifest.handlers, base).href;
  const mod = await import(url);
  return mod.default;
};

/**
 * 배포된 qubb 앱을 rootEl에 마운트한다. manifest fetch -> qubb 디코드 -> 핸들러 로드 ->
 * 루트(comp 0) 인스턴스화. blueprint가 data를 루트 props 타입 구조대로 store에 펴 심는다(plant).
 * @param qubbUrl  .qubb URL (manifest는 확장자만 .manifest.json으로 바꿔 유도)
 * @param rootEl   마운트 대상 DOM 요소
 * @param data     루트 props 초기값 객체. blueprint가 타입 구조대로 store에 편다.
 * @returns        인스턴스({ nodes, store, ... }) - store로 반응성을 건다.
 */
export const mount = async (qubbUrl: string, rootEl: Element, data: unknown) => {
  const base = new URL(qubbUrl, location.href);
  const manifestUrl = `${qubbUrl.replace(/\.qubb$/, "")}.manifest.json`;
  const manifest: TManifest = await fetch(manifestUrl).then((r) => r.json());

  // manifest만 있으면 qubb fetch와 핸들러 로드는 서로 독립 - 병렬로.
  const [bytesBuf, handlers] = await Promise.all([
    fetch(qubbUrl).then((r) => r.arrayBuffer()),
    loadHandlers(manifest, base),
  ]);

  // 리소스 경로(res/...)를 qubb origin 기준 절대 URL로. LOAD_RES가 <link>로 삽입한다.
  const resources = manifest.resources.map((path) => new URL(path, base).href);
  const blueprintOf = compile(new Uint8Array(bytesBuf), resources);

  // blueprint가 data를 루트 props 타입대로 store에 펴 심고(plant) 인스턴스에 store를 실어 준다.
  const inst = blueprintOf(0)(data, handlers);
  rootEl.replaceChildren(...inst.nodes);
  return inst;
};
