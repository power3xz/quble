// 잠재 버그 확인 - @for 몸체 안 @if의 비활성 가지가 회차변수 슬롯(argumentSourcePairs)을 읽을 때,
// lazyBuild 지연 실행 시점엔 공유 pairs가 이 @for를 지나 이미 pop돼 있다. runIf의 snapshotStacks는
// walkStacks(loopIndexStack/activeContexts)만 카피하고 pairs는 공유 참조 캡처라, 회차변수({tag})가 어긋날 수 있다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_if_lazy_slot");
});

// @for (tag of tags) { @if (flag) { span.on {tag} } @else { span.off } }
// flag=false로 시작하면 각 회차 then({tag} 읽기)은 lazyBuild 대기.
const instantiate = (tags: string[], flag: boolean) => {
  const inst = compile(qubb)(0)({ tags, flag }, {});
  const host = mount(inst);
  return { host, setFlag: (v: boolean) => inst.store.set(1, v) };
};

const onTexts = (host: ParentNode) => [...host.querySelectorAll("span.on")].map((s) => s.textContent);

test("초기 활성 then은 각 회차의 {tag}를 표시한다", () => {
  const { host } = instantiate(["a", "b", "c"], true);
  assert.deepEqual(onTexts(host), ["a", "b", "c"]);
});

test("나중에 활성화(lazyBuild)된 @for 안 @if then도 회차변수 슬롯({tag})이 정합한다", () => {
  const { host, setFlag } = instantiate(["a", "b", "c"], false);
  assert.equal(onTexts(host).length, 0, "flag=false: then 미빌드");
  setFlag(true); // 각 회차 then 지연 build - 이 시점 pairs는 pop돼 있어도 {tag}는 자기 요소여야
  assert.deepEqual(onTexts(host), ["a", "b", "c"], "lazyBuild된 각 회차의 {tag} = 자기 요소");
});
