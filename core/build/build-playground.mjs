#!/usr/bin/env node
// playground 빌드. 셸(playground.qubc)을 CLI로 컴파일해 dist에 내고, 브라우저에서 사용자 소스를
// 컴파일할 wasm과 정적 진입 페이지/스타일을 함께 배치한다. 결과 dist/는 자기완결이다.
//
// build-preview.mjs와 겹치는 부분(quble 컴파일, 핸들러 번들, 런타임 번들)이 있지만 산출물이
// 다르다 - preview는 index.html을 생성하고, playground는 손으로 쓴 core/playground/index.html을
// 복사한다(좌우 2단 + 인스턴스 둘). 중복이 굳으면 그때 공통으로 뺀다.
//
// 사용: node build-playground.mjs

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

// FNV-1a 64bit - build-preview.mjs와 같은 규칙(Rust content_hash와 통일).
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

const buildDir = dirname(new URL(import.meta.url).pathname);
const coreDir = join(buildDir, "..");
const quble = join(coreDir, "target", "debug", "quble");
const wasm = join(coreDir, "target", "wasm32-unknown-unknown", "release", "compiler_wasm.wasm");

for (const [path, hint] of [
  [quble, "cargo build --bin quble"],
  [wasm, "cargo build -p compiler-wasm --target wasm32-unknown-unknown --release"],
]) {
  if (!existsSync(path)) {
    console.error(`없음: ${path} (${hint} 먼저)`);
    process.exit(1);
  }
}

const entry = join(coreDir, "playground", "playground.qubc");
const distDir = join("dist", "playground");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(join(distDir, "styles"), { recursive: true });

// 1. 셸 컴파일 - playground.qubb + manifest. use한 css는 res/로 복사된다.
const compiled = spawnSync(quble, [entry, "--out-dir", distDir], { stdio: "inherit" });
if (compiled.status !== 0) {
  process.exit(compiled.status ?? 1);
}

// 2. 셸 핸들러 번들. wasm 래퍼는 인라인하되 런타임은 3번이 낸 quble-runtime.js를 쓴다 -
// 둘 다 인라인하면 런타임이 두 벌 실린다(핸들러 번들의 3분의 2가 런타임이었다).
// 소스는 runtime.ts를 그대로 import하고(타입이 붙는다) 여기서 산출물 경로로 갈아끼운다.
// playground는 배포물이라 minify한다(프리뷰는 로컬 디버깅용이라 그대로 둔다).
const handlersTs = entry.replace(/\.qubc$/, ".qubc.handlers.ts");
const runtimeUrl = "../quble-runtime.js"; // 핸들러는 res/ 아래라 한 단계 위
const handlerBundle = await build({
  entryPoints: [handlersTs],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  plugins: [
    {
      name: "runtime-external",
      setup: (b) => b.onResolve({ filter: /web\/runtime\.ts$/ }, () => ({ path: runtimeUrl, external: true })),
    },
  ],
  write: false,
});
const handlerJs = handlerBundle.outputFiles[0].text;
const handlerPath = `res/playground.${fnv1a(Buffer.from(handlerJs))}.handlers.js`;
mkdirSync(join(distDir, "res"), { recursive: true });
writeFileSync(join(distDir, handlerPath), handlerJs);

const manifestPath = join(distDir, "playground.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.handlers = handlerPath;
writeFileSync(manifestPath, JSON.stringify(manifest));

// 3. 런타임 번들 - 셸이 쓴다(사용자 인스턴스는 핸들러 번들 안 런타임이 만든다).
const runtimeBundle = await build({
  entryPoints: [join(coreDir, "web", "mount.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
});
writeFileSync(join(distDir, "quble-runtime.js"), runtimeBundle.outputFiles[0].text);

// 4. 정적 자산 - wasm, 진입 페이지/초기 소스, 전역 스타일.
copyFileSync(wasm, join(distDir, "compiler_wasm.wasm"));
for (const name of ["index.html", "sources.json"]) {
  copyFileSync(join(coreDir, "playground", name), join(distDir, name));
}
for (const css of ["reset.css", "global.css"]) {
  copyFileSync(join(coreDir, "web", "styles", css), join(distDir, "styles", css));
}

// 데모 소스는 브라우저가 sources.json의 이름으로 하나씩 받는다 - 통째로 복사한다.
cpSync(join(coreDir, "playground", "demo"), join(distDir, "demo"), { recursive: true });

console.log(`${join(distDir, "index.html")} (playground)`);
console.log(`${join(distDir, "compiler_wasm.wasm")} (wasm compiler)`);
console.log(`${join(distDir, handlerPath)} (shell handlers)`);
