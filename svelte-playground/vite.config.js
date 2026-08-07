import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// 이 파일 기준 상대경로 -> 절대경로.
const pathOf = (p) => fileURLToPath(new URL(p, import.meta.url));

// demo 소스(.qubc/.css/.json)는 core/playground/demo에 있고 그대로 fetch한다 - 복사본을 두면
// 원본이 바뀔 때 갈라진다. publicDir로 걸어 개발 서버가 그 디렉터리를 그대로 서빙하게 한다.
// 포트는 svelte-playground.sh가 정한다 - 빌드한 dist를 정적 서버로 띄운다.
export default defineConfig({
  plugins: [svelte()],
  publicDir: "../core/playground/demo",
  resolve: {
    // 워크스페이스 밖이라 node_modules로 안 걸린다 - 원본을 직접 가리킨다.
    alias: {
      "quble-wasm-compiler/browser.ts": pathOf("../core/wasm-compiler/browser.ts"),
    },
  },
  // core/ 아래(런타임/컴파일러/wasm)를 dev 서버가 읽어야 한다.
  server: { fs: { allow: [pathOf("."), pathOf("../core")] } },
});
