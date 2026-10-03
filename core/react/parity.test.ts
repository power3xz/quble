// 같은 fixture를 qubb 런타임과 React 산출로 그려, 화면과 핸들러가 받은 인자가 같은지 본다.
// 클릭은 두 쪽에 같은 순서로 낸다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  click,
  html,
  recorder,
  renderQubb,
  renderReact,
  type TAnyHandlers,
  typeErrors,
} from "./test-helpers/render.ts";

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
  [
    "textarea 자식 텍스트와 수 속성",
    { fixture: "if_sibling_update", values: { text: "t", lines: "1", count: 3, note: "n", shown: true } },
  ],
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

// @for. 핸들러는 상태를 두지 않는다 - 같은 표를 두 런타임이 함께 쓴다.
const forCases: [string, TCase][] = [
  ["배열 @for", { fixture: "for_array_scalar", values: { tags: ["a", "b", "c"] } }],
  ["객체 필드 수만큼 @for", { fixture: "for_obj_field", values: { c: { count: 2 } } }],
  ["@for 안 @if", { fixture: "for_if_count", values: { n: 3, flag: false } }],
  [
    "@for 요소를 자식에 넘긴다",
    {
      fixture: "for_item_object_to_child",
      values: {
        items: [
          { tag: "a", detail: { label: "A", value: "1" } },
          { tag: "b", detail: { label: "B", value: "2" } },
        ],
      },
    },
  ],
  [
    "수 @for의 회차가 늘어난다",
    {
      fixture: "for_count_index",
      values: { count: 2 },
      clicks: [
        [".add", 0],
        [".add", 0],
      ],
      handlers: {
        ADD: (_data, { get, set, props }) => {
          set(props.count, (get(props.count) as number) + 1);
        },
      },
    },
  ],
  [
    "@for 직속 요소는 익명 회차 마디",
    {
      fixture: "for_event_element",
      values: {},
      clicks: [
        ["button", 0],
        ["button", 2],
      ],
    },
  ],
  [
    "@for 안 합성은 이름 뒤에 회차 마디",
    {
      fixture: "for_event_component",
      values: {},
      clicks: [
        ["button", 1],
        ["button", 2],
      ],
    },
  ],
  [
    "합성을 건너 회차 깊이가 쌓인다",
    {
      fixture: "for_nested_render",
      values: {},
      clicks: [
        ["button", 0],
        ["button", 5],
        ["button", 11],
      ],
    },
  ],
  [
    "@for 안 자식이 자기 props 주소로 쓴다",
    {
      fixture: "for_item_props_set",
      values: {
        items: [
          { tag: "a", detail: { label: "A", value: "1" } },
          { tag: "b", detail: { label: "B", value: "2" } },
        ],
      },
      clicks: [[".card", 1]],
      handlers: {
        "Card[$0].BUMP": (_data, { set, props, $0 }) => {
          set(props.info.value, `v${$0}`);
        },
      },
    },
  ],
  [
    "push와 중간 removeAt - 회차 번호가 당겨진다",
    {
      fixture: "for_array_index_del",
      values: { tags: ["a", "b", "c"] },
      clicks: [
        [".del", 1],
        [".add", 0],
        [".del", 0],
      ],
      handlers: {
        ADD: (_data, { push, props }) => push(props.tags, "n"),
        "[$0].DEL": (_data, { removeAt, props, $0 }) => removeAt(props.tags, $0),
      },
    },
  ],
  [
    "중첩 @for 안쪽 배열에서 removeAt",
    {
      fixture: "for_nested_index_del",
      values: {
        rows: [
          { label: "r0", cells: ["a", "b", "c"] },
          { label: "r1", cells: ["d", "e"] },
        ],
      },
      clicks: [
        [".delcell", 1],
        [".delcell", 3],
      ],
      handlers: {
        "[$0][$1].DEL_CELL": (_data, { removeAt, props, $0, $1 }) => removeAt(props.rows[$0].cells, $1),
      },
    },
  ],
  [
    "객체 요소 push와 swapAt",
    {
      fixture: "for_array_push_obj",
      values: {
        stats: [
          { label: "a", value: "1" },
          { label: "b", value: "2" },
        ],
      },
      clicks: [
        [".add", 0],
        [".add", 0],
      ],
      handlers: {
        // 길이는 payload로 읽는다 - qubb의 get은 배열 주소에 배열 값을 돌려주지 않는다.
        ADD: (data, { push, swapAt, props }) => {
          if ((data.stats as unknown[]).length < 3) {
            push(props.stats, { label: "c", value: "3" });
          } else {
            swapAt(props.stats, 0, 2);
          }
        },
      },
    },
  ],
  [
    "중첩 배열 요소 push와 removeAt",
    {
      fixture: "for_array_nested_edit",
      values: { rows: [{ label: "r0", cells: ["a"] }] },
      clicks: [
        [".add", 0],
        [".del", 0],
      ],
      handlers: {
        ADD: (_data, { push, props }) => push(props.rows, { label: "r1", cells: ["b", "c"] }),
        DEL: (_data, { removeAt, props }) => removeAt(props.rows, 0),
      },
    },
  ],
  [
    "setArray로 통째 교체",
    {
      fixture: "for_array_replace",
      values: {
        rows: [
          { label: "r0", cells: ["a"] },
          { label: "r1", cells: ["b", "c"] },
        ],
      },
      clicks: [
        [".pick", 1],
        [".replace", 0],
        [".pick", 0],
      ],
      handlers: {
        REPLACE: (_data, { setArray, props }) => setArray(props.rows, [{ label: "x", cells: ["y", "z"] }]),
      },
    },
  ],
  [
    "한 배열을 두 @for가 돈다",
    {
      fixture: "for_shared_array",
      values: { tags: ["a", "b", "c"] },
      clicks: [[".del", 0]],
      handlers: {
        DEL: (_data, { removeAt, props }) => removeAt(props.tags, 1),
      },
    },
  ],
  [
    "@for 안 @if와 push",
    {
      fixture: "for_if_push_order",
      values: { tags: ["a"], flag: true },
      clicks: [[".add", 0]],
      handlers: {
        ADD: (_data, { push, props }) => push(props.tags, "b"),
      },
    },
  ],
  [
    "setObject로 객체 통째 교체",
    {
      fixture: "set_object",
      values: {
        title: "T",
        user: {
          name: "N",
          age: 1,
          tags: ["x", "y"],
          posts: [{ title: "P", marks: ["m1", "m2"] }],
          contact: { email: "E" },
        },
      },
      clicks: [["h1", 0]],
      handlers: {
        SWAP: (_data, { setObject, props }) =>
          setObject(props.user, {
            name: "N2",
            age: 2,
            tags: ["z"],
            posts: [
              { title: "P2", marks: [] },
              { title: "P3", marks: ["m3"] },
            ],
            contact: { email: "E2" },
          }),
      },
    },
  ],
];

for (const [name, c] of forCases) {
  test(`${name} (${c.fixture})`, () => checkParity(c));
}

// 슬롯 콘텐츠는 쓰는 쪽의 경로, 컨텍스트, 회차로 해석된다.
const slotCases: [string, TCase][] = [
  [
    "기명과 무기명 슬롯",
    {
      fixture: "slot_placeholder",
      values: { title: "T", note: "N" },
      clicks: [
        ["h1", 0],
        [".own", 0],
      ],
    },
  ],
  [
    "@for와 @if 안 슬롯 콘텐츠",
    {
      fixture: "slot_placeholder_control",
      values: { tags: ["a", "b"], open: true, label: "L" },
      clicks: [
        [".cell", 1],
        [".deferred", 0],
      ],
    },
  ],
  [
    "슬롯 콘텐츠 안 합성은 쓰는 쪽 경로와 컨텍스트",
    { fixture: "slot_content_compose", values: { label: "L" }, clicks: [["button", 0]] },
  ],
];

for (const [name, c] of slotCases) {
  test(`${name} (${c.fixture})`, () => checkParity(c));
}

test("산출 TSX가 strict 타입 검사를 통과한다", () => {
  const fixtures = [...new Set([...cases, ...forCases, ...slotCases].map(([, c]) => c.fixture))];
  assert.deepEqual(typeErrors(fixtures), []);
});

for (const [name, c] of cases) {
  test(`${name} (${c.fixture})`, () => checkParity(c));
}
