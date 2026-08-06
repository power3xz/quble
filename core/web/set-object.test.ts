// 객체 노드 통째 교체(setObject) - 노드가 실어 둔 자리(NODE_BASE/NODE_TYPE)로 고정 블록을 덮어쓴다.
//
// 확인할 것이 셋이다. 하나는 준 필드가 실제로 store에 들어가 화면까지 오는가. 둘은 안 준 필드가
// undefined가 되는가 - 이게 교체와 병합을 가르는 지점이라, 옛 값이 남으면 병합이 된 것이다.
// 셋은 배열 필드가 요소까지 함께 갈리는가 - 배열 칸은 값이 아니라 arrayInfoIndex라 set을 하면
// 포인터가 깨지고, replaceInto로 재귀해야 @for 회차까지 따라온다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("set_object");
});

type TUser = { name: string; age: number; tags: string[]; contact: { email: string } };

const textOf = (host: ParentNode, sel: string) => host.querySelector(sel)?.textContent;
const tagsOf = (host: ParentNode) => [...host.querySelectorAll(".tag")].map((n) => n.textContent);

// SWAP을 누르면 큐에서 다음 값을 꺼내 user 노드를 통째로 갈아끼운다.
const handlersFor = (queue: Partial<TUser>[]): THandlers => ({
  SWAP: (_data: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const setObject = ctx.setObject as (node: unknown, v: unknown) => void;
    const props = ctx.props as Record<string, unknown>;
    const next = queue.shift();
    if (next !== undefined) {
      setObject(props.user, next);
    }
  },
});

const USER: TUser = {
  name: "kim",
  age: 30,
  tags: ["a", "b"],
  contact: { email: "kim@x.com" },
};

const instantiate = (queue: Partial<TUser>[] = []) => {
  const inst = compile(qubb)(0)({ title: "t", user: USER }, handlersFor(queue));
  const host = mount(inst);
  return { host, h1: host.querySelector("h1") as HTMLElement };
};

test("준 필드가 화면까지 반영된다", () => {
  const { host, h1 } = instantiate([{ name: "lee", age: 41, tags: ["x"], contact: { email: "lee@y.com" } }]);
  assert.equal(textOf(host, ".name"), "kim", "초기");

  h1.click();
  assert.equal(textOf(host, ".name"), "lee");
  assert.equal(textOf(host, ".age"), "41");
  assert.equal(textOf(host, ".email"), "lee@y.com", "중첩 객체도 내려간다");
});

// 교체라 안 준 필드는 옛 값이 남지 않는다. 병합이면 여기서 age가 30으로 남는다.
test("안 준 필드는 undefined가 된다", () => {
  const { host, h1 } = instantiate([{ name: "park" }]);
  assert.equal(textOf(host, ".age"), "30", "초기");

  h1.click();
  assert.equal(textOf(host, ".name"), "park");
  assert.equal(textOf(host, ".age"), "", "안 준 필드는 비워진다");
  assert.equal(textOf(host, ".email"), "", "중첩 객체 안쪽도 비워진다");
});

// 배열 칸은 arrayInfoIndex라 set으로 덮으면 포인터가 깨진다 - replaceInto로 재귀해야 요소와
// @for 회차가 함께 간다.
test("배열 필드는 요소와 @for 회차까지 갈린다", () => {
  const { host, h1 } = instantiate([{ name: "choi", age: 1, tags: ["p", "q", "r"], contact: { email: "c@z.com" } }]);
  assert.deepEqual(tagsOf(host), ["a", "b"], "초기");

  h1.click();
  assert.deepEqual(tagsOf(host), ["p", "q", "r"], "늘어난 쪽");
});

test("배열 필드를 안 주면 비워진다", () => {
  const { host, h1 } = instantiate([{ name: "han" }]);
  assert.deepEqual(tagsOf(host), ["a", "b"], "초기");

  h1.click();
  assert.deepEqual(tagsOf(host), [], "안 준 배열은 요소가 없어진다");
});

// 노드를 두 번 갈아끼워도 자리가 유지되는지 - 첫 교체가 base/typeRef를 흔들면 두 번째가 어긋난다.
test("연속으로 갈아끼워도 자리가 유지된다", () => {
  const { host, h1 } = instantiate([
    { name: "one", age: 1, tags: ["1"], contact: { email: "1@x" } },
    { name: "two", age: 2, tags: ["2", "3"], contact: { email: "2@x" } },
  ]);

  h1.click();
  assert.equal(textOf(host, ".name"), "one");
  assert.deepEqual(tagsOf(host), ["1"]);

  h1.click();
  assert.equal(textOf(host, ".name"), "two");
  assert.equal(textOf(host, ".email"), "2@x");
  assert.deepEqual(tagsOf(host), ["2", "3"]);
});
