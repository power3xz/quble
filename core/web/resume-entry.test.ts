// resume-entry의 resume - SSR이 그린 DOM(resumeFrom)을 resume해 인스턴스를 돌려준다.
// runtime-entry의 mount(CSR)와 같은 모양이고, 초기 상태만 flatData 또는 data로 준다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as entry from "./resume-entry.ts";
import { resume } from "./resume-entry.ts";
import { compile } from "./runtime.ts";
import { buildFixtureWithResmap } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";
import { flatDataSsr, renderSsr } from "./test-helpers/ssr.ts";

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

test("flatData로 시작해 SSR 노드를 resume한다", () => {
  const { qubb, resmap } = buildFixtureWithResmap(NAME);
  const host = ssrHost(resmap);
  const first = host.firstElementChild;

  const inst = resume(qubb, host, { flatData: flatDataSsr(NAME, data), resources: resmap });

  assert.equal(host.firstElementChild, first);
  assert.equal(host.innerHTML, csrHtml(qubb, resmap));
  inst.destroy();
});

test("flatData가 없으면 data로 시작해 SSR 노드를 resume한다", () => {
  const { qubb, resmap } = buildFixtureWithResmap(NAME);
  const host = ssrHost(resmap);
  const first = host.firstElementChild;

  const inst = resume(qubb, host, { data, resources: resmap });

  assert.equal(host.firstElementChild, first);
  assert.equal(host.innerHTML, csrHtml(qubb, resmap));
  inst.destroy();
});

// playground는 이 번들 하나를 셸(resume, loadHandlers)과 핸들러(runtime.ts에서 가져오는 compile)가 함께 쓴다.
test("compile, resume, loadHandlers, loadManifest를 모두 내보낸다", () => {
  assert.equal(typeof entry.compile, "function");
  assert.equal(typeof entry.resume, "function");
  assert.equal(typeof entry.loadHandlers, "function");
  assert.equal(typeof entry.loadManifest, "function");
});
