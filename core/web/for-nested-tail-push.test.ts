// 회귀 테스트 - 바깥 @for 회차가 안쪽 @for로 끝날 때 바깥 배열에 push해도 되는지.
// attachGrownIterations가 직전 회차의 실제 끝 노드를 구하는 branchTailNode는 자식 region을 @if로만 가정해
// 안쪽 @for(shownIndex가 -1)에서 TypeError가 났다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_nested_tail_push");
});

const items = (host: ParentNode) => [...host.querySelectorAll("li")].map((li) => li.textContent);

const pushHandler = (queue: string[][]): THandlers => ({
  ADD: (_data, ctx) => {
    const cells = queue.shift();
    if (cells !== undefined) {
      (ctx.push as (arrayIndex: number, element: unknown) => void)((ctx.props as Record<string, number>).rows, {
        cells,
      });
    }
  },
});

test("바깥 회차가 안쪽 @for로 끝나도 push한 회차가 꼬리에 순서대로 렌더된다", () => {
  const inst = compile(qubb)(0)({ rows: [{ cells: ["a"] }] }, pushHandler([["b", "c"], ["d"]]));
  const host = mount(inst);
  const button = host.querySelector("button.add") as HTMLElement;
  assert.deepEqual(items(host), ["a"], "초기");
  button.click();
  assert.deepEqual(items(host), ["a", "b", "c"], "push - 안쪽 회차 둘");
  button.click();
  assert.deepEqual(items(host), ["a", "b", "c", "d"], "push - 이어서");
});

test("직전 회차의 안쪽 @for가 비어 있어도 push한 회차가 순서대로 렌더된다", () => {
  const inst = compile(qubb)(0)({ rows: [{ cells: [] }] }, pushHandler([["x"]]));
  const host = mount(inst);
  assert.deepEqual(items(host), [], "초기");
  (host.querySelector("button.add") as HTMLElement).click();
  assert.deepEqual(items(host), ["x"], "push");
});
