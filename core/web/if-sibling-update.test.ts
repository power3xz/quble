// @if를 켠 뒤에도 그 앞 형제가 계속 갱신되는지 본다.
//
// playground 셸이 이 모양이다 - 편집 영역(textarea+거터) 다음에 진단용 @if가 온다. 컴파일이
// 실패해 @if가 열린 뒤 파일을 고르면 textarea가 안 바뀐다는 증상이 있어, @if 삽입이 앞 형제의
// 구독을 깨뜨리는지 확인한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("if_sibling_update");
});

const seed = () => ({ text: "a", lines: "1", count: 1, note: "", shown: false });

const view = (host: HTMLElement) => ({
  text: host.querySelector(".area")?.textContent,
  lines: host.querySelector(".gutter")?.textContent,
  rows: host.querySelector(".area")?.getAttribute("rows"),
  note: host.querySelector(".note")?.textContent ?? null,
});

test("@if를 켠 뒤에도 앞 형제(textarea/거터)가 갱신된다", () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);

  // 진단 표시 - @if가 열린다. leafIndex는 props 선언 순(text/lines/count/note/shown).
  inst.store.set(3, "boom");
  inst.store.set(4, true);
  assert.equal(view(host).note, "boom");

  // 이제 앞 형제를 바꾼다 - 열리기 전과 똑같이 반영되어야 한다.
  inst.store.set(0, "bbb");
  inst.store.set(1, "1\n2");
  inst.store.set(2, 2);
  assert.deepEqual(view(host), { text: "bbb", lines: "1\n2", rows: "2", note: "boom" });
});

test("@if를 껐다 켜도 앞 형제가 갱신된다", () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);

  inst.store.set(4, true);
  inst.store.set(4, false);
  inst.store.set(4, true);

  inst.store.set(0, "ccc");
  assert.equal(view(host).text, "ccc");
});
