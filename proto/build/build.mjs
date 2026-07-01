#!/usr/bin/env node
// Quble 빌드 파이프라인. quble로 .qubc를 컴파일한 뒤, 짝 핸들러(.qubc.handlers.ts)가 있으면
// esbuild로 번들해 res/<stem>.<hash>.handlers.js로 리소스화하고 manifest에 handlers 경로를 덧쓴다.
// 사용: node build.mjs <path/to/component.qubc>

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const entry = process.argv[2];
if (!entry) {
  console.error("usage: quble-build <component.qubc>");
  process.exit(1);
}

const quble = join(dirname(new URL(import.meta.url).pathname), "..", "target", "release", "quble");
if (!existsSync(quble)) {
  console.error(`quble 바이너리 없음: ${quble} (cargo build --release --bin quble 먼저)`);
  process.exit(1);
}

// 1. quble 컴파일 - .qubb + res/*.css + dist/<stem>.manifest.json({"resources":[...]})
const compiled = spawnSync(quble, [entry], { stdio: "inherit" });
if (compiled.status !== 0) {
  process.exit(compiled.status ?? 1);
}

// 2. 짝 핸들러 발견. 없으면 여기서 끝(manifest는 quble가 이미 냈다).
const stem = basename(entry).replace(/\.qubc$/, "");
const handlersTs = entry.replace(/\.qubc$/, ".qubc.handlers.ts");
if (!existsSync(handlersTs)) {
  process.exit(0);
}

// 3. esbuild로 번들. write:false로 결과를 문자열로 받아(해시 파일명을 붙이려면 번들 결과가 먼저 필요),
//    FNV-1a 해시로 res/<stem>.<hash>.handlers.js에 우리가 직접 쓴다.
const result = await build({
  entryPoints: [handlersTs],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  write: false,
});
const js = result.outputFiles[0].text;
const hash = fnv1a(Buffer.from(js));
const handlerPath = `res/${stem}.${hash}.handlers.js`;

const distDir = join("dist");
writeFileSync(join(distDir, handlerPath), js);

// 4. manifest 읽어 handlers 필드 덧써 재작성.
const manifestPath = join(distDir, `${stem}.manifest.json`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.handlers = handlerPath;
writeFileSync(manifestPath, JSON.stringify(manifest));

console.log(`${join(distDir, handlerPath)} (handler bundled)`);
