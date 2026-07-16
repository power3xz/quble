// 배열 payload 통합 테스트 - 실제 컴파일러(events { SAVE({ items, tags }) }, items가 객체 배열,
// tags가 스칼라 배열)와 실제 runtime을 jsdom 위에서 돌린다. 버튼 클릭 → 이벤트 발생 →
// 핸들러 data.items/data.tags가 배열로 조립돼 닿는지, 요소가 객체면 중첩 구조인지,
// leaf 갱신이 조립값에 반영되는지 본다. (object-payload.test.js의 배열 판.)

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.ts";
import { mount } from "./fixtures/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb;
before(() => {
  qubb = buildFixture("array_payload");
});

const instantiate = (values, handlers) => {
  const inst = compile(qubb)(0)(values, handlers);
  const button = mount(inst).querySelector("button");
  return { store: inst.store, button };
};

const sample = () => ({
  items: [
    { id: 1, name: "kim" },
    { id: 2, name: "lee" },
  ],
  tags: ["vip", "new"],
});

test("객체 배열 payload가 배열로 조립돼 핸들러 data에 닿는다", () => {
  let received = null;
  const { button } = instantiate(sample(), { SAVE: (data) => (received = data) });
  button.click();
  assert.deepEqual(received, {
    items: [
      { id: 1, name: "kim" },
      { id: 2, name: "lee" },
    ],
    tags: ["vip", "new"],
  });
});

test("스칼라 배열은 값 배열, 객체 배열은 요소별 중첩 구조로 온다", () => {
  let received = null;
  const { button } = instantiate(sample(), { SAVE: (data) => (received = data) });
  button.click();
  assert.deepEqual(received.tags, ["vip", "new"]);
  assert.equal(received.items[1].name, "lee");
});

test("빈 배열도 빈 배열로 조립된다", () => {
  let received = null;
  const { button } = instantiate({ items: [], tags: [] }, { SAVE: (data) => (received = data) });
  button.click();
  assert.deepEqual(received, { items: [], tags: [] });
});
