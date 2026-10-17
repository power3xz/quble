// 서버 진입점의 createComponent가 React SSR(renderToString)에서 내용이 든 HTML을 내는지. 전역 DOM 없이 돈다.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { TQubleBytecode } from "../../../core/web/runtime-entry.ts";
import { createComponent } from "./react-server.ts";
import { bytecodeOf } from "./test-helpers/bytecode.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let greeting: TQubleBytecode;
let counter: TQubleBytecode;
before(async () => {
  greeting = await bytecodeOf(join(FIXTURES, "greeting.qubc"));
  counter = await bytecodeOf(join(FIXTURES, "counter.qubc"));
});

test("renderToString이 props로 그린 내용을 낸다", () => {
  const C = createComponent(greeting);
  const html = renderToString(createElement(C, { name: "Ann" }));
  assert.match(html, /<div>.*<p><span>Ann<\/span><\/p>.*<\/div>/);
});

test("props가 다르면 HTML도 다르다", () => {
  const C = createComponent(counter);
  assert.match(renderToString(createElement(C, { label: "Go", count: 1 })), /<p>1<\/p>/);
  assert.match(renderToString(createElement(C, { label: "Go", count: 7 })), /<p>7<\/p>/);
});

test("handlers prop은 data로 넘어가지 않고 서버에서는 쓰이지 않는다", () => {
  const C = createComponent(counter);
  const html = renderToString(createElement(C, { label: "Go", count: 1, handlers: {} }));
  assert.match(html, /<button>Go<\/button>/);
});
