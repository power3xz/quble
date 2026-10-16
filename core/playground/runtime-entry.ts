// 플레이그라운드 런타임 번들(quble-runtime.js)의 진입점. 셸은 SSR을 resume으로 이어받고, 핸들러 번들이
// runtime.ts에서 가져오는 compile(사용자 미리보기의 CSR)은 이 번들 것을 쓴다.

export { loadHandlers, loadManifest, resume } from "../web/resume-entry.ts";
export { compile } from "../web/runtime.ts";
