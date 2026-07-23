// destroy - 인스턴스 해체: 붙은 DOM·구독을 region 재귀로 떼고(detach), 루트 anchor와 document
// 위임 리스너를 제거한다. 리스너 클로저가 인터프리터(store/pool)를 잡아 살려두므로, destroy 없인
// 인스턴스가 GC되지 않는다. 해제 후 클릭은 핸들러를 부르지 않고, 다른 인스턴스는 무손상(격리).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("event_toggle");
});

const instantiate = () => {
  let count = 0;
  const handlers: THandlers = { TOGGLE: () => count++ };
  const inst = compile(qubb)(0)({ label: "t", on: "on" }, handlers);
  const host = mount(inst);
  const button = host.querySelector("button") as HTMLButtonElement;
  return { inst, host, button, fired: () => count };
};

test("destroy 후 클릭은 핸들러를 부르지 않는다(위임 리스너 해제)", () => {
  const { inst, button, fired } = instantiate();
  button.click();
  assert.equal(fired(), 1, "destroy 전엔 발화");
  inst.destroy();
  button.click();
  assert.equal(fired(), 1, "destroy 후엔 발화 없음");
});

test("destroy가 인스턴스 DOM을 전부 뗀다(anchor 포함)", () => {
  const { inst, host } = instantiate();
  assert.notEqual(host.querySelector("button"), null, "destroy 전엔 DOM 존재");
  inst.destroy();
  assert.equal(host.childNodes.length, 0, "destroy 후 host가 빈다");
});

test("한 인스턴스의 destroy는 다른 인스턴스에 영향 없다(격리)", () => {
  const a = instantiate();
  const b = instantiate();
  a.inst.destroy();
  b.button.click();
  assert.equal(b.fired(), 1, "b는 여전히 발화");
  assert.equal(a.fired(), 0, "a는 발화 없음");
});
