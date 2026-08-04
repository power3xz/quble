// 확장 번들. src/extension.ts를 dist/extension.js 하나로 묶고, wasm 바이너리를 그 옆에
// 복사한다(확장은 경로만 ts-plugin에 넘기고, 읽는 것은 plugin이다).
//
// CJS로 내는 이유: 확장 호스트가 아직 ESM을 안 받는다(VS Code 본체는 1.94부터 ESM이지만
// 확장은 별개). 번들이므로 vsce는 --no-dependencies로 포장한다 - 워크스페이스 심볼릭 링크는
// vsce의 의존성 수집(npm list)이 못 따라간다.
//
// 사용: node build.mjs

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// ts-plugin은 번들에 못 넣는다 - tsserver가 확장 루트의 node_modules에서 이름으로 찾아
// require하므로 그 자리에 실물이 있어야 하고 CJS여야 한다. package.json의 dependencies
// 선언도 필요하다: VSCode가 그것을 보고 tsserver의 pluginProbeLocations에 이 확장 경로를
// 넣는다(선언이 없으면 이름만 넘어가고 찾을 곳이 없어 조용히 실패한다).
//
// npm이 걸어 둔 심볼릭 링크(file:../ts-plugin)를 지우고 그 자리에 번들을 놓는다 - 링크로
// 두면 포장이 링크 너머의 devDependencies까지 훑다 실패한다.
const PLUGIN_DIR = join(HERE, "node_modules", "quble-ts-plugin");
rmSync(PLUGIN_DIR, { recursive: true, force: true });
mkdirSync(join(PLUGIN_DIR, "dist"), { recursive: true });

await build({
  entryPoints: [join(HERE, "..", "ts-plugin", "src", "index.ts")],
  outfile: join(PLUGIN_DIR, "dist", "index.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  // tsserver가 자기 것을 넘겨준다(init 인자) - 번들에 넣으면 두 벌이 된다.
  external: ["typescript", "typescript/lib/tsserverlibrary"],
});

writeFileSync(
  join(PLUGIN_DIR, "package.json"),
  `${JSON.stringify({ name: "quble-ts-plugin", version: "0.0.1", main: "./dist/index.js" }, null, 2)}\n`,
);

console.log(`${join("dist", "extension.js")} (extension)`);
console.log(`${join("dist", "compiler_wasm.wasm")} (wasm compiler)`);
console.log(`${join("node_modules", "quble-ts-plugin", "dist", "index.js")} (ts plugin)`);
