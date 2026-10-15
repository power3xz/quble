// @with 컨텍스트가 열린 자리와 바인딩 시점이 달라도 핸들러가 받는 context는 맞다.
//   - 지연 build되는 @if 가지 안의 @with: 가지가 켜질 때 풀어도 그때의 props 값을 준다
//   - @for 몸체에 직접 있는 @with: 모든 회차가 같은 컴포넌트 props를 가리킨다(자식 컴포넌트 없이)
// 활성 컨텍스트는 정의와 스코프만 들고 필드는 바인딩 때 푼다(contextFieldsOf).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let lazy: Uint8Array;
let forDirect: Uint8Array;
before(() => {
  lazy = buildFixture("lazy_with_context");
  forDirect = buildFixture("for_direct_with_context");
});

type TContext = Record<string, Record<string, unknown>>;

test("꺼져 있다 켜진 @if 가지 안의 @with가 켜질 때의 props 값을 준다", () => {
  const who: unknown[] = [];
  const handlers: THandlers = {
    PING: (_data, { context }) => {
      who.push((context as TContext).Area.who);
    },
  };
  const inst = compile(lazy)(0)({ cond: false, owner: "kim" }, handlers);
  const host = mount(inst);
  assert.equal(host.querySelector("button"), null, "처음에는 가지가 꺼져 있다");

  // 켜지기 전에 owner를 바꾼다 - 지연 build가 build 시점이 아니라 켜질 때의 값을 읽는지 본다.
  inst.store.set(1, "lee");
  inst.store.set(0, true);
  (host.querySelector("button") as HTMLButtonElement).click();
  assert.deepEqual(who, ["lee"]);

  inst.store.set(1, "park");
  (host.querySelector("button") as HTMLButtonElement).click();
  assert.deepEqual(who, ["lee", "park"], "발생 시점 현재값");
});

test("@for 몸체에 직접 있는 @with는 모든 회차가 같은 props 값을 받는다", () => {
  const who: unknown[] = [];
  const ping: THandlers[string] = (_data, { context }) => {
    who.push((context as TContext).Area.who);
  };
  const handlers: THandlers = {
    ADD: (_data, ctx) => {
      (ctx.push as (arrayLeafIndex: number, elem: unknown) => void)((ctx.props as Record<string, number>).items, "x");
    },
  };
  for (let i = 0; i < 8; i++) {
    handlers[`[$${i}].PING`] = ping;
  }
  const inst = compile(forDirect)(0)({ items: ["a", "b", "c"], owner: "kim" }, handlers);
  const host = mount(inst);
  const rows = () => Array.from(host.querySelectorAll(".row")) as HTMLButtonElement[];
  for (const row of rows()) {
    row.click();
  }
  assert.deepEqual(who, ["kim", "kim", "kim"]);

  // 나중에 추가된 회차(@for grow의 지연 실행)도 같은 컨텍스트를 받는다.
  (host.querySelector(".add") as HTMLButtonElement).click();
  who.length = 0;
  rows()[3].click();
  assert.deepEqual(who, ["kim"]);
});
