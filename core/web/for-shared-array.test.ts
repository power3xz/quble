// 같은 배열을 두 @for가 순회할 때 - arrayInfo는 하나인데 @for region은 둘이다.
//
// TArrayInfo.forRegionIndex가 region을 하나만 들어(region.ts), 나중에 순회한 @for가 앞의 것을
// 덮어쓴다(reactiveArrayFor). 중간 제거(removeAt)는 그 하나에만 removeBranchAt으로 지정 회차를
// 떼고, 나머지 @for는 길이 칸 구독(onSize)의 truncateFor가 꼬리를 뗀다. 개수는 같아지지만 사라진
// 요소가 서로 다르다 - 한쪽은 지운 요소가, 다른 쪽은 마지막 요소가 빠진다.
//
// 이 테스트는 그 결함을 못박는다. 고쳐지면 두 목록이 같아지므로 단언을 바꿔야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_shared_array");
});

const firstList = (host: ParentNode) => [...host.querySelectorAll(".a")].map((n) => n.textContent);
const secondList = (host: ParentNode) => [...host.querySelectorAll(".b")].map((n) => n.textContent);

const instantiate = () => {
  const handlers: THandlers = {
    DEL: (_d: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const removeAt = ctx.removeAt as (arrayNode: unknown, i: number) => void;
      const props = ctx.props as Record<string, unknown>;
      removeAt(props.tags, 0);
    },
  };
  const inst = compile(qubb)(0)({ tags: ["t0", "t1", "t2"] }, handlers);
  const host = mount(inst);
  return { host, button: host.querySelector(".del") as HTMLButtonElement };
};

test("같은 배열을 두 @for가 순회하면 양쪽 다 그려진다", () => {
  const { host } = instantiate();
  assert.deepEqual(firstList(host), ["t0", "t1", "t2"], "첫 목록");
  assert.deepEqual(secondList(host), ["t0", "t1", "t2"], "둘째 목록");
});

test("[결함] 요소를 제거하면 한쪽 회차 DOM만 떨어진다", () => {
  const { host, button } = instantiate();

  button.click(); // removeAt(tags, 0)

  // forRegionIndex를 가진 쪽(나중 @for)만 removeBranchAt으로 0번 회차를 정확히 뗀다.
  assert.deepEqual(secondList(host), ["t1", "t2"], "나중 @for는 지정한 요소가 빠진다");
  // 먼저 @for는 그 호출을 못 받고 길이 칸 구독(onSize)의 truncateFor가 꼬리를 뗀다 - 개수는 맞지만
  // 남은 회차가 t0/t1을 그대로 봐 t2가 사라진 것처럼 나온다. 지운 요소가 양쪽에서 다르다.
  assert.deepEqual(firstList(host), ["t0", "t1"], "[결함] 먼저 @for는 꼬리가 잘려 다른 요소가 사라진다");
});
