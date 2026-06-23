// LOAD_RES 통합 테스트 — 실제 컴파일러(.qubc → .qubb, use "x.css" → LOAD_RES)와 실제
// runtime.js를 jsdom 위에서 돌린다. compile(bytes, resmap)이 LOAD_RES를 만나 resId의 URL로
// <link>를 document.head에 삽입하는지, 같은 URL은 dedup되는지 검증한다.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./fixtures/dom.js"; // jsdom 전역 document 주입(첫 import)
import { buildFixture } from "./fixtures/build.js";

const { compile, createStore } = await import("./runtime.js");

const qubb = buildFixture("styled_res");

// 각 테스트 전에 head의 stylesheet link를 비운다. dedup Set은 compile 단위라 새 compile마다
// 깨끗하므로 따로 비울 필요 없다.
beforeEach(() => {
  for (const link of [...document.head.querySelectorAll("link[rel=stylesheet]")]) {
    link.remove();
  }
});

// head의 stylesheet href 목록.
const hrefs = () =>
  [...document.head.querySelectorAll("link[rel=stylesheet]")].map((l) => l.getAttribute("href"));

test("LOAD_RES가 resId의 URL로 <link>를 head에 삽입한다", () => {
  const ctx = createStore({});
  compile(qubb, ["/res/styled.abc.css"])(0)(ctx, []);
  assert.deepEqual(hrefs(), ["/res/styled.abc.css"]);
});

test("같은 URL은 dedup — 한 compile에서 두 번 인스턴스화해도 <link>는 하나", () => {
  // dedup은 compile 단위 — 같은 blueprint를 두 번 인스턴스화하면 href는 한 번만 삽입된다.
  const blueprint = compile(qubb, ["/res/styled.abc.css"])(0);
  blueprint(createStore({}), []);
  blueprint(createStore({}), []);
  assert.deepEqual(hrefs(), ["/res/styled.abc.css"], "중복 href 스킵");
});

test("resmap 없으면 <link>를 안 만든다(리소스 로드 생략)", () => {
  compile(qubb)(0)(createStore({}), []);
  assert.deepEqual(hrefs(), []);
});
