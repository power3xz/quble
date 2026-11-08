// 인덱스 접근은 주소 식(`rows[pivot]`)과 값 읽기 식(주소에 필드 거리를 더해 그 leaf를 읽는 식)으로 나뉘고, 감싼 식은
// 값 읽기 식을 입력으로 읽는다. `@for` 안에서 바깥 배열을 인덱스로 읽으면 두 식은 root scope에 하나씩만 생겨 모든 행이
// 함께 사용한다. 인덱스가 바뀌어 읽는 leaf가 달라지면 값 읽기 식 하나만 구독을 옮긴다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

type TCtx = {
  props: Record<string, unknown>;
  set: (k: unknown, v: unknown) => void;
};

// props 선언 순서가 곧 고정부 leafIndex. 0=pivot 1=rows. rows 요소는 {price} 1 leaf라 요소 i의 price = 2 + i.
const priceLeaf = (i: number) => 2 + i;

// 픽스처 index_read_in_for를 rows 셋으로 그린다. apply(act)는 APPLY 핸들러 안에서 act를 실행한다.
// subscriberCount(leafIndex)는 그 leaf를 파생 구독한 식 인스턴스 수다.
const render = () => {
  let act: (ctx: TCtx) => void = () => {};
  const inst = compile(buildFixture("index_read_in_for"))(0)(
    { pivot: 0, rows: [{ price: 10 }, { price: 20 }, { price: 30 }] },
    { APPLY: (_data, ctx) => act(ctx as unknown as TCtx) },
  );
  const host = mount(inst);
  return {
    texts: () => [...host.querySelectorAll(".v")].map((el) => el.textContent),
    liveExprInstances: () => inst.exprInstances.entries.length - inst.exprInstances.free.length,
    subscriberCount: (leafIndex: number) => {
      const slot = inst.deriveSubscribers[leafIndex];
      return slot === undefined ? 0 : typeof slot === "number" ? 1 : slot.size;
    },
    apply: (next: (ctx: TCtx) => void) => {
      act = next;
      (host.querySelector(".apply") as HTMLButtonElement).click();
    },
  };
};

test("@for 안의 rows[pivot].price는 root의 주소 식과 값 읽기 식을 모든 행이 함께 사용한다", () => {
  const { texts, liveExprInstances } = render();
  assert.deepEqual(texts(), ["0", "10", "20"]);
  assert.equal(liveExprInstances(), 5); // 주소 식 하나, 값 읽기 식 하나, 행마다 감싼 식 하나
});

test("pivot이 바뀌면 모든 행이 새 요소의 값으로 다시 센다", () => {
  const { texts, apply } = render();
  apply((ctx) => ctx.set(ctx.props.pivot, 2));
  assert.deepEqual(texts(), ["-20", "-10", "0"]);
});

test("pivot이 바뀌면 값 읽기 식이 옛 요소의 leaf 구독을 풀고 새 요소의 leaf에 건다", () => {
  const { subscriberCount, apply } = render();
  // 요소 0의 price는 행 0의 감싼 식(row.price)과 값 읽기 식이 구독한다.
  assert.equal(subscriberCount(priceLeaf(0)), 2);
  assert.equal(subscriberCount(priceLeaf(2)), 1);

  apply((ctx) => ctx.set(ctx.props.pivot, 2));

  assert.equal(subscriberCount(priceLeaf(0)), 1, "값 읽기 식이 요소 0의 구독을 푼다");
  assert.equal(subscriberCount(priceLeaf(2)), 2, "값 읽기 식이 요소 2에 건다");
});

test("pivot이 가리키는 요소의 값이 바뀌면 모든 행이 따라온다", () => {
  const { texts, apply } = render();
  apply((ctx) => ctx.set(ctx.props.pivot, 2));
  apply((ctx) => {
    const rows = ctx.props.rows as Record<number, Record<string, unknown>>;
    ctx.set(rows[2].price, 35);
  });
  assert.deepEqual(texts(), ["-25", "-15", "0"]);
});
