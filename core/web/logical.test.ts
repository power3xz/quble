// `&&`/`||` - 오른쪽이 식이면 컴파일러가 삼항으로 낸다(`a && b`는 `a ? b : false`). 왼쪽이 결과를 정하면 오른쪽 식은
// 인스턴스를 만들지도, 읽지도, 다시 세지도 않는다. 가드로 쓴 `ok && rows[cursor].x > 0`이 범위 밖 인덱스에서 throw하지
// 않는 것이 그 증거다.

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

// 픽스처 components/<fixture>.fixture.qubc의 첫 컴포넌트를 data로 그린다. apply(act)는 픽스처의 apply 버튼을 눌러
// APPLY 핸들러 안에서 act를 실행하고, 그 flush에서 에러가 없어야 한다.
const render = (fixture: string, data: unknown) => {
  let act: (ctx: TCtx) => void = () => {};
  const inst = compile(buildFixture(fixture))(0)(data, {
    APPLY: (_data, ctx) => act(ctx as unknown as TCtx),
  });
  const host = mount(inst);
  return {
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

test("&&는 왼쪽이 true일 때만 오른쪽 값을 낸다", () => {
  assert.deepEqual(render("logical_and", { ok: true, price: 5, qty: 3 }).textsOf("v"), ["true"]); // 15 > 10
  assert.deepEqual(render("logical_and", { ok: true, price: 1, qty: 3 }).textsOf("v"), ["false"]); // 3 > 10
  assert.deepEqual(render("logical_and", { ok: false, price: 5, qty: 3 }).textsOf("v"), ["false"]);
});

test("||는 왼쪽이 false일 때만 오른쪽 값을 낸다", () => {
  assert.deepEqual(render("logical_or", { ok: true, price: 1, qty: 3 }).textsOf("v"), ["true"]);
  assert.deepEqual(render("logical_or", { ok: false, price: 5, qty: 3 }).textsOf("v"), ["true"]); // 15 > 10
  assert.deepEqual(render("logical_or", { ok: false, price: 1, qty: 3 }).textsOf("v"), ["false"]); // 3 > 10
});

test("왼쪽이 false인 동안 오른쪽이 읽는 값이 바뀌어도 결과는 그대로고, 왼쪽이 true가 되면 바뀐 값을 쓴다", () => {
  const { textsOf, apply } = render("logical_and", { ok: false, price: 1, qty: 3 });
  apply((ctx) => ctx.set(ctx.props.price, 5));
  assert.deepEqual(textsOf("v"), ["false"]);
  apply((ctx) => ctx.set(ctx.props.ok, true));
  assert.deepEqual(textsOf("v"), ["true"], "쉬는 동안 바뀐 price 5를 반영한다"); // 5 * 3 > 10
  apply((ctx) => ctx.set(ctx.props.price, 1));
  assert.deepEqual(textsOf("v"), ["false"], "다시 고른 오른쪽을 구독한다");
});

test("왼쪽이 false이면 오른쪽 식을 인스턴스로 만들지도 세지도 않는다", () => {
  // 오른쪽 rows[cursor].x > 0은 cursor 5가 범위 밖이라 세면 RangeError다.
  const { textsOf, liveExprInstances } = render("logical_and_lazy", { ok: false, cursor: 5, rows: [{ x: 1 }] });
  assert.deepEqual(textsOf("v"), ["false"]);
  assert.equal(liveExprInstances(), 1); // 삼항 하나
});

test("왼쪽이 false로 바뀐 뒤에는 오른쪽 입력이 범위 밖이 되어도 세지 않는다", () => {
  const { textsOf, apply } = render("logical_and_lazy", { ok: true, cursor: 0, rows: [{ x: 1 }] });
  assert.deepEqual(textsOf("v"), ["true"]);
  apply((ctx) => ctx.set(ctx.props.ok, false));
  apply((ctx) => ctx.set(ctx.props.cursor, 5)); // 오른쪽을 세면 RangeError다.
  assert.deepEqual(textsOf("v"), ["false"]);
  apply((ctx) => {
    ctx.set(ctx.props.cursor, 0);
    ctx.set(ctx.props.ok, true);
  });
  assert.deepEqual(textsOf("v"), ["true"]);
});
