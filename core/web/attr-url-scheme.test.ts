// 동적 URL 속성(href/src/action/formaction)에 javascript: 스킴이 들어오면 속성을 달지 않는지 본다.
//
// 값이 런타임에 정해져 컴파일러가 거를 수 없다. 브라우저는 스킴 앞의 공백/제어 문자와 스킴 안의
// 탭/개행을 무시하므로 그런 변형도 막혀야 한다. data:는 막지 않는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("attr_url_scheme");
});

const URL_LEAF = 0; // 루트 props의 url
const TARGETS: [string, string][] = [
  [".link", "href"],
  [".img", "src"],
  [".form", "action"],
  [".btn", "formaction"],
];

const run = (url: string) => {
  const inst = compile(qubb)(0)({ url }, {} as never);
  return { inst, host: mount(inst) };
};

const attrsOf = (host: HTMLElement) => TARGETS.map(([sel, name]) => host.querySelector(sel)?.getAttribute(name));

test("javascript: 값은 네 속성 모두에 달리지 않는다", () => {
  const { host } = run("javascript:alert(1)");

  assert.deepEqual(attrsOf(host), [null, null, null, null]);
});

test("대소문자, 앞 공백, 스킴 안 탭을 섞어도 달리지 않는다", () => {
  for (const url of [" JaVa\tScRiPt:alert(1)", "\n\u0001javascript:x", "java\nscript:x"]) {
    const { host } = run(url);

    assert.deepEqual(attrsOf(host), [null, null, null, null], JSON.stringify(url));
  }
});

test("https:, 절대 경로, 상대 경로, data:는 그대로 달린다", () => {
  for (const url of ["https://example.com/a", "/a/b", "a/b", "data:image/png;base64,AAAA"]) {
    const { host } = run(url);

    assert.deepEqual(attrsOf(host), [url, url, url, url], url);
  }
});

test("갱신으로 javascript:가 들어오면 옛 값이 지워진다", () => {
  const { inst, host } = run("https://example.com");

  inst.store.set(URL_LEAF, "javascript:alert(1)");
  assert.deepEqual(attrsOf(host), [null, null, null, null]);
});

test("javascript:에서 안전한 값으로 갱신하면 다시 달린다", () => {
  const { inst, host } = run("javascript:alert(1)");

  inst.store.set(URL_LEAF, "https://example.com");
  assert.deepEqual(attrsOf(host), [
    "https://example.com",
    "https://example.com",
    "https://example.com",
    "https://example.com",
  ]);
});
