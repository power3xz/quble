// Quble 앱 진입점 조각 - manifest가 가리키는 산출물을 실제 실행에 필요한 형태로 로드한다.
// blueprint 인스턴스화(store/paths)는 호출부가 관리하고, 여기선 manifest -> 핸들러 맵만 담당한다.

/**
 * manifest.handlers가 가리키는 JS를 로드해 fullname -> handler 맵(default export)을 돌려준다.
 * handlers 필드가 없으면 빈 맵. 핸들러 경로는 manifest 기준 상대경로라 base로 해소한다.
 * @param manifest  파싱된 manifest 객체 ({ resources, handlers? })
 * @param base      manifest.handlers 상대경로 해소 기준 URL
 * @returns         fullname -> handler 맵 (핸들러 없으면 {})
 */
export const loadHandlers = async (manifest, base) => {
  if (!manifest.handlers) {
    return {};
  }
  const url = new URL(manifest.handlers, base).href;
  const mod = await import(url);
  return mod.default;
};
