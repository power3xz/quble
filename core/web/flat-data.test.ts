// leaf store 펴진 데이터 - quble-ssr --flat-data(Rust plant_root의 직렬화)이 낸 것을 adoptFlatData이 받으면,
// 런타임 plantRoot가 data로 만든 것과 같은 leaves, rootFlat, 배열 정보가 나온다.
//
// 해석기가 둘이라(runtime.ts, crates/renderer) 레이아웃이 어긋나면 펴진 데이터로 시작한 store가 조용히
// 달라진다. ssr-match와 같은 시드로 비교해 그것을 잡는다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decode } from "./decode.ts";
import { Pool } from "./pool-allocator.ts";
import type { TArrayInfo } from "./region.ts";
import { adoptFlatData, resume } from "./resume.ts";
import { compile, plantRoot, type THandlers } from "./runtime.ts";
import { buildFixtureWithResmap } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";
import { flatDataSsr, renderSsr } from "./test-helpers/ssr.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const seeds: Record<string, unknown[]> = JSON.parse(readFileSync(join(HERE, "ssr-match.seeds.json"), "utf8"));

// 배열 정보에서 data로 정해지는 부분만 비교한다 - 나머지는 @for가 돌 때 런타임이 채운다.
const planted = (pool: Pool<TArrayInfo>) =>
  pool.entries.map((info) => ({
    elemSize: info.elemSize,
    elemTypeRef: info.elemTypeRef,
    elemStartLeafIndices: info.elemStartLeafIndices,
  }));

// data로 처음부터 그린(CSR) DOM의 HTML.
const csrHtml = (qubb: Uint8Array, resmap: string[], data: unknown): string => {
  const inst = compile(qubb, resmap)(0)(data, {});
  const host = document.createElement("div");
  host.append(...inst.nodes);
  const out = host.innerHTML;
  inst.destroy();
  return out;
};

// SSR HTML을 펴진 데이터로 이어받은 DOM의 HTML(plantRoot 없이 시작한다).
const resumedHtml = (name: string, resmap: string[], qubb: Uint8Array, data: unknown): string => {
  const host = document.createElement("div");
  host.innerHTML = renderSsr(name, resmap, data).html;
  const inst = resume(qubb, resmap)(0)(undefined, {}, { resumeFrom: host, flatData: flatDataSsr(name, data) });
  host.replaceChildren(...inst.nodes);
  const out = host.innerHTML;
  inst.destroy();
  return out;
};

for (const [name, list] of Object.entries(seeds)) {
  list.forEach((data, i) => {
    test(`${name} 시드 ${i} - 펴진 데이터로 시작해도 같은 DOM이 나온다`, () => {
      const { qubb, resmap } = buildFixtureWithResmap(name);
      assert.equal(resumedHtml(name, resmap, qubb, data), csrHtml(qubb, resmap, data));
    });
  });
}

for (const [name, list] of Object.entries(seeds)) {
  list.forEach((data, i) => {
    test(`${name} 시드 ${i} - 펴진 데이터가 plantRoot와 같은 store를 만든다`, () => {
      const { qubb } = buildFixtureWithResmap(name);
      const module = decode(qubb);

      const expectedPool: Pool<TArrayInfo> = new Pool();
      const expected = plantRoot(module, data, expectedPool);

      const pool: Pool<TArrayInfo> = new Pool();
      const got = adoptFlatData(module, flatDataSsr(name, data), pool);

      assert.deepEqual(got.leaves, expected.leaves);
      assert.deepEqual(got.rootFlat, expected.rootFlat);
      assert.deepEqual(planted(pool), planted(expectedPool));
    });
  });
}

test("펴진 데이터로 시작한 인스턴스에서 push가 동작한다", () => {
  const data = { tags: ["a"] };
  const { qubb, resmap } = buildFixtureWithResmap("for_array_push");
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
      push((ctx.props as Record<string, number>).tags, "b");
    },
  };
  const host = document.createElement("div");
  host.innerHTML = renderSsr("for_array_push", resmap, data).html;
  document.body.replaceChildren(host);
  const inst = resume(qubb, resmap)(0)(undefined, handlers, {
    resumeFrom: host,
    flatData: flatDataSsr("for_array_push", data),
  });
  host.replaceChildren(...inst.nodes);
  (host.querySelector(".add") as HTMLButtonElement).click();
  assert.deepEqual(
    [...host.querySelectorAll(".tag")].map((t) => t.textContent),
    ["a", "b"],
  );
  inst.destroy();
});

// SSR HTML을 펴진 데이터로 이어받은 인스턴스. 클릭이 위임 리스너에 닿도록 문서에 붙인다.
const resumeFromFlatData = (
  name: string,
  qubb: Uint8Array,
  resmap: string[],
  data: unknown,
  handlers: THandlers = {},
) => {
  const host = document.createElement("div");
  host.innerHTML = renderSsr(name, resmap, data).html;
  document.body.replaceChildren(host);
  const inst = resume(qubb, resmap)(0)(undefined, handlers, { resumeFrom: host, flatData: flatDataSsr(name, data) });
  host.replaceChildren(...inst.nodes);
  return { host, inst };
};

test("펴진 데이터로 시작한 인스턴스에서 클릭과 set이 CSR처럼 동작한다 - payload 식", () => {
  const data = { n: 1, open: true, cursor: 0, rows: [{ title: "A", tags: ["a1"] }] };
  const { qubb, resmap } = buildFixtureWithResmap("payload_expr");
  const sent: unknown[] = [];
  const { host, inst } = resumeFromFlatData("payload_expr", qubb, resmap, data, { SEND: (d) => sent.push(d.next) });
  const send = host.querySelector(".send") as HTMLButtonElement;
  send.click();
  inst.store.set(0, 10); // n
  send.click();
  assert.deepEqual(sent, [2, 11]);
  inst.destroy();
});

test("펴진 데이터로 시작한 인스턴스에서 인덱스가 바뀌면 텍스트가 갱신된다", () => {
  const data = {
    rows: [
      { title: "A", score: 10 },
      { title: "B", score: 20 },
      { title: "C", score: 30 },
    ],
    scalars: [7, 8, 9],
    cursor: 0,
    show: false,
  };
  const { qubb, resmap } = buildFixtureWithResmap("expr_array_index");
  const { host, inst } = resumeFromFlatData("expr_array_index", qubb, resmap, data);
  const field = host.querySelector(".field") as HTMLElement;
  assert.equal(field.textContent, "A");
  inst.store.set(2, 1); // cursor
  assert.equal(field.textContent, "B");
  inst.destroy();
});

test("펴진 데이터로 시작한 인스턴스에서 @if가 바뀌면 가지가 바뀐다", () => {
  const data = { tags: ["a", "b"], flag: true };
  const { qubb, resmap } = buildFixtureWithResmap("for_if_lazy_slot");
  const { host, inst } = resumeFromFlatData("for_if_lazy_slot", qubb, resmap, data);
  const spans = () => [...host.querySelectorAll("span")].map((s) => `${s.className}:${s.textContent}`);
  assert.deepEqual(spans(), ["on:a", "on:b"]);
  inst.store.set(1, false); // flag
  assert.deepEqual(spans(), ["off:off", "off:off"]);
  inst.store.set(1, true);
  assert.deepEqual(spans(), ["on:a", "on:b"]);
  inst.destroy();
});
