// @if를 켠 뒤에도 그 앞 형제의 클릭(위임 리스너)이 계속 잡히는지 본다.
//
// if-sibling-update.test.ts는 텍스트 갱신만 봤다. playground 셸에서 컴파일 실패로 진단 @if가
// 열린 뒤 파일을 클릭해도 핸들러가 안 불리는 증상이 있어, @if 삽입이 형제의 이벤트 바인딩을
// 깨뜨리는지 확인한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("if_sibling_click");
});

const seed = () => ({
  rows: [{ name: "a" }, { name: "b" }, { name: "c" }],
  note: "",
  shown: false,
});

// leafIndex는 props 선언 순(rows=0, note=1, shown=2).
const NOTE = 1;
const SHOWN = 2;

const clicked: number[] = [];
const handlers = {
  "Item[$0].CLICK_ROW": (_data: unknown, { $0 }: { $0: number }) => {
    clicked.push($0);
  },
};

const run = () => {
  clicked.length = 0;
  const inst = compile(qubb)(0)(seed(), handlers as never);
  return { inst, host: mount(inst) };
};

const click = (host: HTMLElement, i: number) => {
  host.querySelectorAll<HTMLElement>(".row")[i].click();
};

test("@if를 켠 뒤에도 앞 형제의 클릭이 잡힌다", () => {
  const { inst, host } = run();

  click(host, 1);
  assert.deepEqual(clicked, [1], "열기 전에는 잡힌다");

  inst.store.set(NOTE, "boom");
  inst.store.set(SHOWN, true);
  assert.equal(host.querySelector(".note")?.textContent, "boom");

  click(host, 0);
  click(host, 2);
  assert.deepEqual(clicked, [1, 0, 2], "@if가 열린 뒤에도 잡혀야 한다");
});

test("@if를 껐다 켜도 앞 형제의 클릭이 잡힌다", () => {
  const { inst, host } = run();

  inst.store.set(SHOWN, true);
  inst.store.set(SHOWN, false);
  inst.store.set(SHOWN, true);

  click(host, 1);
  assert.deepEqual(clicked, [1]);
});
