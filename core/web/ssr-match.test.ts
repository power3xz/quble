// SSR 일치 - 같은 qubb + data를 JS 런타임과 Rust SSR(quble-ssr)에 넣으면 같은 트리가 나온다.
//
// 해석기가 둘이라(runtime.ts, crates/renderer) 한쪽만 고치면 서버 HTML과 브라우저 화면이 조용히
// 달라진다. 픽스처마다 시드 데이터(ssr-match.seeds.json)로 처음 그린 결과를 비교해 그것을 잡는다.
//
// 비교는 normalize()한 트리끼리 한다. HTML이 되면 붙은 텍스트 노드가 하나로 합쳐지고 빈 텍스트
// 노드는 사라져, 노드 경계까지는 같을 수 없다.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "./runtime.ts";
import { buildFixtureWithResmap, fixtureQubbPath } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const COMPONENTS = join(HERE, "..", "..", "components");
const SSR_BIN = join(HERE, "..", "target", "debug", "quble-ssr");

const seeds: Record<string, unknown[]> = JSON.parse(readFileSync(join(HERE, "ssr-match.seeds.json"), "utf8"));

const fixtures = readdirSync(COMPONENTS)
  .filter((f) => f.endsWith(".fixture.qubc"))
  .map((f) => f.replace(/\.fixture\.qubc$/, ""));

// 다른 픽스처가 `use X from "./name.fixture.qubc"`로 쓰는 픽스처. 그 부모를 그릴 때 함께 그려진다.
const usedByOthers = new Set(
  fixtures.flatMap((name) =>
    [
      ...readFileSync(join(COMPONENTS, `${name}.fixture.qubc`), "utf8").matchAll(
        /from "\.\/([a-z_]+)\.fixture\.qubc"/g,
      ),
    ].map((m) => m[1]),
  ),
);

test("모든 픽스처가 시드를 갖거나 다른 픽스처가 쓰는 자식이다", () => {
  const uncovered = fixtures.filter((name) => !seeds[name] && !usedByOthers.has(name));
  assert.deepEqual(uncovered, [], "ssr-match.seeds.json에 시드를 더한다");
});

// 처음 그린 결과 - normalize()한 트리의 HTML과, LOAD_RES가 head에 넣은 <link>의 href 순서.
const renderClient = (qubb: Uint8Array, resmap: string[], data: unknown) => {
  const before = new Set(document.head.querySelectorAll("link"));
  const inst = compile(qubb, resmap)(0)(data, {});
  const host = document.createElement("div");
  host.append(...inst.nodes);
  host.normalize();
  const html = host.innerHTML;
  const links = [...document.head.querySelectorAll("link")]
    .filter((l) => !before.has(l))
    .map((l) => l.getAttribute("href"));
  // 노드를 떼고 위임 리스너를 걷는다 - 읽은 뒤에 해야 한다(떼면 host가 빈다).
  inst.destroy();
  return { html, links };
};

// quble-ssr는 HTML을 stdout에, 링크를 stderr에 `link: <url>` 줄로 낸다.
const renderSsr = (name: string, resmap: string[], data: unknown) => {
  const run = spawnSync(SSR_BIN, [fixtureQubbPath(name), "-", ...resmap], {
    input: JSON.stringify(data),
    encoding: "utf8",
    // 기본 1MB를 넘는 픽스처가 있다(perfbig 약 3MB). 넘치면 status가 null로 끝난다.
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const host = document.createElement("div");
  host.innerHTML = run.stdout;
  host.normalize();
  const links = run.stderr
    .split("\n")
    .filter((l) => l.startsWith("link: "))
    .map((l) => l.slice("link: ".length));
  return { html: host.innerHTML, links };
};

for (const [name, list] of Object.entries(seeds)) {
  list.forEach((data, i) => {
    test(`${name} 시드 ${i}`, () => {
      const { qubb, resmap } = buildFixtureWithResmap(name);
      const client = renderClient(qubb, resmap, data);
      const ssr = renderSsr(name, resmap, data);
      assert.equal(ssr.html, client.html);
      assert.deepEqual(ssr.links, client.links);
    });
  });
}
