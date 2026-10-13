// playground 셸(playground.qubc)의 SSR 일치 - 첫 화면의 초기 data(initialData)를 JS 런타임과 Rust SSR에 넣으면
// 같은 트리가 나온다. 픽스처가 아니라 실제 셸이라 ssr-match.test.ts에 넣지 않았다. 비교 방식은 같다.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { initialData } from "../playground/initial-data.ts";
import { compile } from "./runtime.ts";
import "./test-helpers/dom.ts";
import { removeTextMarks } from "./test-helpers/ssr.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const CORE = join(HERE, "..");
const PLAYGROUND = join(CORE, "playground");
const QUBLE_BIN = join(CORE, "target", "debug", "quble");
const SSR_BIN = join(CORE, "target", "debug", "quble-ssr");

const outDir = mkdtempSync(join(tmpdir(), "quble-playground-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// index.html이 읽는 것과 같은 초기 파일들 - sources.json의 이름 순서대로 demo/의 파일을 읽는다.
const sources = (JSON.parse(readFileSync(join(PLAYGROUND, "sources.json"), "utf8")) as string[]).map((name) => ({
  name,
  source: readFileSync(join(PLAYGROUND, "demo", name), "utf8"),
}));

test("셸의 첫 화면이 SSR과 JS 런타임에서 같다", () => {
  execFileSync(QUBLE_BIN, [join(PLAYGROUND, "playground.qubc"), "--out-dir", outDir], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const qubb = new Uint8Array(readFileSync(join(outDir, "playground.qubb")));
  const resmap: string[] = JSON.parse(readFileSync(join(outDir, "playground.manifest.json"), "utf8")).resources;
  const data = initialData(sources);

  const before = new Set(document.head.querySelectorAll("link"));
  const inst = compile(qubb, resmap)(0)(data, {});
  const client = document.createElement("div");
  client.append(...inst.nodes);
  client.normalize();
  const clientHtml = client.innerHTML;
  const clientLinks = [...document.head.querySelectorAll("link")]
    .filter((l) => !before.has(l))
    .map((l) => l.getAttribute("href"));
  inst.destroy();

  const run = spawnSync(SSR_BIN, [join(outDir, "playground.qubb"), "-", ...resmap], {
    input: JSON.stringify(data),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const server = document.createElement("div");
  server.innerHTML = run.stdout;
  removeTextMarks(server);
  server.normalize();
  const serverLinks = run.stderr
    .split("\n")
    .filter((l) => l.startsWith("link: "))
    .map((l) => l.slice("link: ".length));

  assert.equal(server.innerHTML, clientHtml);
  assert.deepEqual(serverLinks, clientLinks);
});
