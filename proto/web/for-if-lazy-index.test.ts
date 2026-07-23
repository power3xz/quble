// 회귀 테스트 - @for 안 @if가 "초기 비활성 → 나중 활성화(lazyBuild)"될 때, 그 지연 build되는
// 가지 안 이벤트의 회차 인덱스($0)가 정합한지. loopIndexStack이 @for 축의 push/pop 공유 배열이라,
// lazyBuild 지연 실행 시점엔 이미 pop돼 비어 있을 수 있다 - 그럼 $0가 어긋난다.
//
// pathPrefix(문자열)는 값으로 캡처돼 파라미터면 안전했지만, loopIndexStack(배열)은 공유·가변이라
// 파라미터로 넘겨도 같은 배열이 pop되면 잃는다. 이 테스트가 그 축을 잡는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_if_lazy_index");
});

// props { n: number, flag: bool } → leafIndex n=0, flag=1.
// @for (i of n) { @if (flag) { button(@click:PICK) } @else { span } }
// flag=false로 시작하면 각 회차 then(button)은 lazyBuild 대기(else "off" 활성).
const instantiate = (n: number, flag: boolean, handlers: THandlers) => {
  const inst = compile(qubb)(0)({ n, flag }, handlers);
  const host = mount(inst);
  return { host, setFlag: (v: boolean) => inst.store.set(1, v) };
};

test("초기 활성 then의 회차 이벤트는 [$0].PICK으로 불린다", () => {
  const picks: number[] = [];
  const { host } = instantiate(3, true, {
    "[$0].PICK": (_data, ctx: any) => {
      picks.push(ctx.$0);
    },
  });
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 3, "3회차 button");
  buttons.forEach((b) => b.click());
  assert.deepEqual(picks, [0, 1, 2], "각 회차 button의 $0 = 회차 인덱스");
});

test("나중에 활성화(lazyBuild)된 @for 안 @if의 회차 이벤트도 $0가 정합한다", () => {
  const picks: number[] = [];
  const { host, setFlag } = instantiate(3, false, {
    "[$0].PICK": (_data, ctx: any) => {
      picks.push(ctx.$0);
    },
  });
  assert.equal(host.querySelectorAll("button").length, 0, "flag=false: then 미빌드");
  setFlag(true); // 각 회차 then 지연 build - 이 시점 loopIndexStack이 비어도 $0는 회차 인덱스여야
  const buttons = [...host.querySelectorAll("button")];
  assert.equal(buttons.length, 3, "flag=true 후 3회차 button");
  buttons.forEach((b) => b.click());
  assert.deepEqual(picks, [0, 1, 2], "lazyBuild된 회차 button의 $0 = 회차 인덱스");
});
