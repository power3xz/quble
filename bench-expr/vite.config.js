import { svelte } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), svelte()],
  // quble 페이지는 레포의 런타임을 그대로 싣는다.
  // canvas 데모는 레포의 실험 코드(experiments/)도 싣는다.
  // quble -> React 페이지는 레포의 React 런타임(core/react)을 싣는다. 그 런타임의 react import가
  // 레포 루트의 react로 풀리면 React가 두 벌 실려 hook이 깨지므로, react는 이 앱의 것 하나로 모은다.
  resolve: {
    alias: {
      "@quble-web": new URL("../core/web", import.meta.url).pathname,
      "@experiments": new URL("../experiments", import.meta.url).pathname,
      "quble-react": new URL("../core/react/index.ts", import.meta.url).pathname,
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    // 대상마다 번들이 따로 나오게 페이지를 각각 진입점으로 둔다. 공유 청크(harness)는 모든 대상이 같이 받는다.
    rollupOptions: {
      input: {
        index: "index.html",
        quble: "quble.html",
        "quble-react": "quble-react.html",
        react: "react.html",
        "react-memo": "react-memo.html",
        svelte: "svelte.html",
        // canvas 렌더 실험(experiments/canvas). 비교 표의 대상이 아니라 따로 여는 데모다.
        canvas: "canvas.html",
      },
    },
  },
  // canvas 실험의 Worker가 모듈을 import한다.
  worker: { format: "es" },
});
