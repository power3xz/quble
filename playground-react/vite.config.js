import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // 셸 핸들러(core/playground)와 React 런타임(core/react)을 레포에서 그대로 싣는다. 그 파일들의
  // react import가 레포 루트의 react로 풀리면 React가 두 벌 실려 hook이 깨지므로 이 앱의 것 하나로 모은다.
  resolve: {
    alias: {
      "quble-react": new URL("../core/react/index.ts", import.meta.url).pathname,
    },
    dedupe: ["react", "react-dom"],
  },
  // 진입 스크립트와 셸 핸들러가 최상위 await를 쓴다.
  build: { target: "es2022" },
});
