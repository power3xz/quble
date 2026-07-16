// 객체 payload 통합 테스트 - 실제 컴파일러(events { SAVE({ user }) }, user가 중첩 객체)와 실제
// runtime을 jsdom 위에서 돌린다. 버튼 클릭 → 이벤트 발생 → 핸들러 data.user가 타입 트리로 조립된
// 중첩 객체로 닿는지, 스칼라 field는 값 그대로인지, leaf 갱신이 조립값에 반영되는지 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb;
before(() => {
  qubb = buildFixture("object_payload");
});

// props 평탄 leaf 순서: user.name.short=0, user.name.long=1, user.email=2, tag=3.
const instantiate = (values, handlers) => {
  const inst = compile(qubb)(0)(values, handlers);
  const button = mount(inst).querySelector("button");
  return { store: inst.store, button };
};

const sample = () => ({
  user: { name: { short: "kim", long: "kim gil-dong" }, email: "kim@x.com" },
  tag: "vip",
});

test("객체 payload가 중첩 객체로 조립돼 핸들러 data에 닿는다", () => {
  let received = null;
  const { button } = instantiate(sample(), { SAVE: (data) => (received = data) });
  button.click();
  assert.deepEqual(received, {
    user: { name: { short: "kim", long: "kim gil-dong" }, email: "kim@x.com" },
    tag: "vip",
  });
});

test("스칼라 field는 값 그대로, 객체 field는 중첩 구조로 온다", () => {
  let received = null;
  const { button } = instantiate(sample(), { SAVE: (data) => (received = data) });
  button.click();
  assert.equal(received.tag, "vip"); // 스칼라는 값 그대로
  assert.equal(received.user.name.short, "kim"); // 객체는 중첩 접근
});

test("leaf 갱신이 발생 시점 조립값에 반영된다", () => {
  let received = null;
  const { store, button } = instantiate(sample(), { SAVE: (data) => (received = data) });
  store.set(0, "lee"); // user.name.short(leafIndex 0): 발생 전에 안쪽 leaf 하나 변경
  button.click();
  assert.equal(received.user.name.short, "lee");
  assert.equal(received.user.name.long, "kim gil-dong"); // 나머지는 그대로
});

test("빈 값(미설정 leaf)도 undefined로 조립된다", () => {
  let received = null;
  // user 아래 값 없이 tag만. user leaf들은 undefined.
  const { button } = instantiate({ tag: "x" }, { SAVE: (data) => (received = data) });
  button.click();
  assert.deepEqual(received.user, {
    name: { short: undefined, long: undefined },
    email: undefined,
  });
});
