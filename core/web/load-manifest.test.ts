// manifest 로드 - 페이지가 __qubleManifests에 URL로 심어 둔 값이 있으면 fetch를 건너뛴다.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { TManifest } from "./load-handlers.ts";
import { loadManifest } from "./load-manifest.ts";

const realFetch = globalThis.fetch;
const page = globalThis as { __qubleManifests?: Record<string, TManifest> };

afterEach(() => {
  globalThis.fetch = realFetch;
  delete page.__qubleManifests;
});

// 불린 URL을 모으고 manifest를 돌려주는 fetch로 바꾼다.
const stubFetch = (served: TManifest): string[] => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return { json: async () => served };
  }) as unknown as typeof fetch;
  return asked;
};

test("심어 둔 값이 있으면 fetch하지 않고 그 값을 돌려준다", async () => {
  const inlined: TManifest = { resources: ["a.css"], handlers: "h.js" };
  page.__qubleManifests = { "./app.manifest.json": inlined };
  const asked = stubFetch({ resources: [] });

  assert.deepEqual(await loadManifest("./app.manifest.json"), inlined);
  assert.deepEqual(asked, []);
});

test("__qubleManifests가 없으면 fetch한 값을 돌려준다", async () => {
  const served: TManifest = { resources: ["b.css"] };
  const asked = stubFetch(served);

  assert.deepEqual(await loadManifest("./app.manifest.json"), served);
  assert.deepEqual(asked, ["./app.manifest.json"]);
});

test("다른 URL로 심어 둔 값은 쓰지 않고 fetch한다", async () => {
  page.__qubleManifests = { "./other.manifest.json": { resources: ["x.css"] } };
  const served: TManifest = { resources: [] };
  const asked = stubFetch(served);

  assert.deepEqual(await loadManifest("./app.manifest.json"), served);
  assert.deepEqual(asked, ["./app.manifest.json"]);
});
