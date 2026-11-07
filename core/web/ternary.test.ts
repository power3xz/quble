// 삼항 - 처음 그릴 때 정적 그래프(exprInputs)를 따라 식 인스턴스를 만든다. 삼항은 cond를 센 뒤 고른 갈래만 만들고,
// 계산 식은 입력 식의 인스턴스를 공유하거나 만들어 그 값을 읽는다. 입력 인스턴스는 그 scope(입력 식의 level 깊이)에서
// 공유하고, 읽는 식 인스턴스가 모두 반납되면 함께 반납된다.
//
// 입력이 바뀌면 그 입력을 읽는 식 인스턴스에서 활성 간선(cond와 고른 갈래)을 따라 위로 표시하고, DOM에 직접 쓰이는
// 인스턴스부터 다시 센다. 고르지 않은 갈래는 세지 않는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

type TCtx = {
  props: Record<string, unknown>;
  set: (k: unknown, v: unknown) => void;
};

// 클릭으로 부른 핸들러 끝의 flush에서 난 에러는 click()까지 올라오지 않고 jsdom이 window의 error 이벤트로 보고한다.
let handlerError: unknown = null;
document.defaultView?.addEventListener("error", (e) => {
  handlerError = e.error;
  e.preventDefault();
});

// 픽스처 components/<fixture>.fixture.qubc의 첫 컴포넌트를 data로 그려, 클래스 cls인 요소들의 텍스트와 살아 있는 식
// 인스턴스 수를 읽는 함수를 돌려준다. 루트 props는 늘 첫 컴포넌트(defs[0])의 props 타입으로 심기므로 경우마다
// 픽스처를 따로 둔다. apply(act)는 픽스처의 apply 버튼을 눌러 APPLY 핸들러 안에서 act를 실행한다.
const render = (fixture: string, data: unknown, handlers: THandlers = {}) => {
  let act: (ctx: TCtx) => void = () => {};
  const inst = compile(buildFixture(fixture))(0)(data, {
    ...handlers,
    APPLY: (_data, ctx) => act(ctx as unknown as TCtx),
  });
  const host = mount(inst);
  return {
    host,
    textsOf: (cls: string) => [...host.querySelectorAll(`.${cls}`)].map((el) => el.textContent),
    liveExprInstances: () => inst.exprInstances.entries.length - inst.exprInstances.free.length,
    apply: (next: (ctx: TCtx) => void) => {
      act = next;
      handlerError = null;
      (host.querySelector(".apply") as HTMLButtonElement).click();
      assert.equal(handlerError, null);
    },
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

test("cond leaf가 바뀌면 새로 고른 갈래의 값을 그린다", () => {
  const { textsOf, apply } = render("ternary_value", { ok: true, price: 5 });
  apply((ctx) => ctx.set(ctx.props.ok, false));
  assert.deepEqual(textsOf("v"), ["0"]);
  apply((ctx) => ctx.set(ctx.props.ok, true));
  assert.deepEqual(textsOf("v"), ["5"]);
});

test("고르지 않은 잎 갈래가 바뀌어도 값은 그대로고, 다시 고르면 바뀐 값을 그린다", () => {
  const { textsOf, apply } = render("ternary_value", { ok: false, price: 5 });
  apply((ctx) => ctx.set(ctx.props.price, 7));
  assert.deepEqual(textsOf("v"), ["0"]);
  apply((ctx) => ctx.set(ctx.props.ok, true));
  assert.deepEqual(textsOf("v"), ["7"]);
  apply((ctx) => ctx.set(ctx.props.price, 8));
  assert.deepEqual(textsOf("v"), ["8"], "다시 고른 잎 갈래를 구독한다");
});

test("삼항을 입력으로 받는 계산 식의 배열 인덱스가 바뀌면 새 요소의 leaf를 구독한다", () => {
  const { textsOf, apply } = render("ternary_index_input", { ok: true, cursor: 0, rows: [{ x: 1 }, { x: 2 }] });
  assert.deepEqual(textsOf("v"), ["11"]); // 1 + 10
  apply((ctx) => ctx.set(ctx.props.cursor, 1));
  assert.deepEqual(textsOf("v"), ["12"]);
  apply((ctx) => {
    const rows = ctx.props.rows as Record<number, Record<string, unknown>>;
    ctx.set(rows[1].x, 5);
  });
  assert.deepEqual(textsOf("v"), ["15"]);
});

test("입력 삼항의 값이 바뀌면 그 값을 읽는 계산 식이 모두 다시 센다", () => {
  const { textsOf, apply } = render("ternary_shared", { ok: true, price: 5, base: 9 });
  apply((ctx) => ctx.set(ctx.props.price, 3));
  assert.deepEqual(textsOf("a"), ["6"]); // 9 - 3
  assert.deepEqual(textsOf("b"), ["9"]); // 3 * 3
  apply((ctx) => ctx.set(ctx.props.ok, false));
  assert.deepEqual(textsOf("a"), ["9"]); // 9 - 0
  assert.deepEqual(textsOf("b"), ["0"]); // 0 * 0
});

test("처음 고르는 식 갈래는 그때 인스턴스를 만든다", () => {
  const { textsOf, liveExprInstances, apply } = render("ternary_lazy", { ok: false, cursor: 0, rows: [{ x: 1 }] });
  assert.equal(liveExprInstances(), 1); // 삼항 하나
  apply((ctx) => ctx.set(ctx.props.ok, true));
  assert.deepEqual(textsOf("v"), ["1"]);
  assert.equal(liveExprInstances(), 2); // 삼항 하나, 참 갈래 하나
});

test("cond가 떠나는 갈래를 고르지 않게 바뀌면 그 갈래를 세지 않는다", () => {
  // 한 flush에서 ok와 cursor가 함께 바뀐다. 참 갈래 rows[cursor].x를 세면 cursor 5가 범위 밖이라 RangeError다.
  const { textsOf, apply } = render("ternary_lazy", { ok: true, cursor: 0, rows: [{ x: 1 }] });
  apply((ctx) => {
    ctx.set(ctx.props.ok, false);
    ctx.set(ctx.props.cursor, 5);
  });
  assert.deepEqual(textsOf("v"), ["0"]);
});

test("@for 안 삼항이 함께 쓰는 level 0 갈래가 바뀌면 모든 행이 다시 센다", () => {
  const { textsOf, apply } = render("ternary_in_for", { ok: true, price: 5, rows: [{ x: 1 }, { x: 2 }] });
  apply((ctx) => ctx.set(ctx.props.price, 6));
  assert.deepEqual(textsOf("v"), ["12", "12"]);
  apply((ctx) => ctx.set(ctx.props.ok, false));
  assert.deepEqual(textsOf("v"), ["1", "2"]);
});
