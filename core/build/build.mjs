#!/usr/bin/env node
// Quble 빌드 파이프라인. quble로 .qubc를 컴파일하고, 짝 핸들러(.qubc.handlers.ts)가 있으면
// esbuild로 번들해 manifest에 등록한 뒤, 런타임 번들(quble-runtime.js)과 진입 페이지(index.html)를
// 함께 낸다. 결과 dist/는 자기완결 - 정적 서버에 올리면 index.html이 바로 구동된다.
// 사용: node build.mjs <path/to/component.qubc> [--data <data.json>]
// --data: 컴포넌트가 초기 props(예: @for count)를 요구하면 그 초기값 JSON을 준다. 안 주면 {}로
//   mount돼 그 값에 걸린 렌더가 비어 나온다. 관례상 짝 파일 <component>.data.json에 둔다
//   (예: forstress.qubc <-> forstress.data.json). entry 빌드 전 짝 data.json 유무를 확인할 것.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { build } from "esbuild";

// FNV-1a 64bit. Rust content_hash와 알고리즘 통일(offset basis/prime/16자리 hex) - 자산 파일명/dedup용.
const fnv1a = (bytes) => {
  const MASK = (1n << 64n) - 1n;
  const PRIME = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
};

// 인자: 첫 위치 인자 = entry.qubc, --data <file> = 초기 data JSON(없으면 {}).
const args = process.argv.slice(2);
const dataIdx = args.indexOf("--data");
const dataFile = dataIdx >= 0 ? args[dataIdx + 1] : null;
const entry = args.find((a, i) => !a.startsWith("--") && !(dataIdx >= 0 && i === dataIdx + 1));
if (!entry) {
  console.error("usage: quble-build <component.qubc> [--data <data.json>]");
  process.exit(1);
}

const buildDir = dirname(new URL(import.meta.url).pathname);
const quble = join(buildDir, "..", "target", "debug", "quble");
if (!existsSync(quble)) {
  console.error(`quble 바이너리 없음: ${quble} (cargo build --bin quble 먼저)`);
  process.exit(1);
}

const distDir = join("dist");
const stem = basename(entry).replace(/\.qubc$/, "");

// dist를 비우고 시작한다 - 프리뷰는 한 컴포넌트만 담는다(이전 빌드가 누적돼 남지 않게).
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 1. quble 컴파일 - .qubb + res/*.css + dist/<stem>.manifest.json({"resources":[...],"props":[...]})
const compiled = spawnSync(quble, [entry], { stdio: "inherit" });
if (compiled.status !== 0) {
  process.exit(compiled.status ?? 1);
}

// 2. 짝 핸들러가 있으면 esbuild로 번들. write:false로 결과를 문자열로 받아(해시 파일명을 붙이려면
//    번들 결과가 먼저 필요), FNV-1a 해시로 res/<stem>.<hash>.handlers.js에 직접 쓰고 manifest에 등록.
const handlersTs = entry.replace(/\.qubc$/, ".qubc.handlers.ts");
if (existsSync(handlersTs)) {
  const result = await build({
    entryPoints: [handlersTs],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: false,
    write: false,
  });
  const js = result.outputFiles[0].text;
  const handlerPath = `res/${stem}.${fnv1a(Buffer.from(js))}.handlers.js`;
  // 내용이 바뀌면 해시(파일명)가 바뀌어 새 파일이 생긴다 - 같은 stem의 구 핸들러를 먼저 지운다.
  const resDir = join(distDir, "res");
  mkdirSync(resDir, { recursive: true }); // 첫 핸들러면 res/가 아직 없다 - 만들어 둔다(readdir/write 둘 다 필요).
  const oldRe = new RegExp(`^${stem}\\.[0-9a-f]{16}\\.handlers\\.js$`);
  for (const f of readdirSync(resDir)) {
    if (oldRe.test(f)) {
      rmSync(join(resDir, f));
    }
  }
  writeFileSync(join(distDir, handlerPath), js);

  const manifestPath = join(distDir, `${stem}.manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.handlers = handlerPath;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`${join(distDir, handlerPath)} (handler bundled)`);
}

// 3. 런타임 번들 - mount.js(runtime/region/leaf-store 포함)를 한 파일로. 매 빌드 생성.
const runtimeBundle = await build({
  entryPoints: [join(buildDir, "..", "web", "mount.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: false,
  write: false,
});
writeFileSync(join(distDir, "quble-runtime.js"), runtimeBundle.outputFiles[0].text);

// 4. 진입 페이지 - quble-runtime.js를 로드해 <stem>.qubb를 #quble-app에 마운트한다.
//    초기 data는 --data 파일 내용을 인라인(없으면 {}). store/provided 구조가 정해지면 교체(DESIGN §5.1).
//    구동 크리티컬 체인(runtime -> manifest -> qubb -> handlers)은 순차 발견이라 폭포수가 된다.
//    빌드가 그 경로들을 알므로 preload로 심어 HTML 파싱 시점에 병렬로 받게 한다(CSS는 렌더 중
//    LOAD_RES가 삽입하니 크리티컬 패스 아님 - 제외).
// 초기 data는 dist/data.json으로 떨구고 런타임이 HTTP로 fetch한다(인라인 아님) - 큰 data를
// HTML에 박지 않고, 프리뷰 서버가 파일로 서빙한다. --data 없으면 빈 객체.
const data = dataFile ? readFileSync(dataFile, "utf8") : "{}";
writeFileSync(join(distDir, "data.json"), data);
const finalManifest = JSON.parse(readFileSync(join(distDir, `${stem}.manifest.json`), "utf8"));
const preloads = [
  `  <link rel="modulepreload" href="./quble-runtime.js">`,
  `  <link rel="preload" href="./${stem}.qubb" as="fetch" crossorigin>`,
  `  <link rel="preload" href="./${stem}.manifest.json" as="fetch" crossorigin>`,
  `  <link rel="preload" href="./data.json" as="fetch" crossorigin>`,
];
if (finalManifest.handlers) {
  preloads.push(`  <link rel="modulepreload" href="./${finalManifest.handlers}">`);
}
const indexHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>${stem}</title>
${preloads.join("\n")}
</head>
<body>
  <div id="quble-app"></div>
  <script type="module">
    import { mount } from "./quble-runtime.js";
    // 초기 렌더 계측: mount 시작 -> 반환(디코드+인스턴스화+부착) -> rAF(페인트 후).
    // React/Svelte 데모와 같은 방식으로 재 나란히 비교한다.
    const t0 = performance.now();
    // 초기 data를 HTTP로 fetch(인라인 아님). 프리뷰 서버가 dist/data.json을 서빙한다.
    const data = await fetch("./data.json").then((r) => r.json());
    // 디버깅용: mount 결과({ store, inst })를 window에 노출한다. inst.regionPool은 이 인스턴스의
    // 모든 Region(@if swap/@for 회차 경계)이라, 콘솔에서 __quble.inst.regionPool.length로 누수를 잰다.
    window.__quble = await mount("./${stem}.qubb", document.getElementById("quble-app"), data);
    const mounted = performance.now();
    requestAnimationFrame(() => {
      const painted = performance.now();
      console.log(
        \`[quble] mount \${(mounted - t0).toFixed(1)}ms, 페인트까지 \${(painted - t0).toFixed(1)}ms\`,
      );
    });
  </script>
</body>
</html>
`;
writeFileSync(join(distDir, "index.html"), indexHtml);

console.log(`${join(distDir, "index.html")} (entry page)`);
console.log(`${join(distDir, "quble-runtime.js")} (runtime bundle)`);
