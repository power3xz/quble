import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default {
  base: "/react/",
  plugins: [react()],
  build: {
    minify: "esbuild",
    rollupOptions: {
      // 기본 진입점(index.html) + CSR 진입점(react-csr).
      input: {
        main: resolve(__dirname, "index.html"),
        "react-csr": resolve(__dirname, "src/react-csr.jsx"),
      },
    },
  },
};
