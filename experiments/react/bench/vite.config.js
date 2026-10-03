import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const at = (path) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  root: at("."),
  plugins: [react()],
  resolve: { alias: { "quble-react": at("../runtime/index.ts") } },
  // 데이터(data-<N>.json)는 bench-expr.sh가 bench-expr/public에 만든 것을 그대로 쓴다.
  publicDir: at("../../../bench-expr/public"),
  build: { outDir: at("../dist/bench-build"), emptyOutDir: true },
});
