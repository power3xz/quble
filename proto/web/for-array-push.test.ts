// 배열 요소 추가(push) - 핸들러가 ctx.push(props.tags, 값)로 배열에 요소를 심으면, tags를 순회하는 @for가
// grow해 새 요소를 렌더한다. push는 요소 고정부를 store에 alloc으로 심고 elemStartLeafIndices에 이은 뒤
// 길이 칸(sizeLeafIndex)을 set해 발화한다 - count grow와 같은 경로지만 회차변수가 요소 leaf(STORE)다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_push");
});

const tags = (host: ParentNode) => [...host.querySelectorAll(".tag")].map((t) => t.textContent);

const instantiate = (values: unknown, handlers: THandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  const button = host.querySelector(".add") as HTMLButtonElement;
  return { host, button };
};

// 클릭할 때마다 다음 태그를 push하는 핸들러. props.tags = 배열 칸 leafIndex(push 대상).
const pushHandler = (queue: string[]) => ({
  ADD: (_data: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
    const props = ctx.props as Record<string, number>;
    const next = queue.shift();
    if (next !== undefined) {
      push(props.tags, next);
    }
  },
});

test("초기 렌더: 초기 배열 요소를 순회해 표시", () => {
  const { host } = instantiate({ tags: ["a", "b"] });
  assert.deepEqual(tags(host), ["a", "b"], "초기 a·b");
});

test("빈 배열도 렌더된다(회차 0)", () => {
  const { host } = instantiate({ tags: [] });
  assert.deepEqual(tags(host), [], "빈 반복");
});

test("push: 추가한 요소가 꼬리에 렌더된다", () => {
  const { host, button } = instantiate({ tags: ["a"] }, pushHandler(["b", "c"]));
  assert.deepEqual(tags(host), ["a"], "초기 a");
  button.click();
  assert.deepEqual(tags(host), ["a", "b"], "push b");
  button.click();
  assert.deepEqual(tags(host), ["a", "b", "c"], "push c");
});

test("빈 배열에 push하면 첫 요소가 렌더된다", () => {
  const { host, button } = instantiate({ tags: [] }, pushHandler(["first"]));
  assert.deepEqual(tags(host), [], "초기 빈");
  button.click();
  assert.deepEqual(tags(host), ["first"], "빈 배열 -> first");
});
