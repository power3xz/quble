import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

export default {
  base: "/svelte/",
  plugins: [svelte()],
  build: {
    minify: "esbuild",
    rollupOptions: {
      // 범용 부트(_boot). views/<Name>.svelte를 동적 import → /svelte/<Name>로 라우팅.
      input: { _boot: resolve(__dirname, "src/_boot.js") },
      // 해시 없는 고정 파일명 — 서버가 경로를 직접 안다.
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
};
