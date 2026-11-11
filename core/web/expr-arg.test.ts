// 합성 인자로 넘긴 식(`Total(total={price * qty} /)`) - 부모가 식 인스턴스를 만들어 결과 leaf를 자식에 넘긴다.
// 자식이 그 값을 텍스트로 읽을 때와 자식의 식(`total + 1`, `@if (total > limit)`) 안에서 읽을 때 모두 부모 입력이 바뀌면
// 따라와야 한다. 뒤쪽은 부모 식과 자식 식 사이에 그래프 간선이 없어 flush가 결과 leaf를 읽는 식도 세야 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compile } from "./runtime.ts";
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

const render = (data: unknown) => {
  let act: (ctx: TCtx) => void = () => {};
  const inst = compile(buildFixture("expr_arg"))(0)(data, {
    APPLY: (_data, ctx) => act(ctx as unknown as TCtx),
  });
  const host = mount(inst);
  return {
    text: (cls: string) => host.querySelector(`.${cls}`)?.textContent ?? null,
    hasOver: () => host.querySelector(".over") !== null,
    apply: (next: (ctx: TCtx) => void) => {
      act = next;
      handlerError = null;
      (host.querySelector(".apply") as HTMLButtonElement).click();
      assert.equal(handlerError, null);
    },
  };
};

test("식으로 넘긴 인자를 자식이 텍스트와 식과 조건에서 읽는다", () => {
  const view = render({ price: 4, qty: 5, limit: 10 });
  assert.equal(view.text("text"), "20");
  assert.equal(view.text("plus"), "21");
  assert.equal(view.hasOver(), true, "20 > 10");
});

test("부모 입력이 바뀌면 자식의 텍스트가 따라온다", () => {
  const view = render({ price: 4, qty: 5, limit: 10 });
  view.apply((ctx) => ctx.set(ctx.props.price, 6));
  assert.equal(view.text("text"), "30");
});

test("부모 입력이 바뀌면 자식의 식이 따라온다", () => {
  const view = render({ price: 4, qty: 5, limit: 10 });
  view.apply((ctx) => ctx.set(ctx.props.price, 6));
  assert.equal(view.text("plus"), "31", "total + 1");
});

test("부모 입력이 바뀌면 자식의 조건이 따라온다", () => {
  const view = render({ price: 4, qty: 5, limit: 10 });
  view.apply((ctx) => ctx.set(ctx.props.price, 1));
  assert.equal(view.hasOver(), false, "5 > 10이 아니다");
  view.apply((ctx) => ctx.set(ctx.props.price, 3));
  assert.equal(view.hasOver(), true, "15 > 10");
});

test("자식이 읽는 다른 prop(limit)이 바뀌어도 조건이 따라온다", () => {
  const view = render({ price: 4, qty: 5, limit: 10 });
  view.apply((ctx) => ctx.set(ctx.props.limit, 50));
  assert.equal(view.hasOver(), false, "20 > 50이 아니다");
});
