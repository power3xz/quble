// 삼항 - 처음 그릴 때 정적 그래프(exprInputs)를 따라 식 인스턴스를 만든다. 삼항은 cond를 센 뒤 고른 갈래만 만들고,
// 계산 식은 입력 식의 인스턴스를 공유하거나 만들어 그 값을 읽는다. 입력 인스턴스는 그 scope(입력 식의 level 깊이)에서
// 공유하고, 읽는 식 인스턴스가 모두 반납되면 함께 반납된다.
//
// 갱신(입력이 바뀐 뒤 다시 세기)은 아직 없다. 여기서는 처음 그리기와 반납만 본다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

// 픽스처 components/<fixture>.fixture.qubc의 첫 컴포넌트를 data로 그려, 클래스 cls인 요소들의 텍스트와 살아 있는 식
// 인스턴스 수를 읽는 함수를 돌려준다. 루트 props는 늘 첫 컴포넌트(defs[0])의 props 타입으로 심기므로 경우마다
// 픽스처를 따로 둔다.
const render = (fixture: string, data: unknown, handlers: THandlers = {}) => {
  const inst = compile(buildFixture(fixture))(0)(data, handlers);
  const host = mount(inst);
  return {
    host,
    textsOf: (cls: string) => [...host.querySelectorAll(`.${cls}`)].map((el) => el.textContent),
    liveExprInstances: () => inst.exprInstances.entries.length - inst.exprInstances.free.length,
  };
};

test("삼항은 cond로 고른 갈래의 값을 그린다", () => {
  assert.deepEqual(render("ternary_value", { ok: true, price: 5 }).textsOf("v"), ["5"]);
  assert.deepEqual(render("ternary_value", { ok: false, price: 5 }).textsOf("v"), ["0"]);
});

test("같은 scope의 두 계산 식이 입력 삼항의 인스턴스 하나를 함께 쓴다", () => {
  const { textsOf, liveExprInstances } = render("ternary_shared", { ok: true, price: 5, base: 9 });
  assert.deepEqual(textsOf("a"), ["4"]); // 9 - 5
  assert.deepEqual(textsOf("b"), ["25"]); // 5 * 5
  assert.equal(liveExprInstances(), 3); // 삼항 하나, 계산 식 둘
});

test("고르지 않은 갈래는 인스턴스를 만들지 않아 세지 않는다", () => {
  // 참 갈래 rows[cursor].x는 cursor 5가 범위 밖이라 세면 RangeError다.
  const { textsOf, liveExprInstances } = render("ternary_lazy", { ok: false, cursor: 5, rows: [{ x: 1 }] });
  assert.deepEqual(textsOf("v"), ["0"]);
  assert.equal(liveExprInstances(), 1); // 삼항 하나
});

test("@for 안 삼항의 level 0 갈래는 root scope의 인스턴스 하나를 행들이 함께 쓴다", () => {
  const { textsOf, liveExprInstances } = render("ternary_in_for", { ok: true, price: 5, rows: [{ x: 1 }, { x: 2 }] });
  assert.deepEqual(textsOf("v"), ["10", "10"]); // price * 2
  assert.equal(liveExprInstances(), 3); // price * 2 하나, 행마다 삼항 하나
});

test("행을 지우면 그 행의 삼항이 반납되고, 읽는 행이 모두 없어지면 공유하던 갈래도 반납된다", () => {
  const handlers: THandlers = {
    "Item[$0].DROP": (_data, ctx) => {
      const removeAt = ctx.removeAt as (array: unknown, index: number) => void;
      removeAt((ctx.store as Record<string, unknown>).rows, ctx.$0 as number);
    },
  };
  const { host, textsOf, liveExprInstances } = render(
    "ternary_in_for",
    { ok: true, price: 5, rows: [{ x: 1 }, { x: 2 }] },
    handlers,
  );
  const dropFirst = () => (host.querySelector(".drop") as HTMLButtonElement).click();

  dropFirst();
  assert.deepEqual(textsOf("v"), ["10"]);
  assert.equal(liveExprInstances(), 2); // price * 2 하나, 남은 행의 삼항 하나

  dropFirst();
  assert.deepEqual(textsOf("v"), []);
  assert.equal(liveExprInstances(), 0);
});
