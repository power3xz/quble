// 보간 식과 속성 식의 결과 leaf 회수 - 식이 든 @for 회차가 없어질 때 그 회차의 결과 leaf를 store에 반납해,
// 회차를 더하고 지우는 주기를 되풀이해도 leaves가 계속 커지지 않는지 본다.
//
// store는 leaves를 안 내놓으므로 끝 leafIndex를 직접 잰다 - 빈 칸 하나를 alloc해 번호를 받고 곧바로 free하면
// 그 번호가 지금 leaves의 끝이다. 첫 주기는 free list를 채우는 몫이라 건너뛰고, 그다음 주기부터 끝이 그대로여야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_expr_free");
});

const texts = (host: ParentNode) => [...host.querySelectorAll(".num")].map((li) => li.textContent);
const titles = (host: ParentNode) => [...host.querySelectorAll(".num")].map((li) => li.getAttribute("title"));

const instantiate = (nums: number[], addQueue: number[] = [], delQueue: number[] = []) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (a: number, e: unknown) => void;
      const props = ctx.props as Record<string, number>;
      const v = addQueue.shift();
      if (v !== undefined) {
        push(props.nums, v);
      }
    },
    DEL: (_d, ctx) => {
      const removeAt = ctx.removeAt as (a: number, i: number) => void;
      const props = ctx.props as Record<string, number>;
      removeAt(props.nums, delQueue.shift() as number);
    },
  };
  const inst = compile(qubb)(0)({ nums }, handlers);
  const host = mount(inst);
  const leavesEnd = () => {
    const probe = inst.store.alloc([0]);
    inst.store.free(probe, 1);
    return probe;
  };
  return {
    host,
    leavesEnd,
    add: () => (host.querySelector(".add") as HTMLButtonElement).click(),
    del: () => (host.querySelector(".del") as HTMLButtonElement).click(),
  };
};

test("보간 식과 속성 식이 든 회차를 더하면 화면에 반영된다", () => {
  const { host, add } = instantiate([1, 2], [5]);
  assert.deepEqual(texts(host), ["2", "4"]);
  assert.deepEqual(titles(host), ["2", "3"]);

  add();

  assert.deepEqual(texts(host), ["2", "4", "10"]);
  assert.deepEqual(titles(host), ["2", "3", "6"]);
});

test("회차를 더하고 지우는 주기를 되풀이해도 leaves의 끝이 늘지 않는다", () => {
  // 행이 둘인 상태에서 더하면 인덱스 2가 마지막이다. 주기마다 그 마지막 행을 지운다.
  const { leavesEnd, add, del } = instantiate([1, 2], [5, 6, 7, 8], [2, 2, 2, 2]);
  add();
  del();
  const afterFirst = leavesEnd();

  const ends: number[] = [];
  for (let i = 0; i < 3; i++) {
    add();
    del();
    ends.push(leavesEnd());
  }

  assert.deepEqual(ends, [afterFirst, afterFirst, afterFirst]);
});
