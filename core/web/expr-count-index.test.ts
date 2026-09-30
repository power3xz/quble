// 개수 반복(`@for (x, i of 3)`)의 회차 변수를 식에서 읽는다.
//
// 개수 반복은 회차 슬롯을 (RAW, i)로 넣는다 - ref가 곧 값이다. 식이 이 슬롯을 leafIndex로 읽으면
// store의 i번 leaf 값을 읽게 된다. base(0번 leaf)를 100으로 두어 그렇게 읽으면 값이 틀리게 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_count_index");
});

// props 선언 순서가 곧 고정부 leafIndex. 0=base 1=n 2=items
const BASE = 0;

const seed = () => ({ base: 100, n: 2, items: ["a", "b", "c"] });

const texts = (host: HTMLElement, selector: string) => [...host.querySelectorAll(selector)].map((el) => el.textContent);

test("회차 변수만 읽는 식은 회차 번호다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.deepEqual(texts(host, ".lit-plain"), ["0", "1", "2"]);
});

test("회차 변수에 연산자를 붙인 식은 회차 번호로 센다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.deepEqual(texts(host, ".lit-add"), ["1", "2", "3"]);
});

test("속성 자리 식도 회차 번호로 센다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.deepEqual(
    [...host.querySelectorAll(".lit-attr")].map((el) => el.id),
    ["0", "10", "20"],
  );
});

test("@if 조건의 회차 변수도 회차 번호로 센다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.equal(host.querySelectorAll(".lit-if").length, 1);
});

test("회차 변수를 인덱스로 쓰면 그 회차의 요소를 읽는다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.deepEqual(texts(host, ".lit-item"), ["a", "b", "c"]);
});

test("개수가 prop인 반복도 회차 번호로 센다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.deepEqual(texts(host, ".var-add"), ["1", "2"]);
});

test("회차 변수를 받은 prop은 자식 식과 페이로드에서도 회차 번호다", () => {
  const picked: unknown[] = [];
  const handlers: THandlers = {
    "Pick[$0].PICK": (data) => {
      picked.push((data as { num: number }).num);
    },
  };
  const host = mount(compile(qubb)(0)(seed(), handlers));
  const buttons = [...host.querySelectorAll<HTMLButtonElement>(".pick")];
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ["1", "2", "3"],
  );
  for (const b of buttons) {
    b.click();
  }
  assert.deepEqual(picked, [0, 1, 2]);
});

test("회차 변수를 개수로 쓴 안쪽 반복은 회차 번호만큼 돈다", () => {
  const host = mount(compile(qubb)(0)(seed()));
  assert.equal(host.querySelectorAll(".raw-for").length, 0 + 1 + 2);
});

test("관계없는 leaf가 바뀌어도 회차 변수 식은 그대로다", () => {
  const inst = compile(qubb)(0)(seed());
  const host = mount(inst);
  inst.store.set(BASE, 7);
  assert.deepEqual(texts(host, ".lit-add"), ["1", "2", "3"]);
});
