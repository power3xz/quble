// 같은 fixture를 qubb 런타임과 React 산출로 그려, 화면과 핸들러가 받은 인자가 같은지 본다.
// 클릭은 두 쪽에 같은 순서로 낸다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { click, html, recorder, renderQubb, renderReact, type TAnyHandlers } from "./test-helpers/render.ts";

type TCase = {
  fixture: string;
  values: Record<string, unknown>;
  // [선택자, 몇 번째] 순서로 클릭한다.
  clicks?: [string, number][];
  handlers?: TAnyHandlers;
};

const checkParity = async ({ fixture, values, clicks = [], handlers = {} }: TCase) => {
  const qubb = recorder(handlers);
  const react = recorder(handlers);
  const qubbHost = renderQubb(fixture, structuredClone(values), qubb.handlers);
  const reactHost = await renderReact(fixture, structuredClone(values), react.handlers);
  assert.equal(html(reactHost), html(qubbHost), "첫 화면");
  for (const [selector, index] of clicks) {
    await click(qubbHost, selector, index);
    await click(reactHost, selector, index);
    assert.equal(html(reactHost), html(qubbHost), `${selector}[${index}] 클릭 뒤 화면`);
  }
  assert.deepEqual(react.calls, qubb.calls, "핸들러가 받은 fullname, data, context");
  assert.equal(qubb.calls.length, clicks.length, "클릭마다 핸들러 한 번");
};

const cases: [string, TCase][] = [
  [
    "별칭과 타입명이 fullname 마디가 된다",
    {
      fixture: "event_alias",
      values: {},
      clicks: [
        ["button", 0],
        ["button", 1],
        ["button", 2],
      ],
    },
  ],
  ["리터럴 인자가 payload로 간다", { fixture: "event_fullname", values: {}, clicks: [["button", 0]] }],
  [
    "루트 이벤트는 마디 없이 이벤트명",
    { fixture: "event_toggle", values: { label: "L", on: "y" }, clicks: [["button", 0]] },
  ],
  ["자식 클릭은 부모로 버블하지 않는다", { fixture: "event_nested", values: { label: "X" }, clicks: [["button", 0]] }],
  ["@with 컨텍스트가 핸들러에 간다", { fixture: "event_context", values: { userId: "u1" }, clicks: [["button", 0]] }],
  ["다른 이름 @with 중첩", { fixture: "nested_context", values: { userId: "7" }, clicks: [["button", 0]] }],
  [
    "같은 이름 @with는 안쪽이 통째로 덮는다",
    { fixture: "dup_context", values: { userId: "7" }, clicks: [["button", 0]] },
  ],
  [
    "@if 식 조건",
    {
      fixture: "if_expr",
      values: { count: 3, limit: 3, isPaid: true, isCancelled: false, note: "n", tags: ["a", "b"] },
    },
  ],
  [
    "@if 식 조건 - 거짓 쪽",
    {
      fixture: "if_expr",
      values: { count: 0, limit: 3, isPaid: true, isCancelled: true, note: "", tags: [] },
    },
  ],
  [
    "합성을 건너는 중첩 @if",
    {
      fixture: "composed_triple",
      values: { c1: true, c2: true, c3: false, a: "A", b: "B", c: "C", d: "D" },
    },
  ],
  ["@if 안 @with", { fixture: "if_with_context", values: { cond: true, a: "A", b: "B" } }],
  ["리터럴 인자", { fixture: "lit_arg", values: {} }],
  ["숫자와 불리언 리터럴 인자", { fixture: "typed_lit_arg", values: {} }],
  ["객체 경로 보간", { fixture: "object_path", values: { title: "T", user: { name: "N", contact: { email: "E" } } } }],
  ["값 자리 식", { fixture: "value_expr", values: { count: 2, limit: 3, isPaid: false, note: "abc", tags: ["x"] } }],
  ["객체를 통째로 넘기는 인자", { fixture: "whole_object_arg", values: { title: "T", row: { label: "R", on: true } } }],
  [
    "배열 인덱스 접근",
    {
      fixture: "expr_array_index",
      values: {
        rows: [
          { title: "a", score: 10 },
          { title: "b", score: 20 },
          { title: "c", score: 30 },
        ],
        scalars: [1, 2, 3],
        cursor: 1,
        show: true,
      },
    },
  ],
  [
    "핸들러가 props 주소로 부모 상태를 바꾼다",
    {
      fixture: "if_lazy_fullname",
      values: { cond: true },
      clicks: [["button", 0]],
      handlers: {
        "Child.PICK": (_data, { get, set, props }) => {
          set(props.cond, !get(props.cond));
        },
      },
    },
  ],
];

for (const [name, c] of cases) {
  test(`${name} (${c.fixture})`, () => checkParity(c));
}
