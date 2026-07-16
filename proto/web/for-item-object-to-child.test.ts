// @for 회차변수의 "객체 필드"를 자식 컴포넌트에 통째로 넘기는 경로 검증(item.detail -> Card info).
// 세 축이 겹치는 경계라 회귀에 취약: (1) @for 회차변수 슬롯, (2) 객체 필드 base+offset,
// (3) 합성 경계(PUSH_FIELD로 부모 base 전달, 자식은 자기 선언으로 타입만 앎). base/offset 계산을
// 건드리면 조용히 깨질 수 있어 남긴다. 회차마다 자기 요소를 가리키는지(교차 오염 없음)까지 본다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./fixtures/build.js";
import { mount } from "./fixtures/dom.js";

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

test("회차변수의 객체 필드가 자식에 전달되고, 각 회차가 자기 요소를 가리킨다", () => {
  const data = {
    // detail 앞에 tag를 둬 요소 안 offset을 0이 아니게 한다(offset 회귀를 잡으려면 필수).
    items: [
      { tag: "x", detail: { label: "A", value: "1" } },
      { tag: "y", detail: { label: "B", value: "2" } },
      { tag: "z", detail: { label: "C", value: "3" } },
    ],
  };
  const inst = compile(qubb)(0)(data, {});
  const host = mount(inst);
  assert.deepEqual(cards(host), [
    { label: "A", value: "1" },
    { label: "B", value: "2" },
    { label: "C", value: "3" },
  ]);
});
