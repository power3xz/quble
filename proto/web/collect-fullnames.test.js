// collectEventFullnames 단위 테스트 — 루트에서 합성 트리를 걸어 발사 가능한 이벤트 fullname을
// 정적으로 산출한다(인스펙터가 핸들러를 fullname으로 걸 때 쓴다). runtime의 pathPrefix 누적과
// 같은 결과를 디코드 단계에서 뽑는지 본다.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "./fixtures/build.js";

const { decodeForTest, collectEventFullnames } = await import("./disasm.js").then((m) => ({
  collectEventFullnames: m.collectEventFullnames,
  decodeForTest: m.inspect,
}));

let module;
before(() => {
  const qubb = buildFixture("event_fullname");
  module = decodeForTest(qubb).module;
});

test("합성된 자식 이벤트는 fullname(자식 type-name 누적)으로 수집된다", () => {
  // Card(루트, comp 0) -> Toggle 합성. Toggle의 TOGGLE은 "Toggle.TOGGLE"로.
  const events = collectEventFullnames(module, 0);
  assert.deepEqual(events, [
    {
      fullname: "Toggle.TOGGLE",
      payload: [
        { field: "label", offset: 0 },
        { field: "on", offset: 1 },
      ],
    },
  ]);
});

test("루트 컴포넌트 자신의 이벤트는 prefix 없는 로컬명으로 수집된다", () => {
  // Toggle을 루트(comp 1)로 직접 보면 합성 경로가 없어 "TOGGLE".
  const events = collectEventFullnames(module, 1);
  assert.deepEqual(events.map((e) => e.fullname), ["TOGGLE"]);
});
