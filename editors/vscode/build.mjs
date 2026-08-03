// 확장 번들. src/extension.ts와 그 의존(quble-wasm-compiler)을 dist/extension.js 하나로 묶고,
// wasm 바이너리를 그 옆에 복사한다.
//
// CJS로 내는 이유: 확장 호스트가 아직 ESM을 안 받는다(VS Code 본체는 1.94부터 ESM이지만
// 확장은 별개). 번들이므로 vsce는 --no-dependencies로 포장한다 - 워크스페이스 심볼릭 링크는
// vsce의 의존성 수집(npm list)이 못 따라간다.
//
// 사용: node build.mjs

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url)); // editors/vscode
const REPO = join(HERE, "..", ".."); // repo root
const WASM_SRC = join(REPO, "core", "wasm-compiler", "compiler_wasm.wasm");
const DIST = join(HERE, "dist");

if (!existsSync(WASM_SRC)) {
  console.error(`wasm 없음(${WASM_SRC}). 'npm run build:wasm -w quble-wasm-compiler'를 먼저 실행하세요.`);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [join(HERE, "src", "extension.ts")],
  outfile: join(DIST, "extension.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  // 확장 호스트가 주입하는 모듈이라 번들에 넣으면 안 된다.
  external: ["vscode"],
  // CJS에는 import.meta가 없다. 패키지의 기본 wasm 경로가 그걸 쓰는데(확장은 자기 경로를
  // 넘겨 안 타지만) 그대로 두면 경고가 나고 값도 빈다. banner로 같은 뜻의 상수를 심고
  // define으로 그것을 가리키게 한다 - define 값은 식이 안 되고 이름이어야 한다.
  banner: {
    js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "__importMetaUrl" },
});

// .wasm은 번들에 못 들어간다(바이너리) - 옆에 두고 확장이 __dirname으로 짚는다.
copyFileSync(WASM_SRC, join(DIST, "compiler_wasm.wasm"));

console.log(`${join("dist", "extension.js")} (extension)`);
console.log(`${join("dist", "compiler_wasm.wasm")} (wasm compiler)`);
