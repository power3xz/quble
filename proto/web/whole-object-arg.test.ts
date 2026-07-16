// 객체 통째 전달(`Child(row={row})`) 통합 테스트 - 실제 컴파일러가 부모 객체 prop을 자식
// 객체 prop에 leaf마다 PushArg로 쪼개 넘긴 걸, 실제 runtime이 jsdom 위에서 렌더한다.
// 쪼갠 scope index들이 자식 leaf(라벨·불리언)에 올바로 닿아 텍스트/분기가 나오는지 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("whole_object_arg");
});

// 부모 props 평탄 leaf 순서: title=0, row.label=1, row.on=2.
const instantiate = (values: unknown) => {
  const inst = compile(qubb)(0)(values);
  return { store: inst.store, host: mount(inst) };
};

test("통째 전달한 객체 leaf가 자식에서 렌더된다", () => {
  const { host } = instantiate({ title: "제목", row: { label: "알림", on: true } });
  assert.equal(host.querySelector("h1")!.textContent, "제목");
  assert.equal(host.querySelector("span")!.textContent, "알림"); // row.label -> 자식 row.label
  assert.equal(host.querySelector("p")!.textContent, "켜짐"); // row.on -> 자식 @if 분기
});

test("통째 전달한 불리언 leaf 갱신이 자식 분기에 반영된다", () => {
  const { store, host } = instantiate({ title: "제목", row: { label: "알림", on: true } });
  store.set(2, false); // row.on = leafIndex 2
  assert.equal(host.querySelector("p")!.textContent, "꺼짐");
});
