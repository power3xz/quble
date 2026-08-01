// class를 표현식으로 바인딩할 수 있는지 본다(class={t.cls}).
//
// class는 컴파일러에서 특별 취급이 없어 일반 속성과 같은 경로를 탄다. 신택스 하이라이트가
// 토큰마다 다른 class를 걸어야 해서, 중첩 @for 안에서 동적 class가 실제로 붙는지 확인한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("attr_dynamic_class");
});

const seed = () => ({
  lines: [
    {
      tokens: [
        { text: "use", cls: "tok tok--keyword" },
        { text: " x", cls: "tok" },
      ],
    },
    { tokens: [{ text: "42", cls: "tok tok--number" }] },
  ],
});

const run = () => {
  const inst = compile(qubb)(0)(seed(), {} as never);
  return { inst, host: mount(inst) };
};

test("중첩 @for 안에서 class가 표현식으로 붙는다", () => {
  const { host } = run();

  const spans = [...host.querySelectorAll("span")];
  assert.deepEqual(
    spans.map((s) => s.className),
    ["tok tok--keyword", "tok", "tok tok--number"],
  );
  assert.deepEqual(
    spans.map((s) => s.textContent),
    ["use", " x", "42"],
  );
});

test("줄 수만큼 줄 요소가 생긴다", () => {
  const { host } = run();

  assert.equal(host.querySelectorAll(".line").length, 2);
});
