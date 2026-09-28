// 템플릿 복제 - @for 회차 본문처럼 요소/텍스트/값 자리/이벤트만으로 된 범위는, 정적 뼈대를 한 번 만들어
// 두고 회차마다 cloneNode로 복사한 뒤 값 자리에만 바인딩을 건다.
//
// 확인할 것은 셋이다.
//   - 뼈대는 한 번만 만든다: 행이 셋이어도 행 요소(li)를 createElement로 한 번만 만든다.
//   - 복제한 행의 값 자리(텍스트 식, 속성 식)가 초기값대로 나오고, 칸이 바뀌면 갱신된다.
//   - 복제한 행의 이벤트가 fullname과 회차 인덱스를 맞게 받는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";
import type { THandlers } from "./runtime.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("template_clone");
});

// 고정부: 0=rows 1=k. 요소 {label, n}은 2칸이라 요소 i의 label = 2 + 2i, n = 3 + 2i.
const K = 1;
const labelLeaf = (i: number) => 2 + 2 * i;
const nLeaf = (i: number) => 3 + 2 * i;

const seed = () => ({
  rows: [
    { label: "a", n: 1 },
    { label: "b", n: 2 },
    { label: "c", n: 3 },
  ],
  k: 10,
});

const instantiate = (handlers: THandlers = {}) => {
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);
  const rows = () => [...host.querySelectorAll("li")];
  return {
    inst,
    host,
    rows,
    // 행마다 [data-n, label 텍스트, 전체 텍스트]
    snapshot: () => rows().map((li) => [li.getAttribute("data-n"), li.querySelector(".label")?.textContent, li.textContent]),
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
  };
};

test("행이 셋이어도 행 요소는 한 번만 만든다", () => {
  const original = document.createElement.bind(document);
  const created: string[] = [];
  document.createElement = ((tag: string) => {
    created.push(tag);
    return original(tag);
  }) as typeof document.createElement;
  try {
    instantiate();
  } finally {
    document.createElement = original;
  }
  assert.deepEqual(
    created.filter((tag) => tag === "li"),
    ["li"],
  );
});

test("복제한 행의 텍스트와 속성이 초기값대로 나온다", () => {
  const { snapshot } = instantiate();
  assert.deepEqual(snapshot(), [
    ["1", "a", "a x 10pick"],
    ["2", "b", "b x 20pick"],
    ["3", "c", "c x 30pick"],
  ]);
});

test("복제한 행의 값 자리는 칸이 바뀌면 갱신된다", () => {
  const { snapshot, set, inst } = instantiate();
  assert.equal(inst.store.get(nLeaf(1)), 2, "요소 1의 n 칸");
  set(nLeaf(1), 5);
  set(labelLeaf(2), "z");
  set(K, 2);
  assert.deepEqual(snapshot(), [
    ["1", "a", "a x 2pick"],
    ["5", "b", "b x 10pick"],
    ["3", "z", "z x 6pick"],
  ]);
});

test("복제한 행의 이벤트가 fullname과 회차 인덱스를 받는다", () => {
  const picked: number[] = [];
  const { host } = instantiate({
    "[$0].PICK": (_data, ctx) => {
      picked.push(ctx.$0 as number);
    },
  });
  const buttons = host.querySelectorAll<HTMLElement>(".pick");
  buttons[2].click();
  buttons[0].click();
  assert.deepEqual(picked, [2, 0]);
});
