// 두 진입점(runtime-entry.ts, resume-entry.ts)이 함께 쓰는 manifest 타입과 핸들러 로드.

export type TManifest = {
  resources: string[];
  handlers?: string;
};

/**
 * manifest.handlers가 가리키는 JS를 로드해 fullname -> handler 맵(handlers export)을 돌려준다.
 * handlers 필드가 없으면 빈 맵. 핸들러 경로는 manifest 기준 상대경로라 base로 해소한다.
 * @param manifest  파싱된 manifest 객체 ({ resources, handlers? })
 * @param base      manifest.handlers 상대경로 해소 기준 URL
 * @returns         fullname -> handler 맵 (핸들러 없으면 {}). 맵의 타입 T는 호출자가 정한다.
 */
export const loadHandlers = async <T>(manifest: TManifest, base: string | URL): Promise<T> => {
  if (!manifest.handlers) {
    return {} as T;
  }
  const url = new URL(manifest.handlers, base).href;
  const mod = await import(url);
  return mod.handlers;
};
