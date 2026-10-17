// renderToHtml이 가짜 DOM에서 mount한 결과를 HTML 문자열로 내는지. 전역 document를 호출 동안만 거는지도 본다.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TQubleBytecode } from "../../../core/web/runtime-entry.ts";
import { renderToHtml } from "./server-render.ts";
import { bytecodeOf } from "./test-helpers/bytecode.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let greeting: TQubleBytecode;
before(async () => {
  greeting = await bytecodeOf(join(FIXTURES, "greeting.qubc"));
});

test("data로 그린 HTML을 문자열로 낸다", () => {
  const html = renderToHtml(greeting, { name: "Ann" });
  assert.match(html, /<p><span>Ann<\/span><\/p>/);
});

test("data가 다르면 HTML도 다르다", () => {
  assert.match(renderToHtml(greeting, { name: "Bob" }), /Bob/);
  assert.doesNotMatch(renderToHtml(greeting, { name: "Bob" }), /Ann/);
});

test("호출이 끝나면 전역 document를 되돌린다", () => {
  const g = globalThis as Record<string, unknown>;
  assert.equal(g.document, undefined);
  renderToHtml(greeting, { name: "Ann" });
  assert.equal(g.document, undefined);
});

test("이미 있던 전역 document는 호출 뒤에도 그대로다", () => {
  const g = globalThis as Record<string, unknown>;
  const before = { sentinel: true };
  g.document = before;
  try {
    renderToHtml(greeting, { name: "Ann" });
    assert.equal(g.document, before);
  } finally {
    delete g.document;
  }
});

test("연달아 불러도 매번 같은 결과다", () => {
  assert.equal(renderToHtml(greeting, { name: "Ann" }), renderToHtml(greeting, { name: "Ann" }));
});
