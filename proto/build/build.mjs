#!/usr/bin/env node
// Quble 빌드 파이프라인. quble로 .qubc를 컴파일하고, 짝 핸들러(.qubc.handlers.ts)가 있으면
// esbuild로 번들해 manifest에 등록한 뒤, 런타임 번들(quble-runtime.js)과 진입 페이지(index.html)를
// 함께 낸다. 결과 dist/는 자기완결 - 정적 서버에 올리면 index.html이 바로 구동된다.
// 사용: node build.mjs <path/to/component.qubc> [--data <data.json>]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { build } from "esbuild";

// FNV-1a 64bit. Rust content_hash와 알고리즘 통일(offset basis/prime/16자리 hex) - 자산 파일명·dedup용.
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
const entry = args.find((a, i) => !a.startsWith("--") && i !== dataIdx + 1);
if (!entry) {
  console.error("usage: quble-build <component.qubc> [--data <data.json>]");
  process.exit(1);
}

const buildDir = dirname(new URL(import.meta.url).pathname);
const quble = join(buildDir, "..", "target", "release", "quble");
if (!existsSync(quble)) {
  console.error(`quble 바이너리 없음: ${quble} (cargo build --release --bin quble 먼저)`);
  process.exit(1);
}

const distDir = join("dist");
const stem = basename(entry).replace(/\.qubc$/, "");

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
    minify: true,
    write: false,
  });
  const js = result.outputFiles[0].text;
  const handlerPath = `res/${stem}.${fnv1a(Buffer.from(js))}.handlers.js`;
  // 내용이 바뀌면 해시(파일명)가 바뀌어 새 파일이 생긴다 - 같은 stem의 구 핸들러를 먼저 지운다.
  const resDir = join(distDir, "res");
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
//    배포 산출물이라 minify - 디버깅은 소스(proto/web/*.js)를 본다.
const runtimeBundle = await build({
  entryPoints: [join(buildDir, "..", "web", "mount.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
});
writeFileSync(join(distDir, "quble-runtime.js"), runtimeBundle.outputFiles[0].text);

// 4. 진입 페이지 - quble-runtime.js를 로드해 <stem>.qubb를 #quble-app에 마운트한다.
//    초기 data는 --data 파일 내용을 인라인(없으면 {}). store/provided 구조가 정해지면 교체(DESIGN §5.1).
const data = dataFile ? readFileSync(dataFile, "utf8") : "{}";
const indexHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>${stem}</title>
</head>
<body>
  <div id="quble-app"></div>
  <script type="module">
    import { mount } from "./quble-runtime.js";
    await mount("./${stem}.qubb", document.getElementById("quble-app"), ${data});
  </script>
</body>
</html>
`;
writeFileSync(join(distDir, "index.html"), indexHtml);

console.log(`${join(distDir, "index.html")} (entry page)`);
console.log(`${join(distDir, "quble-runtime.js")} (runtime bundle)`);
