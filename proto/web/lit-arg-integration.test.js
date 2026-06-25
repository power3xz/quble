// 리터럴 인자 통합 테스트 — 실제 컴파일러(.qubc → .qubb)와 실제 runtime.js를 jsdom 위에서
// 돌린다. use-site 리터럴(`Label(text="고정")`)이 부모 scope 없이 PUSH_ARG_LIT로 상수풀에서
// 자식에 전달돼 렌더되는지, 그리고 같은 리터럴이 store에 leaf로 "딱 한 번"만 심기는지 본다.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./fixtures/dom.js";
import { buildFixture } from "./fixtures/build.js";

const { compile, createLeafStoreSubject } = await import("./runtime.js");

let qubb;
before(() => {
  qubb = buildFixture("lit_arg");
});

// 리터럴 인자가 클라 런타임에서 렌더된다 — 부모 scope가 비어도 자식이 상수값을 받아 출력.
test("literal arg renders in client runtime", () => {
  const ctx = createLeafStoreSubject({});
  const inst = compile(qubb)(0)(ctx, []); // LitArg = comp 0, props 없음 → paths 빈 배열
  const host = mount(inst);
  const spans = [...host.querySelectorAll("span")].map((s) => s.textContent);
  assert.deepEqual(spans, ["고정", "고정"]);
});

// 같은 리터럴을 두 번 넘겨도 store에 leaf는 하나 — path가 pool 인덱스로 정해져 leafOf가
// 같은 leafIndex를 돌려준다(module.pool 값이 store에 딱 한 번만 복사됨).
test("same literal shares one leaf (copied once)", () => {
  const ctx = createLeafStoreSubject({});
  // leafOf를 가로채 발급된 고유 leafIndex를 모은다($lit.* path만).
  const seen = new Set();
  const realLeafOf = ctx.leafOf;
  ctx.leafOf = (path) => {
    const leafIndex = realLeafOf(path);
    if (typeof path === "string" && path.startsWith("$lit.")) {
      seen.add(leafIndex);
    }
    return leafIndex;
  };
  compile(qubb)(0)(ctx, []);
  // 리터럴 "고정"은 두 자식에 전달되지만 leaf는 하나여야 한다.
  assert.equal(seen.size, 1);
});
