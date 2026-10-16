// 두 진입점(runtime-entry.ts, resume-entry.ts)이 함께 쓰는 manifest 로드.

import type { TManifest } from "./load-handlers.ts";

/**
 * manifest를 돌려준다. 페이지가 HTML에 심어 둔 값이 있으면 요청 없이 그것을 쓰고, 없으면 fetch한다.
 * 심는 쪽: `globalThis.__qubleManifests = { "./app.manifest.json": { resources: [], handlers: "h.js" } }`
 * (`__quble`은 마운트한 인스턴스를 담는 전역이라 쓰지 않는다)
 * @param manifestUrl  manifest URL. 심어 둔 값의 키와 글자 그대로 같아야 쓴다
 * @returns            파싱된 manifest 객체 ({ resources, handlers? })
 */
export const loadManifest = async (manifestUrl: string): Promise<TManifest> => {
  const inlined = (globalThis as { __qubleManifests?: Record<string, TManifest> }).__qubleManifests?.[manifestUrl];
  return inlined ?? (await fetch(manifestUrl).then((r) => r.json()));
};
