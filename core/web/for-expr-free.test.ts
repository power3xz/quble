// 보간 식과 속성 식의 결과 leaf 회수 - 식이 든 @for 회차가 없어질 때 그 회차의 결과 leaf를 store에 반납해,
// 회차를 더하고 지우는 주기를 되풀이해도 leaves가 계속 커지지 않는지 본다.
//
// store는 leaves를 안 내놓으므로 살아 있는 leaf 수를 간접으로 잰다(liveLeaves). 회차를 더했다 지우면 그 수가 처음과
// 같아야 한다.

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
  // 살아 있는 leaf 수(leaves의 길이 - free list의 빈 칸). 빈 leaf를 PROBES개 잡으면 앞쪽은 free list의 재사용분이고
  // 나머지는 끝에서 이어 붙는다. 그래서 가장 큰 번호 + 1 - PROBES가 곧 그 수다(PROBES가 free list보다 클 때). 잰 뒤
  // 모두 되돌려 둔다.
  const PROBES = 1000;
  const liveLeaves = () => {
    const probes: number[] = [];
    for (let i = 0; i < PROBES; i++) {
      probes.push(inst.store.alloc([0]));
    }
    const live = Math.max(...probes) + 1 - PROBES;
    for (const probe of probes.reverse()) {
      inst.store.free(probe, 1);
    }
    return live;
  };
  return {
    host,
    liveLeaves,
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
  const { liveLeaves, add, del } = instantiate([1, 2], [5, 6, 7, 8], [2, 2, 2, 2]);
  const before = liveLeaves();
  add();
  del();

  const lives: number[] = [];
  for (let i = 0; i < 3; i++) {
    add();
    del();
    lives.push(liveLeaves());
  }

  assert.deepEqual(lives, [before, before, before], "회차를 더했다 지우면 살아 있는 leaf 수가 처음과 같다");
});
