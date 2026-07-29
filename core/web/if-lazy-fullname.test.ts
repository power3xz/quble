// 회귀 테스트 - 합성 자식 def 안의 @if가 "초기 비활성 -> 나중 활성화(lazyBuild)"될 때, 그
// 지연 build되는 가지 안 이벤트의 fullname이 부모 합성 세그먼트(Child)를 여전히 누적하는지.
//
// pathPrefix를 클로저가 캡처하던 걸 pathSegments 필드(RENDER에서 push/pop)로 바꾼 리팩토링이
// 이 경로를 깨뜨릴 수 있다: buildThen/buildElse가 나중에 호출될 땐 pathSegments가 이미 pop돼
// 비어 있어, fullname이 "PICK"(회귀)이 되고 "Child.PICK"이 안 된다. 이 테스트가 그걸 잡는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("if_lazy_fullname");
});

// Parent(props { cond: bool }) -> 자식 Child를 합성. Child 안 @if(cond)의 then 가지에 이벤트 PICK.
// cond=false로 시작하면 then은 lazyBuild 대기(else "no" 활성). cond leaf는 root prop 하나라 index 0.
const instantiate = (cond: boolean, handlers: THandlers) => {
  const inst = compile(qubb)(0)({ cond }, handlers);
  const host = mount(inst);
  return { host, set: (v: unknown) => inst.store.set(0, v) };
};

test("초기 활성 then의 이벤트는 fullname(Child.PICK)으로 불린다", () => {
  let called = 0;
  const { host } = instantiate(true, {
    "Child.PICK": () => {
      called += 1;
    },
  });
  host.querySelector("button")!.click();
  assert.equal(called, 1, "cond=true 초기 build: Child.PICK 1회");
});

test("나중에 활성화(lazyBuild)된 then의 이벤트도 fullname(Child.PICK)을 유지한다", () => {
  let called = 0;
  const { host, set } = instantiate(false, {
    "Child.PICK": () => {
      called += 1;
    },
  });
  assert.equal(host.querySelector("button"), null, "cond=false: then 미빌드(button 없음)");
  set(true); // then 가지 지연 build - 이 시점 pathSegments가 비어도 fullname은 Child.PICK이어야
  host.querySelector("button")!.click();
  assert.equal(called, 1, "lazyBuild된 then: Child.PICK 1회");
});
