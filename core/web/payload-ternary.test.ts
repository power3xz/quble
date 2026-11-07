// payload/context 값 자리의 삼항 - `PICK({ pick: open ? n : 0 })`, `RestArea { rest: n - (open ? n : 0) }`.
//
// 삼항은 식 바이트가 없는(len 0) 그래프 노드이고, 삼항을 입력으로 받는 계산 식은 LoadInput으로 그 값을 요청한다.
// 발화할 때 식 바이트만 세면 삼항은 값이 없고 LoadInput은 요청할 곳이 없다. 두 경우를 이벤트와 컨텍스트로 나눠
// 한쪽의 에러가 다른 쪽을 가리지 않게 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("payload_ternary");
});

// 핸들러가 받은 data와 context.
type TReceived = { data: Record<string, unknown>; context: Record<string, Record<string, unknown>> };

// 발화 중 난 에러. 리스너에서 던진 에러는 click()까지 올라오지 않고 window의 error 이벤트로 간다.
let listenerError: unknown = null;
document.defaultView?.addEventListener("error", (e) => {
  listenerError = e.error;
  e.preventDefault();
});

// n = 5, open을 주고 버튼 cls를 클릭해 핸들러 fullName이 받은 것을 돌려준다.
const click = (open: boolean, cls: string, fullName: string): TReceived | undefined => {
  listenerError = null;
  let received: TReceived | undefined;
  const handlers: THandlers = {
    [fullName]: (data, ctx) => {
      received = { data, context: ctx.context as TReceived["context"] };
    },
  };
  const host = mount(compile(qubb)(0)({ n: 5, open }, handlers));
  (host.querySelector(`.${cls}`) as HTMLButtonElement).click();
  return received;
};

const NOT_EVALUATED_BY_INSTANCE =
  "발화 때 payload/context 식을 식 인스턴스로 평가하지 않아 삼항과 LoadInput을 셀 수 없다";

test("payload와 context의 삼항을 발화 때 평가해 고른 갈래의 값을 넘긴다", { todo: NOT_EVALUATED_BY_INSTANCE }, () => {
  const received = click(true, "pick", "PICK");
  assert.equal(listenerError, null);
  assert.equal(received?.data.pick, 5); // open ? n : 0
  assert.equal(received?.context.PickArea.pick, 5);
});

test("삼항을 입력으로 받는 계산 식을 발화 때 평가해 넘긴다", { todo: NOT_EVALUATED_BY_INSTANCE }, () => {
  const received = click(false, "rest", "REST");
  assert.equal(listenerError, null);
  assert.equal(received?.data.rest, 5); // n - (open ? n : 0) = 5 - 0
  assert.equal(received?.context.RestArea.rest, 5);
});
