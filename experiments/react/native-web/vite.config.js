import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const at = (path) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  root: at("."),
  plugins: [react()],
  // 산출 TSX가 `react-native`를 import한다. 브라우저에서는 react-native-web이 그 자리를 채운다.
  resolve: {
    alias: {
      "quble-react": at("../runtime/index.ts"),
      "react-native": "react-native-web",
    },
  },
  build: { outDir: at("../dist/native-web-build"), emptyOutDir: true },
});
