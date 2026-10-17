import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

export default {
  // 생성물은 이 실험의 dist/ 아래에 둔다(gitignore).
  distDir: "../../dist/adapter-demo-next",
  turbopack: {
    // 어댑터와 core/web 소스를 상대 경로로 싣는다.
    root: at("../../../.."),
    rules: { "*.qubc": { loaders: [at("./qubc-loader.cjs")], as: "*.js" } },
    // quble/react는 서버 번들에서는 서버용, 브라우저 번들에서는 브라우저용 진입점으로 풀린다.
    resolveAlias: { "quble/react": { browser: "../react-browser.ts", default: "../react-server.ts" } },
  },
};
