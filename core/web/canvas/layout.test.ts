// 레이아웃 계산. 글자 폭은 글자당 7px, 줄 높이는 20px로 둔다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { layout, markDirty, type TBox, type TLayoutEnv, type TStyle } from "./layout.ts";
import { SDocument, type SElement, type SNode } from "./scene.ts";

const STYLES: Record<string, TStyle> = {
  list: { display: "block" },
  row: { display: "grid", columns: [30, 0, 40], gap: 10, padding: [2, 5, 2, 5] },
  right: { align: "right" },
  bar: { display: "row", gap: 4 },
  btn: { padding: [0, 3, 0, 3] },
};

let measured = 0;
const env: TLayoutEnv = {
  styleOf: (el) => STYLES[el.getAttribute("class") ?? ""] ?? {},
  measure: (text) => {
    measured++;
    return text.length * 7;
  },
  lineHeight: 20,
};

const doc = new SDocument();
const el = (cls: string, ...children: SNode[]): SElement => {
  const e = doc.createElement("div");
  e.setAttribute("class", cls);
  e.append(...children);
  return e;
};
const text = (s: string) => doc.createTextNode(s);
const boxOf = (n: SNode) => n.layout as TBox;

test("grid는 고정 칸과 남은 폭 칸에 자식을 놓고, 오른쪽 정렬은 칸 안에서 민다", () => {
  const a = el("", text("ab"));
  const b = el("right", text("xyz"));
  const c = el("", text("q"));
  const row = el("row", a, b, c);
  layout(env, row, 200, false);
  // 안쪽 폭 190 - 고정 30 + 40 + gap 20 = 100이 1fr 칸
  assert.deepEqual([boxOf(a).x, boxOf(b).x, boxOf(c).x], [5, 45, 155]);
  assert.deepEqual([boxOf(a).w, boxOf(b).w, boxOf(c).w], [30, 100, 40]);
  // xyz(21px)를 100px 칸 오른쪽에
  assert.equal(boxOf(b.firstChild as SNode).x, 79);
  assert.equal(boxOf(row).h, 24);
});

test("row는 넘치면 다음 줄로 넘긴다", () => {
  const items = ["aaaa", "bbbb", "cccc"].map((s) => el("btn", text(s)));
  const bar = el("bar", ...items);
  // 각 34px, gap 4 - 두 개(72)는 들어가고 세 번째는 80을 넘어 다음 줄
  layout(env, bar, 80, false);
  assert.deepEqual(
    items.map((i) => [boxOf(i).x, boxOf(i).y]),
    [
      [0, 0],
      [38, 0],
      [0, 24],
    ],
  );
  assert.equal(boxOf(bar).h, 44);
});

test("한 행의 텍스트가 바뀌면 그 행만 다시 잰다", () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    el("row", el("", text(`${i}`)), el("right", text("v")), el("", text("+"))),
  );
  const list = el("list", ...rows);
  doc.onChange = markDirty;
  layout(env, list, 300, false);
  const t = rows[50].childNodes[1].firstChild as SNode;
  measured = 0;
  t.textContent = "longer";
  layout(env, list, 300, false);
  assert.equal(measured, 1, "바뀐 텍스트 하나만 잰다");
  assert.equal(boxOf(rows[51]).y, boxOf(rows[50]).y + boxOf(rows[50]).h);
  doc.onChange = null;
});
