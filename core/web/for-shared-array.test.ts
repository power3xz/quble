// 같은 배열을 두 @for가 순회할 때 - arrayInfo는 하나인데 @for region은 둘이다.
//
// arrayInfo가 region을 하나만 들면(옛 forRegionIndex) 나중 @for가 앞의 것을 덮어써, 중간 제거가
// 등록된 쪽에서만 지정 회차를 떼고 나머지는 길이 칸 구독(onSize)의 truncateFor가 꼬리를 뗐다.
// 개수는 같아지는데 사라진 요소가 서로 달라 조용히 어긋난다(t0,t1,t2 -> 한쪽 t1,t2 / 다른 쪽 t0,t1).
// 그래서 forRegionIndices로 순회하는 @for를 전부 들고 각각에 removeBranchAt을 건다.
//
// 인덱스 칸(indexLeafIndices)은 배열이 그대로 소유한다 - 자리 번호라 @for가 여럿이어도 값이 같고,
// 두 회차가 같은 칸을 함께 구독해 뒤 당김이 양쪽에 함께 반영된다.

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

test("요소를 제거하면 두 목록에서 같은 요소가 빠진다", () => {
  const { host, button } = instantiate();

  button.click(); // removeAt(tags, 0)

  assert.deepEqual(firstList(host), ["t1", "t2"], "먼저 @for도 0번이 빠진다");
  assert.deepEqual(secondList(host), ["t1", "t2"], "나중 @for도 같은 결과");
});
