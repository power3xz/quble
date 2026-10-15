// SSG - build-ssg.mjs가 dist 디렉터리에 SSR + resume 페이지를 index.html로 쓴다. 서버가 요청마다 만드는
// 페이지(ssr-page.mjs)와 같은 조립이되, 개발자용 상태 표시줄이 없다. 자산은 index.html 기준 상대 경로로
// 가리키고, --assets-url을 주면 그 주소 아래로 가리킨다(자산을 CDN 같은 다른 출처에 올릴 때).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildFixtureWithResmap } from "./test-helpers/build.ts";
import { flatDataSsr, renderSsr } from "./test-helpers/ssr.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const BUILD_SSG = join(HERE, "..", "build", "build-ssg.mjs");
const SSR_BIN = join(HERE, "..", "target", "debug", "quble-ssr");
const CDN = "https://cdn.example.com/quble";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// build-preview.mjs가 낸 것과 같은 모양의 dist(qubb, manifest, data.json, 전역 CSS, 리소스)를 만들고
// build-ssg.mjs를 돌려 index.html을 돌려준다.
const buildSsg = (name: string, data: unknown, css: string, assetsUrl?: string) => {
  const { qubb, resmap } = buildFixtureWithResmap(name);
  const dist = mkdtempSync(join(tmpdir(), "quble-ssg-"));
  dirs.push(dist);
  writeFileSync(join(dist, `${name}.qubb`), qubb);
  writeFileSync(join(dist, `${name}.manifest.json`), JSON.stringify({ resources: resmap, props: [] }));
  writeFileSync(join(dist, "data.json"), JSON.stringify(data));
  writeFileSync(join(dist, "reset.css"), "");
  writeFileSync(join(dist, "global.css"), "");
  for (const path of resmap) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), css);
  }
  const args = [BUILD_SSG, dist, name, SSR_BIN, ...(assetsUrl ? ["--assets-url", assetsUrl] : [])];
  execFileSync("node", args, { stdio: ["ignore", "ignore", "inherit"] });
  return { html: readFileSync(join(dist, "index.html"), "utf8"), resmap };
};

test("페이지에 SSR HTML과 펴진 데이터가 실리고 상태 표시줄은 없다", () => {
  const data = { tags: ["a", "b"] };
  const { html } = buildSsg("for_array_push", data, "");
  assert.ok(html.includes(`<div id="quble-app">${renderSsr("for_array_push", [], data).html}</div>`), "SSR HTML");
  const tag = html.match(/<script id="qb-flat-data" type="application\/json">(.*?)<\/script>/s);
  assert.ok(tag, "펴진 데이터 태그");
  assert.deepEqual(JSON.parse(tag[1]), flatDataSsr("for_array_push", data));
  assert.ok(html.includes('<script type="module">'), "resume 스크립트");
  assert.ok(!html.includes("ssr-status"), "상태 표시줄이 없다");
});

test("기본은 자산을 index.html 기준 상대 경로로 가리킨다", () => {
  const { html, resmap } = buildSsg("styled_res", {}, ".box { color: red }");
  assert.ok(html.includes(`<style data-qb-href="./${resmap[0]}">.box { color: red }</style>`), "리소스 인라인");
  assert.ok(html.includes('from "./quble-resume.js"'), "런타임 번들");
  assert.ok(html.includes('fetch("./styled_res.qubb")'), "qubb");
  assert.ok(html.includes('fetch("./styled_res.manifest.json")'), "manifest");
});

test("--assets-url을 주면 자산이 그 주소 아래로 나간다", () => {
  const { html, resmap } = buildSsg("styled_res", {}, ".box { color: red }", CDN);
  assert.ok(html.includes(`<style data-qb-href="${CDN}/${resmap[0]}">.box { color: red }</style>`), "리소스 인라인");
  assert.ok(html.includes(`from "${CDN}/quble-resume.js"`), "런타임 번들");
  assert.ok(html.includes(`fetch("${CDN}/styled_res.qubb")`), "qubb");
  assert.ok(html.includes(`fetch("${CDN}/styled_res.manifest.json")`), "manifest");
});
