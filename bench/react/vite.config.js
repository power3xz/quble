import react from "@vitejs/plugin-react";

export default {
  base: "/react/",
  plugins: [react()],
  build: { minify: "esbuild" },
};
