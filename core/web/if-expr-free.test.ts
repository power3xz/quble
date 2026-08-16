// IF_EXPR이 잡은 파생 칸의 회수 - region이 없어질 때 그 칸을 store에 반납하는지 본다.
//
// IF는 부모 슬롯을 조건으로 그대로 쓰므로 region이 칸을 소유하지 않는다. IF_EXPR만 식의 결과를
// 담을 칸을 직접 alloc하고, 그래서 region이 free될 때 반납할 책임을 진다(region.ownsCondLeaf).
// 안 반납하면 회차가 늘고 줄 때마다 leaves가 새 칸을 물고 계속 커진다.
//
// 검증은 for-array-remove.test.ts와 같은 축이다 - store는 leaves를 안 내놓으므로 "새 칸을
// 안 늘렸는지"로 본다. 여기서는 region.condLeafIndex가 곧 파생 칸이라 그 번호를 직접 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("if_expr_in_for");
});

const marks = (host: ParentNode) => [...host.querySelectorAll("span")].map((s) => s.className);

const instantiate = (rows: Array<{ n: number }>, addQueue: Array<{ n: number }> = [], delQueue: number[] = []) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (a: number, e: unknown) => void;
      const props = ctx.props as Record<string, number>;
      const row = addQueue.shift();
      if (row !== undefined) {
        push(props.rows, row);
      }
    },
    DEL: (_d, ctx) => {
      const removeAt = ctx.removeAt as (a: number, i: number) => void;
      const props = ctx.props as Record<string, number>;
      const i = delQueue.shift();
      if (i !== undefined) {
        removeAt(props.rows, i);
      }
    },
  };
  const inst = compile(qubb)(0)({ rows }, handlers);
  const host = mount(inst);
  return {
    host,
    inst,
    add: host.querySelector(".add") as HTMLButtonElement,
    del: host.querySelector(".del") as HTMLButtonElement,
  };
};

// 살아 있는 @if region들의 파생 칸 번호. 루트 region(인덱스 0)은 조건 칸이 -1이라 빠진다.
const condLeaves = (inst: { regionPool: { entries: Array<{ condLeafIndex: number } | undefined> } }) =>
  inst.regionPool.entries.flatMap((r) => (r && r.condLeafIndex >= 0 ? [r.condLeafIndex] : []));

test("회차마다 파생 칸을 따로 잡는다", () => {
  const { host, inst } = instantiate([{ n: 1 }, { n: -1 }, { n: 2 }]);
  assert.deepEqual(marks(host), ["pos", "neg", "pos"], "회차별로 식이 따로 계산된다");
  // 회차 셋의 @if가 각자 칸을 하나씩 - 서로 다른 번호여야 한다(같이 쓰면 한쪽 값이 덮인다).
  const leaves = condLeaves(inst);
  assert.equal(new Set(leaves).size, leaves.length, `파생 칸이 겹치면 안 된다: ${leaves}`);
});

test("회차가 줄면 그 파생 칸이 반납되고 다음 회차가 재사용한다", () => {
  const { inst, del, add } = instantiate([{ n: 1 }, { n: 2 }, { n: 3 }], [{ n: 4 }], [1]);
  const maxBefore = Math.max(...condLeaves(inst));

  del.click(); // 가운데 회차 제거 -> 그 region이 free되며 파생 칸 반납
  add.click(); // 회차 추가 -> 새 region의 파생 칸이 반납분을 재사용

  const maxAfter = Math.max(...condLeaves(inst));
  assert.ok(maxAfter <= maxBefore, `반납분을 재사용해 최대 칸이 안 늘어야: before=${maxBefore} after=${maxAfter}`);
});

test("재사용된 칸이 새 회차의 값을 정확히 든다", () => {
  const { host, del, add } = instantiate([{ n: 1 }, { n: 2 }, { n: 3 }], [{ n: -9 }], [1]);
  assert.deepEqual(marks(host), ["pos", "pos", "pos"], "초기");

  del.click();
  assert.deepEqual(marks(host), ["pos", "pos"], "가운데 회차가 빠진다");

  // 재사용된 칸에 이전 회차의 참 값이 남아 있으면 여기서 pos가 나온다.
  add.click();
  assert.deepEqual(marks(host), ["pos", "pos", "neg"], "새 회차는 자기 값(-9)으로 계산");
});

test("회차를 여러 번 늘렸다 줄여도 칸이 무한히 늘지 않는다", () => {
  const rows = [{ n: 1 }, { n: 2 }];
  const addQueue = Array.from({ length: 6 }, (_, i) => ({ n: i + 10 }));
  const delQueue = [1, 1, 1, 1, 1, 1];
  const { inst, del, add } = instantiate(rows, addQueue, delQueue);

  // 첫 왕복이 이 인스턴스가 쓸 칸을 다 잡는다 - 없던 회차라 칸을 새로 늘리는 게 맞다.
  // 그 뒤 왕복은 반납분을 다시 쓰므로 칸이 더 안 늘어야 한다.
  //
  // 어느 자리를 주는지는 free list가 LIFO라 특정하지 않는다(제거된 회차 자리를 그대로 줄 수도,
  // 다른 반납분을 줄 수도 있다). 그래서 자리 번호가 아니라 "새 칸을 안 늘렸는지"로 본다 -
  // for-array-remove.test.ts의 재사용 검증과 같은 축이다.
  add.click();
  const ceiling = Math.max(...condLeaves(inst)); // 회차가 가장 많을 때 = 칸을 가장 많이 쓸 때
  del.click();

  for (let i = 0; i < 5; i++) {
    add.click();
    const peak = Math.max(...condLeaves(inst));
    assert.ok(peak <= ceiling, `왕복 ${i}: 칸이 새로 늘었다면 반납이 안 되고 있다(${peak} > ${ceiling})`);
    del.click();
  }
});
