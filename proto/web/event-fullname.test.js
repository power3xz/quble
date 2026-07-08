// 이벤트 fullname 통합 테스트 - 합성 시 자식 type-name이 경로에 누적돼, 자식이 쏜 이벤트가
// 짧은 이름(TOGGLE)이 아니라 fullname("Toggle.TOGGLE")으로 핸들러를 부른다. PUSH_PATH_SEGMENT가
// RENDER 앞에서 세그먼트를 적재하고 runtime이 pathPrefix로 누적한 결과를 본다.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./fixtures/dom.js";
import { buildFixture } from "./fixtures/build.js";

const { compile, createLeafStoreSubject } = await import("./runtime.ts");

let qubb;
before(() => {
  qubb = buildFixture("event_fullname");
});

// Card(부모, props 없음) 인스턴스 - 내부에서 Toggle을 합성. 클릭할 button을 돌려준다.
const instantiate = (handlers) => {
  const store = createLeafStoreSubject({});
  const inst = compile(qubb)(0)(store, [], handlers); // Card = comp 0, props 없음
  const host = mount(inst);
  return host.querySelector("button");
};

test("합성된 자식의 이벤트는 fullname(자식 type-name 누적)으로 핸들러를 부른다", () => {
  let called = 0;
  const button = instantiate({
    "Toggle.TOGGLE": () => {
      called += 1;
    },
  });
  button.click();
  assert.equal(called, 1, "Toggle.TOGGLE 핸들러 1회 호출");
});

test("짧은 이름(TOGGLE)으로는 안 불린다 - fullname만 매칭", () => {
  let shortCalled = 0;
  const button = instantiate({
    TOGGLE: () => {
      shortCalled += 1;
    },
  });
  button.click();
  assert.equal(shortCalled, 0, "fullname이 아닌 짧은 이름은 매칭 안 됨");
});
