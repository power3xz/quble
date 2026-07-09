// 중첩 @with 컨텍스트 통합 테스트. 두 경우를 본다.
//  1) 다른 이름 중첩: @with Outer { @with Inner { ... } } - 핸들러 context에 둘 다 담긴다.
//  2) 같은 이름 합성 중첩: 부모가 @with Area로 감싼 안에서 자식도 @with Area를 활성화 -
//     안쪽(자식)이 통째로 덮는다(필드 머지 아님). 워닝을 띄운다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.js";
import { mount } from "./fixtures/dom.js"; // jsdom 전역 document 주입(첫 import)

const { compile, createLeafStoreSubject } = await import("./runtime.ts");

const fireToggle = (qubb, paths, values, handlers) => {
  const store = createLeafStoreSubject(values);
  const inst = compile(qubb)(0)(store, paths, handlers);
  const button = mount(inst).querySelector("button");
  button.click();
};

test("다른 이름 중첩 - context에 바깥/안쪽 컨텍스트가 모두 담긴다", () => {
  const qubb = buildFixture("nested_context");
  let received = null;
  fireToggle(
    qubb,
    ["userId"],
    { userId: 7 },
    {
      TOGGLE: (data, { context }) => {
        received = context;
      },
    },
  );
  assert.deepEqual(received, {
    Outer: { area: "outer", userId: 7 },
    Inner: { area: "inner", tier: "gold" },
  });
});

test("같은 이름 합성 중첩 - 자식이 부모를 통째 덮고(필드 머지 아님) 워닝을 띄운다", () => {
  const qubb = buildFixture("dup_context");
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);

  let received = null;
  try {
    // 부모 props [userId]. Child(userId={userId})로 물려준다.
    // 버튼은 자식 안 - 별칭 없는 합성이라 fullname은 Child.TOGGLE.
    fireToggle(
      qubb,
      ["userId"],
      { userId: 7 },
      {
        "Child.TOGGLE": (data, { context }) => {
          received = context;
        },
      },
    );
  } finally {
    console.warn = origWarn;
  }

  // 자식 Area가 이긴다: tier=gold, userId=7. 부모에만 있던 scope는 통째 덮여 사라진다.
  assert.deepEqual(received, { Area: { tier: "gold", userId: 7 } });
  assert.equal("scope" in received.Area, false, "부모 필드(scope)는 머지되지 않고 사라진다");
  assert.equal(warnings.length, 1, "중복 활성화 워닝 1회");
  assert.match(warnings[0], /Area/, "워닝 메시지에 컨텍스트 이름");
});
