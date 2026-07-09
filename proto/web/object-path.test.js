// 객체 leaf 경로 보간 통합 테스트 - 실제 컴파일러({user.name} → 평탄 scope index)와 실제
// runtime을 jsdom 위에서 돌린다. 중첩 store + 평탄 점경로 rootPaths로 렌더해, 컴파일러가
// 낮춘 scope index가 런타임에서 올바른 leaf(중첩 객체 말단)에 닿는지 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.js";
import { mount } from "./fixtures/dom.js"; // jsdom 전역 document 주입(첫 import)

const { compile, createLeafStoreSubject } = await import("./runtime.ts");

let qubb;
before(() => {
  qubb = buildFixture("object_path");
});

// props: title, user{ name, contact{ email } }.
// 평탄 leaf 순서 = 선언 순서로 펼침: title=0, user.name=1, user.contact.email=2.
// rootPaths는 그 순서대로 store 점경로를 담는다.
const rootPaths = ["title", "user.name", "user.contact.email"];

const instantiate = (values) => {
  const store = createLeafStoreSubject(values);
  const inst = compile(qubb)(0)(store, rootPaths);
  const host = mount(inst);
  return { store, host };
};

test("중첩 객체 leaf가 평탄 scope index로 올바르게 렌더된다", () => {
  const { host } = instantiate({
    title: "제목",
    user: { name: "김철수", contact: { email: "kim@ex.com" } },
  });
  const spans = host.querySelectorAll("span");
  assert.equal(host.querySelector("h1").textContent, "제목");
  assert.equal(spans[0].textContent, "김철수"); // user.name
  assert.equal(spans[1].textContent, "kim@ex.com"); // user.contact.email
});

test("중첩 leaf 갱신이 그 leaf 구독 노드만 반영한다", () => {
  const { store, host } = instantiate({
    title: "제목",
    user: { name: "김철수", contact: { email: "kim@ex.com" } },
  });
  store.setPath("user.contact.email", "new@ex.com");
  const spans = host.querySelectorAll("span");
  assert.equal(spans[1].textContent, "new@ex.com", "깊은 leaf 갱신 반영");
  assert.equal(spans[0].textContent, "김철수", "형제 leaf는 안 건드림");
});
