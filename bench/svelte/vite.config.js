import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";

export default {
  base: "/svelte/",
  plugins: [svelte()],
  build: {
    minify: "esbuild",
    rollupOptions: {
      input: { perf: resolve(__dirname, "src/perf.js") },
    },
  },
};
