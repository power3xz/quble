// 핸들러 조회가 핸들러 표의 own 키만 보는지 - 상속된 키(Object.prototype의 constructor/toString, 다른
// 코드가 오염시킨 키)를 핸들러로 호출하거나 핸들러 인자에 싣지 않는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const proto = Object.prototype as Record<string, unknown>;

const instantiate = (name: string, values: unknown, handlers: TTestHandlers) => {
  const inst = compile(buildFixture(name))(0)(values, handlers as unknown as THandlers);
  return mount(inst);
};

test("등록 안 한 이벤트는 Object.prototype에 같은 이름의 함수가 있어도 호출하지 않는다", () => {
  let called = 0;
  proto.TOGGLE = () => {
    called += 1;
  };
  try {
    instantiate("event_toggle", { label: "x", on: "y" }, {}).querySelector("button")!.click();
  } finally {
    delete proto.TOGGLE;
  }
  assert.equal(called, 0);
});

test("핸들러 인자에 Object.prototype의 열거 가능한 키가 섞이지 않는다", () => {
  let api: Record<string, unknown> = {};
  proto.injected = { kind: 0, ref: 0 };
  try {
    instantiate(
      "event_toggle",
      { label: "x", on: "y" },
      {
        TOGGLE: (_data, received) => {
          api = received as Record<string, unknown>;
        },
      },
    )
      .querySelector("button")!
      .click();
  } finally {
    delete proto.injected;
  }
  assert.equal(Object.hasOwn(api, "injected"), false);
});

test("이벤트 이름이 Object.prototype 키여도 등록 안 했으면 상속된 함수를 호출하지 않는다", () => {
  const original = Object.prototype.toString;
  let called = 0;
  // 상속된 toString이 호출되는지 보려고 잠시 바꾼다.
  Object.prototype.toString = function () {
    called += 1;
    return original.call(this);
  };
  try {
    instantiate("event_proto_name", {}, {}).querySelector<HTMLElement>("#str")!.click();
  } finally {
    Object.prototype.toString = original;
  }
  assert.equal(called, 0);
});

test("이벤트 이름이 Object.prototype 키여도 own으로 등록한 핸들러는 호출한다", () => {
  let called = 0;
  const host = instantiate(
    "event_proto_name",
    {},
    {
      constructor: () => {
        called += 1;
      },
    },
  );
  host.querySelector<HTMLElement>("#ctor")!.click();
  assert.equal(called, 1);
});
