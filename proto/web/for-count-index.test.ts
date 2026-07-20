// count @for의 회차변수(인덱스)를 텍스트로 렌더 - `@for (i of count) { {i} }`. 회차 인덱스는
// store에 안 앉는 회차 상수(RAW sourcePair)라, 초기 렌더와 grow로 늘린 꼬리 모두 자기 인덱스를
// 표시해야 한다. count는 store.set으로 늘려(grow) 반응 경로를 탄다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_count_index");
});

const rows = (host: ParentNode) => [...host.querySelectorAll(".row")].map((r) => r.textContent);

const instantiate = (values: unknown, handlers: THandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return { store: inst.store, host };
};

test("초기 렌더: 각 회차가 자기 인덱스를 텍스트로 표시", () => {
  const { host } = instantiate({ count: 3 });
  assert.deepEqual(rows(host), ["인덱스 0", "인덱스 1", "인덱스 2"], "count=3 -> 0·1·2");
});

test("count 0이면 회차 없음", () => {
  const { host } = instantiate({ count: 0 });
  assert.deepEqual(rows(host), [], "빈 반복");
});

test("grow: 늘린 꼬리 회차도 자기 인덱스를 표시", () => {
  const { host, store } = instantiate({ count: 2 });
  assert.deepEqual(rows(host), ["인덱스 0", "인덱스 1"], "초기 count=2");
  store.set(0, 5); // count
  assert.deepEqual(
    rows(host),
    ["인덱스 0", "인덱스 1", "인덱스 2", "인덱스 3", "인덱스 4"],
    "count=5 -> 늘린 회차가 2·3·4",
  );
});

test("shrink 후 재grow: 재추가된 회차 인덱스에 잔재 없음", () => {
  const { host, store } = instantiate({ count: 3 });
  store.set(0, 1); // 회차 1,2 제거
  assert.deepEqual(rows(host), ["인덱스 0"], "count=1");
  store.set(0, 3); // 재추가(새로 build)
  assert.deepEqual(rows(host), ["인덱스 0", "인덱스 1", "인덱스 2"], "재추가 회차도 1·2");
});
