import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default {
  base: "/react/",
  plugins: [react()],
  build: {
    minify: "esbuild",
    rollupOptions: {
      // CSR(react-csr) + 범용 부트(_boot).
      // _boot가 views/<Name>.jsx를 동적 import → /react/<Name>로 라우팅.
      input: {
        "react-csr": resolve(__dirname, "src/react-csr.jsx"),
        _boot: resolve(__dirname, "src/_boot.jsx"),
      },
      // 해시 없는 고정 파일명 - 서버가 prefix로 찾을 필요 없이 경로를 직접 안다.
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
};
