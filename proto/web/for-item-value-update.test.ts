// @for 회차가 가리키는 "객체 요소의 필드 값"을 store에서 수정했을 때, 그 회차 DOM이 반응
// 갱신되는지 검증한다. 기존 for 테스트는 회차 수(count) 반응만 봤고, 요소 값 자체의 수정->반영은
// 빈 케이스였다. for_item_object_to_child fixture(List가 item.detail을 자식 Card로 전달)를 재사용해
// 중첩(회차 객체 -> 자식 컴포넌트 prop)에서도 갱신/교차 오염 없음을 함께 본다.
//
// leafIndex는 plant 규칙으로 손계산한다(props 접근 API가 나오기 전까지 잠정): 루트 {items: T[]}는
// 고정부에 배열칸 하나(leaf 0)만 심고, 요소들을 store 끝에 레벨별로 몬다. 요소 타입 {tag, detail:
// {label, value}}는 3칸(tag, label, value)이라 요소 i의 base = 1 + 3*i, 그 안 offset은 tag=0/
// label=1/value=2. -> value(i) = 3 + 3*i, label(i) = 2 + 3*i.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_item_object_to_child");
});

const cards = (host: HTMLElement) =>
  [...host.querySelectorAll(".card")].map((c) => ({
    label: c.querySelector(".label")?.textContent,
    value: c.querySelector(".value")?.textContent,
  }));

const seed = () => ({
  items: [
    { tag: "x", detail: { label: "A", value: "1" } },
    { tag: "y", detail: { label: "B", value: "2" } },
    { tag: "z", detail: { label: "C", value: "3" } },
  ],
});
const valueLeaf = (i: number) => 3 + 3 * i; // 요소 i의 detail.value leafIndex
const labelLeaf = (i: number) => 2 + 3 * i; // 요소 i의 detail.label leafIndex

test("회차 객체 요소의 필드 값 수정이 그 회차(자식 Card)에 반영된다", () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);

  inst.store.set(valueLeaf(1), "22"); // 가운데 회차의 detail.value만 수정
  assert.deepEqual(cards(host), [
    { label: "A", value: "1" },
    { label: "B", value: "22" },
    { label: "C", value: "3" },
  ]);
});

test("여러 회차의 서로 다른 필드를 수정해도 각자 자기 요소만 갱신된다(교차 오염 없음)", () => {
  const inst = compile(qubb)(0)(seed(), {});
  const host = mount(inst);

  inst.store.set(valueLeaf(0), "11"); // 0번 value
  inst.store.set(labelLeaf(2), "Z"); // 2번 label
  assert.deepEqual(cards(host), [
    { label: "A", value: "11" },
    { label: "B", value: "2" },
    { label: "Z", value: "3" },
  ]);
});
