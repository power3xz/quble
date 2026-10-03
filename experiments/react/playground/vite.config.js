import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const at = (path) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  root: at("."),
  plugins: [react()],
  // 셸 핸들러는 core/playground의 것을 상대 경로로 싣는다.
  resolve: { alias: { "quble-react": at("../runtime/index.ts") } },
  // wasm 컴파일러, 데모 소스, 전역 스타일은 playground.sh가 여기로 복사한다.
  publicDir: at("../dist/playground-public"),
  // 진입 스크립트와 셸 핸들러가 최상위 await를 쓴다.
  build: { target: "es2022", outDir: at("../dist/playground-build"), emptyOutDir: true },
});
