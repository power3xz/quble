// 회귀 테스트 - 배열 @for 안 @if가 있을 때 push(grow)로 회차를 늘리면 순서가 유지되는지.
// attachGrownIterations가 다음 회차 삽입점(after)을 직전 회차 branch.nodes 마지막으로 잡으면, 그게
// @if anchor라 그 뒤 @if 컨텐츠 앞에 끼어들어 역순이 된다 - branchTailNode로 실제 끝을 짚어 고쳤다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_if_push_order");
});

const tags = (host: ParentNode) => [...host.querySelectorAll("li")].map((li) => li.textContent);

const pushHandler = (queue: string[]): THandlers => ({
  ADD: (_data, ctx) => {
    const next = queue.shift();
    if (next !== undefined)
      (ctx.push as (i: number, e: unknown) => void)((ctx.props as Record<string, number>).tags, next);
  },
});

test("배열 @for 안 @if: push한 요소가 꼬리에 순서대로 렌더된다(역순 아님)", () => {
  const inst = compile(qubb)(0)({ tags: ["a"], flag: true }, pushHandler(["b", "c"]));
  const host = mount(inst);
  const button = host.querySelector("button.add")!;
  assert.deepEqual(tags(host), ["a"], "초기");
  (button as HTMLElement).click();
  assert.deepEqual(tags(host), ["a", "b"], "push b - 꼬리");
  (button as HTMLElement).click();
  assert.deepEqual(tags(host), ["a", "b", "c"], "push c - 꼬리");
});

test("배열 @for 안 @if: setArray로 회차가 한 번에 여럿 늘어도 순서와 구독이 유지된다", () => {
  let clicks = 0;
  const handlers: THandlers = {
    ADD: (_data, ctx) => {
      const props = ctx.props as Record<string, number>;
      if (clicks++ === 0) {
        (ctx.setArray as (array: number, elems: unknown[]) => void)(props.tags, ["a", "b", "c"]);
      } else {
        (ctx.set as (leafIndex: number, value: unknown) => void)(props.flag, false);
      }
    },
  };
  const inst = compile(qubb)(0)({ tags: ["a"], flag: true }, handlers);
  const host = mount(inst);
  const button = host.querySelector("button.add") as HTMLElement;
  const ul = host.querySelector("ul")!;

  button.click();
  assert.deepEqual(tags(host), ["a", "b", "c"], "회차 순서");

  button.click();
  assert.deepEqual(
    [...ul.querySelectorAll("li, span")].map((el) => el.textContent),
    ["off", "off", "off"],
    "새로 붙은 회차의 @if도 flag 구독으로 바뀐다",
  );
});
