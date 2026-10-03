import assert from "node:assert/strict";
import { test } from "node:test";
import { style } from "quble-react";

test("CSS 선언 문자열을 React style 객체로 바꾼다", () => {
  assert.deepEqual(style("top: 10px; left: 4px"), { top: "10px", left: "4px" });
});

test("속성 이름은 camelCase로, 사용자 정의 속성은 그대로", () => {
  assert.deepEqual(style("background-color: red; -webkit-line-clamp: 2; --gap: 1rem"), {
    backgroundColor: "red",
    WebkitLineClamp: "2",
    "--gap": "1rem",
  });
});

test("값 안의 콜론과 빈 선언, 빈 문자열", () => {
  assert.deepEqual(style("background: url(http://x/a.png); ;"), { background: "url(http://x/a.png)" });
  assert.deepEqual(style(""), {});
  assert.deepEqual(style("display: none"), { display: "none" });
});
