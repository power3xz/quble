// 실제 Next.js 빌드(Turbopack)를 거쳐도 .qubc import가 바이트코드가 되고, 서버가 낸 HTML에 내용이 들어 있으며,
// 서버용 코드(jsdom)가 브라우저 번들에 실리지 않는지. demo-next 앱을 빌드해 산출물을 읽는다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const REACT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(REACT, "adapter", "demo-next");
const DIST = join(REACT, "dist", "adapter-demo-next");

before(() => {
  const built = spawnSync(join(REACT, "node_modules", ".bin", "next"), ["build", APP], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
});

const serverHtml = () => readFileSync(join(DIST, "server", "pages", "index.html"), "utf8");

test("서버가 낸 HTML에 SSR 카운터 둘의 내용이 들어 있다", () => {
  assert.match(serverHtml(), /<!--qb:region#0--><div><button>React<\/button><p>1<\/p><\/div>/);
  assert.match(serverHtml(), /<!--qb:region#0--><div><button>update<\/button><p>1<\/p><\/div>/);
});

test("ssr: false인 카운터는 서버 HTML에 없다", () => {
  assert.doesNotMatch(serverHtml(), /<button>CSR<\/button>/);
});

test("서버용 코드(jsdom)가 브라우저 번들에 실리지 않는다", () => {
  const chunks = join(DIST, "static", "chunks");
  const withJsdom = readdirSync(chunks).filter((name) => readFileSync(join(chunks, name), "utf8").includes("jsdom"));
  assert.deepEqual(withJsdom, []);
});
