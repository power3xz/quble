import { svelte } from "@sveltejs/vite-plugin-svelte";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), svelte()],
  // quble 페이지는 레포의 런타임을 그대로 싣는다.
  resolve: { alias: { "@quble-web": new URL("../core/web", import.meta.url).pathname } },
  build: {
    // 대상마다 번들이 따로 나오게 페이지를 각각 진입점으로 둔다. 공유 청크(harness)는 모든 대상이 같이 받는다.
    rollupOptions: {
      input: {
        index: "index.html",
        quble: "quble.html",
        "quble-deep": "quble-deep.html",
        react: "react.html",
        "react-deep": "react-deep.html",
        "react-memo": "react-memo.html",
        "react-memo-deep": "react-memo-deep.html",
        svelte: "svelte.html",
        "svelte-deep": "svelte-deep.html",
      },
    },
  },
});
