// resume-entry의 resume - SSR이 그린 DOM(resumeFrom)을 이어받아 인스턴스를 돌려준다.
// runtime-entry의 mount(CSR)와 같은 모양이고, 초기 상태만 snapshot 또는 data로 준다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resume } from "./resume-entry.ts";
import { compile } from "./runtime.ts";
import { buildFixtureWithResmap } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";
import { renderSsr, snapshotSsr } from "./test-helpers/ssr.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const seeds: Record<string, unknown[]> = JSON.parse(readFileSync(join(HERE, "ssr-match.seeds.json"), "utf8"));

const NAME = "array_payload";
const data = seeds[NAME][0];

// data로 처음부터 그린(CSR) DOM의 HTML.
const csrHtml = (qubb: Uint8Array, resmap: string[]): string => {
  const inst = compile(qubb, resmap)(0)(data, {});
  const host = document.createElement("div");
  host.append(...inst.nodes);
  const html = host.innerHTML;
  inst.destroy();
  return html;
};

const ssrHost = (resmap: string[]): HTMLElement => {
  const host = document.createElement("div");
  host.innerHTML = renderSsr(NAME, resmap, data).html;
  return host;
};

test("snapshot으로 시작해 SSR 노드를 이어받는다", () => {
  const { qubb, resmap } = buildFixtureWithResmap(NAME);
  const host = ssrHost(resmap);
  const first = host.firstElementChild;

  const inst = resume(qubb, host, { snapshot: snapshotSsr(NAME, data), resources: resmap });

  assert.equal(host.firstElementChild, first);
  assert.equal(host.innerHTML, csrHtml(qubb, resmap));
  inst.destroy();
});

test("snapshot이 없으면 data로 시작해 SSR 노드를 이어받는다", () => {
  const { qubb, resmap } = buildFixtureWithResmap(NAME);
  const host = ssrHost(resmap);
  const first = host.firstElementChild;

  const inst = resume(qubb, host, { data, resources: resmap });

  assert.equal(host.firstElementChild, first);
  assert.equal(host.innerHTML, csrHtml(qubb, resmap));
  inst.destroy();
});
