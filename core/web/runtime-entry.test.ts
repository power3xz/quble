// mount - 바이트코드를 받아 컨테이너에 붙이는 CSR 진입점. fetch 없이 동기로 인스턴스를 낸다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { THandlers } from "./runtime.ts";
import { mount, mountFromUrl } from "./runtime-entry.ts";
import { buildFixture } from "./test-helpers/build.ts";
import "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_toggle");
});

const containerOf = () => {
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  return container;
};

test("mount는 인스턴스 노드를 컨테이너에 붙이고 인스턴스를 동기로 돌려준다", () => {
  const container = containerOf();
  const inst = mount(qubb, container, { data: { label: "t", on: "on" } });
  assert.notEqual(container.querySelector("button"), null, "컨테이너에 DOM이 붙는다");
  assert.deepEqual(inst.nodes, Array.from(container.childNodes), "반환한 nodes가 컨테이너의 자식이다");
});

test("mount는 컨테이너의 기존 자식을 바꾼다", () => {
  const container = containerOf();
  container.append(document.createElement("span"));
  mount(qubb, container, { data: { label: "t", on: "on" } });
  assert.equal(container.querySelector("span"), null, "기존 자식이 사라진다");
});

test("mount가 넘긴 handlers가 클릭에 불린다", () => {
  const container = containerOf();
  let count = 0;
  const handlers: THandlers = { TOGGLE: () => count++ };
  mount(qubb, container, { data: { label: "t", on: "on" }, handlers });
  (container.querySelector("button") as HTMLButtonElement).click();
  assert.equal(count, 1);
});

test("mount가 낸 인스턴스는 destroy로 컨테이너를 비운다", () => {
  const container = containerOf();
  const inst = mount(qubb, container, { data: { label: "t", on: "on" } });
  inst.destroy();
  assert.equal(container.childNodes.length, 0);
});

// 요청한 URL을 모으고 manifest(JSON)와 qubb(바이트)를 돌려주는 fetch로 바꾼 채 body를 돌린다.
const withFetch = async (body: (asked: string[]) => Promise<void>) => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return {
      json: async () => ({ resources: [] }),
      arrayBuffer: async () => qubb.buffer.slice(qubb.byteOffset, qubb.byteOffset + qubb.byteLength),
    };
  }) as unknown as typeof fetch;
  (globalThis as { location?: unknown }).location = { href: "http://localhost/" };
  try {
    await body(asked);
  } finally {
    globalThis.fetch = realFetch;
    delete (globalThis as { __qubleManifests?: unknown }).__qubleManifests;
  }
};

test("mountFromUrl은 manifest를 심어 두지 않았으면 manifest와 qubb를 fetch한다", async () => {
  await withFetch(async (asked) => {
    const container = containerOf();
    await mountFromUrl("./app.qubb", container, { label: "t", on: "on" });
    assert.deepEqual(asked, ["./app.manifest.json", "./app.qubb"]);
    assert.notEqual(container.querySelector("button"), null);
  });
});

test("mountFromUrl은 manifest를 심어 두었으면 manifest를 fetch하지 않는다", async () => {
  await withFetch(async (asked) => {
    (globalThis as { __qubleManifests?: unknown }).__qubleManifests = { "./app.manifest.json": { resources: [] } };
    const container = containerOf();
    await mountFromUrl("./app.qubb", container, { label: "t", on: "on" });
    assert.deepEqual(asked, ["./app.qubb"]);
    assert.notEqual(container.querySelector("button"), null);
  });
});
