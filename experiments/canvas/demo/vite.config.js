import { defineConfig } from "vite";

const at = (path) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  root: at("."),
  // orders.qubb와 데이터(data-<N>.json)는 demo.sh가 bench-expr/public에 만든다.
  publicDir: at("../../../bench-expr/public"),
  build: { outDir: at("../dist/demo-build"), emptyOutDir: true },
  // Worker가 모듈을 import한다.
  worker: { format: "es" },
});
