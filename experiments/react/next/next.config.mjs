import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

export default {
  // 생성물은 이 실험의 dist/ 아래에 둔다(gitignore, biome 제외).
  distDir: "../dist/next-build",
  turbopack: {
    // 셸 핸들러와 tokenize는 레포의 core/playground 것을 상대 경로로 싣는다.
    root: at("../../.."),
    // Pages Router는 _app 밖의 전역 CSS import를 막는다. 산출 셸이 import하는 core/playground의 CSS는 빈
    // 모듈로 바꾸고, 내용은 _app이 사본(next.sh가 dist/next-shell-css/로 복사)으로 싣는다.
    rules: {
      "*.css": {
        condition: { path: /core\/playground\/[^/]+\.css$/ },
        loaders: [at("./empty-loader.cjs")],
        as: "*.js",
      },
    },
  },
  // 셸 핸들러는 ts-plugin이 타입을 주입해야 타입 검사를 통과하는 파일이다(루트 tsconfig도 뺀다).
  typescript: { ignoreBuildErrors: true },
  // getServerSideProps가 데모 소스를 읽는 곳. 서버 번들 안에서는 파일 위치로 경로를 구할 수 없다.
  env: { QUBLE_PLAYGROUND: at("../../../core/playground") },
};
