// leaf store 스냅샷 - quble-ssr --snapshot(Rust plant_root의 직렬화)이 낸 것을 adoptSnapshot이 받으면,
// 런타임 plantRoot가 data로 만든 것과 같은 leaves, rootFlat, 배열 정보가 나온다.
//
// 해석기가 둘이라(runtime.ts, crates/renderer) 레이아웃이 어긋나면 스냅샷으로 시작한 store가 조용히
// 달라진다. ssr-match와 같은 시드로 비교해 그것을 잡는다.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decode } from "./decode.ts";
import { Pool } from "./pool-allocator.ts";
import type { TArrayInfo } from "./region.ts";
import { adoptSnapshot, compile, plantRoot, type THandlers, type TLeafSnapshot } from "./runtime.ts";
import { buildFixtureWithResmap } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";
import { snapshotSsr } from "./test-helpers/ssr.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // core/web
const seeds: Record<string, unknown[]> = JSON.parse(readFileSync(join(HERE, "ssr-match.seeds.json"), "utf8"));

// 배열 정보에서 data로 정해지는 부분만 비교한다 - 나머지는 @for가 돌 때 런타임이 채운다.
const planted = (pool: Pool<TArrayInfo>) =>
  pool.entries.map((info) => ({
    elemSize: info.elemSize,
    elemTypeRef: info.elemTypeRef,
    elemStartLeafIndices: info.elemStartLeafIndices,
  }));

// 처음 그린 DOM의 HTML. data를 주면 plantRoot로, snapshot을 주면 plantRoot 없이 시작한다.
const html = (qubb: Uint8Array, resmap: string[], data: unknown, snapshot?: TLeafSnapshot): string => {
  const inst = compile(qubb, resmap)(0)(data, {}, snapshot ? { snapshot } : {});
  const host = document.createElement("div");
  host.append(...inst.nodes);
  const out = host.innerHTML;
  inst.destroy();
  return out;
};

for (const [name, list] of Object.entries(seeds)) {
  list.forEach((data, i) => {
    test(`${name} 시드 ${i} - 스냅샷으로 시작해도 같은 DOM이 나온다`, () => {
      const { qubb, resmap } = buildFixtureWithResmap(name);
      assert.equal(html(qubb, resmap, undefined, snapshotSsr(name, data)), html(qubb, resmap, data));
    });
  });
}

for (const [name, list] of Object.entries(seeds)) {
  list.forEach((data, i) => {
    test(`${name} 시드 ${i} - 스냅샷이 plantRoot와 같은 store를 만든다`, () => {
      const { qubb } = buildFixtureWithResmap(name);
      const module = decode(qubb);

      const expectedPool: Pool<TArrayInfo> = new Pool();
      const expected = plantRoot(module, data, expectedPool);

      const pool: Pool<TArrayInfo> = new Pool();
      const got = adoptSnapshot(module, snapshotSsr(name, data), pool);

      assert.deepEqual(got.leaves, expected.leaves);
      assert.deepEqual(got.rootFlat, expected.rootFlat);
      assert.deepEqual(planted(pool), planted(expectedPool));
    });
  });
}

test("스냅샷으로 시작한 인스턴스에서 push가 동작한다", () => {
  const data = { tags: ["a"] };
  const { qubb, resmap } = buildFixtureWithResmap("for_array_push");
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
      push((ctx.props as Record<string, number>).tags, "b");
    },
  };
  const inst = compile(qubb, resmap)(0)(undefined, handlers, { snapshot: snapshotSsr("for_array_push", data) });
  const host = document.createElement("div");
  host.append(...inst.nodes);
  document.body.replaceChildren(host);
  (host.querySelector(".add") as HTMLButtonElement).click();
  assert.deepEqual(
    [...host.querySelectorAll(".tag")].map((t) => t.textContent),
    ["a", "b"],
  );
  inst.destroy();
});
