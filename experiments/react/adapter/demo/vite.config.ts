import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { quble } from "../vite-plugin.ts";

// quble/react는 어댑터 소스를 가리킨다(배포하면 패키지의 ./react 진입점이 된다).
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), quble()],
  resolve: { alias: { "quble/react": new URL("../react.ts", import.meta.url).pathname } },
  // core/web과 core/wasm-compiler는 이 디렉터리 밖이다.
  server: { fs: { allow: [new URL("../../../..", import.meta.url).pathname] } },
});
