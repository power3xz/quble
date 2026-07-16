// 스칼라 배열을 @for로 순회하며 회차변수(item)를 {tag}로 보간하는지 검증한다. plant가 요소를
// store에 심고(array-plant.test.ts), 이 테스트는 @for가 그 요소 leaf를 회차변수 slot에 바인딩해
// 실제 텍스트로 렌더하는 경로를 본다 - 이 단계(스칼라 배열 요소 보간)의 실물 검증.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.js";
import { mount } from "./fixtures/dom.js";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_scalar");
});

const liTexts = (host: HTMLElement) => [...host.querySelectorAll("li")].map((li) => li.textContent);

test("배열 요소 수만큼 회차가 렌더되고 각 회차가 요소 값을 보간한다", () => {
  const inst = compile(qubb)(0)({ tags: ["red", "green", "blue"] }, {});
  const host = mount(inst);
  assert.deepEqual(liTexts(host), ["red", "green", "blue"]);
});

test("빈 배열이면 회차가 없다", () => {
  const inst = compile(qubb)(0)({ tags: [] }, {});
  const host = mount(inst);
  assert.deepEqual(liTexts(host), []);
});
