// CSS 부분 해석. bench-expr style.css에서 나오는 경우들.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createStyleOf, parseCss } from "./css.ts";
import { SDocument, type SElement } from "./scene.ts";

const CSS = `
:root { --line: #e3e6eb; --text: #1c2026; }
@media (prefers-color-scheme: dark) {
  :root { --line: #2a2f3a; }
}
@media print { .row { display: none; } }
* { box-sizing: border-box; }
.orders__bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.orders__bar button,
.row__inc { padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; color: var(--text); }
.btn:disabled { padding: 99px; }
.row { display: grid; grid-template-columns: 64px 1fr 48px; padding: 2px 10px; border-bottom: 1px solid var(--line); }
.row__warn { visibility: hidden; font-weight: 700; text-align: center; }
.row__warn[data-warn="true"] { visibility: visible; }
.row__inc { padding: 0 8px; }
`;

const doc = new SDocument();
const el = (tag: string, attrs: Record<string, string>, ...children: SElement[]): SElement => {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
};

const build = () => {
  const barButton = el("button", { class: "btn" });
  const bar = el("div", { class: "orders__bar" }, barButton);
  const warn = el("span", { class: "row__warn", "data-warn": "false" });
  const inc = el("button", { class: "row__inc" });
  const row = el("div", { class: "row" }, warn, inc);
  el("div", {}, bar, row);
  return { bar, barButton, row, warn, inc };
};

test("변수, 축약, 자손 선택자", () => {
  const { bar, barButton, row } = build();
  const styleOf = createStyleOf(parseCss(CSS, false));
  assert.deepEqual(styleOf(bar), { display: "row", wrap: true, gap: 8, marginBottom: 8 });
  assert.deepEqual(styleOf(barButton), {
    display: "inline",
    align: "center",
    padding: [4, 10, 4, 10],
    border: "#e3e6eb",
    radius: 6,
    color: "#1c2026",
  });
  assert.deepEqual(styleOf(row), {
    display: "grid",
    columns: [64, 0, 48],
    padding: [2, 10, 2, 10],
    borderBottom: "#e3e6eb",
  });
});

test("다크 모드면 @media 블록의 변수가 이긴다", () => {
  const { row } = build();
  assert.equal(createStyleOf(parseCss(CSS, true))(row).borderBottom, "#2a2f3a");
});

test("명시도가 같으면 뒤에 나온 규칙이 이기고, 속성 선택자가 명시도를 올린다", () => {
  const { warn, inc } = build();
  const styleOf = createStyleOf(parseCss(CSS, false));
  assert.deepEqual(styleOf(inc).padding, [0, 8, 0, 8]);
  assert.equal(styleOf(warn).hidden, true);
  warn.setAttribute("data-warn", "true");
  assert.equal(styleOf(warn).hidden, false);
  assert.equal(styleOf(warn).bold, true);
});
