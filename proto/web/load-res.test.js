// LOAD_RES 통합 테스트 - 실제 컴파일러(.qubc → .qubb, use "x.css" → LOAD_RES)와 실제
// runtime.js를 jsdom 위에서 돌린다. compile(bytes, resmap)이 LOAD_RES를 만나 resId의 URL로
// <link>를 document.head에 삽입하는지, 같은 URL은 dedup되는지 검증한다.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import "./fixtures/dom.js"; // jsdom 전역 document 주입(첫 import). 심볼은 안 쓰고 부수효과만 필요.
import { buildFixture, buildFixtureWithResmap } from "./fixtures/build.js";

const { compile, createLeafStoreSubject } = await import("./runtime.ts");

const qubb = buildFixture("styled_res");

// 각 테스트 전에 head의 stylesheet link를 비운다. dedup Set은 compile 단위라 새 compile마다
// 깨끗하므로 따로 비울 필요 없다.
beforeEach(() => {
  for (const link of [...document.head.querySelectorAll("link[rel=stylesheet]")]) {
    link.remove();
  }
});

// head의 stylesheet href 목록.
const hrefs = () => [...document.head.querySelectorAll("link[rel=stylesheet]")].map((l) => l.getAttribute("href"));

test("LOAD_RES가 resId의 URL로 <link>를 head에 삽입한다", () => {
  const store = createLeafStoreSubject({});
  compile(qubb, ["/res/styled.abc.css"])(0)(store, []);
  assert.deepEqual(hrefs(), ["/res/styled.abc.css"]);
});

test("같은 URL은 dedup - 한 compile에서 두 번 인스턴스화해도 <link>는 하나", () => {
  // dedup은 compile 단위 - 같은 blueprint를 두 번 인스턴스화하면 href는 한 번만 삽입된다.
  const blueprint = compile(qubb, ["/res/styled.abc.css"])(0);
  blueprint(createLeafStoreSubject({}), []);
  blueprint(createLeafStoreSubject({}), []);
  assert.deepEqual(hrefs(), ["/res/styled.abc.css"], "중복 href 스킵");
});

test("resmap 없으면 <link>를 안 만든다(리소스 로드 생략)", () => {
  compile(qubb)(0)(createLeafStoreSubject({}), []);
  assert.deepEqual(hrefs(), []);
});

// @if 가지 안에서만 RENDER되는 (다른 파일) 컴포넌트의 LOAD_RES는 그 가지가 켜질 때까지
// 미뤄진다 - lazy build가 자식 def를 해석하지 않으면 자식 def 앞머리의 LOAD_RES도 실행되지
// 않기 때문. 이게 "lazy 가지의 CSS가 늦게 로드된다"는 현 동작의 근거다.
test("@if 비활성 가지 안의 컴포넌트 CSS는 가지가 켜질 때 로드된다(lazy)", () => {
  const { qubb: outerQubb, resmap } = buildFixtureWithResmap("lazy_res_if");
  assert.equal(resmap.length, 1, "Styled의 CSS 하나가 resmap에 있다");

  // Outer = comp 0. props [show]. show=false로 시작 - @if 가지 비활성.
  const store = createLeafStoreSubject({ show: false });
  compile(outerQubb, resmap)(0)(store, ["show"]);
  assert.deepEqual(hrefs(), [], "가지가 꺼져 있으면 자식 CSS는 아직 로드되지 않는다");

  // show=true로 토글 → 가지 활성 → Styled RENDER → LOAD_RES 실행 → <link> 삽입.
  store.setPath("show", true);
  assert.deepEqual(hrefs(), resmap, "가지가 켜지면 그때 자식 CSS가 로드된다");
});
