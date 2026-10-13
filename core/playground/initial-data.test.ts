// 셸의 초기 data - 첫 파일을 편집 중으로 잡고, 나머지 상태는 비워 둔다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { initialData } from "./initial-data.ts";
import { lineCountOf, tokenize } from "./tokenize.ts";

const sources = [
  { name: "a.qubc", source: "component A {\n}" },
  { name: "b.ts", source: "export const x = 1;" },
];

test("파일마다 이름과 소스를 싣고 첫 파일만 편집 중이다", () => {
  const data = initialData(sources);
  assert.deepEqual(data.files, [
    {
      name: "a.qubc",
      source: "component A {\n}",
      isEntry: true,
      isEditing: true,
      isPreviewing: false,
      hasError: false,
    },
    {
      name: "b.ts",
      source: "export const x = 1;",
      isEntry: false,
      isEditing: false,
      isPreviewing: false,
      hasError: false,
    },
  ]);
  assert.equal(data.editing, 0);
});

test("편집 중인 파일의 소스, 토큰 줄, 줄 수가 실린다", () => {
  const data = initialData(sources);
  assert.equal(data.source, "component A {\n}");
  assert.deepEqual(data.lines, tokenize("component A {\n}", "a.qubc"));
  assert.equal(data.lineCount, lineCountOf("component A {\n}"));
  assert.equal(data.lineCount, 2);
});

test("나머지 상태는 비어 있다", () => {
  const data = initialData(sources);
  assert.equal(data.caretLine, "transform: translateY(1rem)");
  assert.equal(data.preview, 0);
  assert.equal(data.previewSelected, false);
  assert.deepEqual(data.completion, { isOpen: false, style: "", isAbove: false, items: [] });
  assert.deepEqual(data.logs, []);
  assert.equal(data.diagnostic, "");
  assert.equal(data.hasError, false);
});
