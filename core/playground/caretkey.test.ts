// 캐럿 이동 목표 위치 - 편집기가 Home/End/PageUp/PageDown을 직접 처리하므로 브라우저가
// 봐주던 경계(첫 줄/끝 줄, 짧은 줄, 빈 줄)를 우리가 다 맞춰야 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { caretTarget } from "./caretkey.ts";

// `|`가 캐럿 자리. 목표 위치도 같은 표기로 비교해 오프셋 산수를 눈에서 지운다.
const move = (key: string, marked: string, opts: { toDocEdge?: boolean; pageLines?: number } = {}) => {
  const from = marked.indexOf("|");
  const text = marked.replace("|", "");
  const to = caretTarget(key, text, from, {
    toDocEdge: opts.toDocEdge ?? false,
    pageLines: opts.pageLines ?? 3,
  });
  return to === null ? null : `${text.slice(0, to)}|${text.slice(to)}`;
};

test("Home은 줄 처음으로", () => {
  assert.equal(move("Home", "abc\nde|f"), "abc\n|def");
});

test("End는 줄 끝으로", () => {
  assert.equal(move("End", "ab|c\ndef"), "abc|\ndef");
});

test("마지막 줄의 End는 문서 끝으로 - 뒤에 개행이 없다", () => {
  assert.equal(move("End", "abc\nd|ef"), "abc\ndef|");
});

test("이미 줄 끝/처음이면 제자리", () => {
  assert.equal(move("End", "abc|\ndef"), "abc|\ndef");
  assert.equal(move("Home", "abc\n|def"), "abc\n|def");
});

test("빈 줄에서도 제자리", () => {
  assert.equal(move("Home", "abc\n|\ndef"), "abc\n|\ndef");
  assert.equal(move("End", "abc\n|\ndef"), "abc\n|\ndef");
});

test("Ctrl 조합은 문서 처음/끝으로", () => {
  assert.equal(move("Home", "abc\nde|f", { toDocEdge: true }), "|abc\ndef");
  assert.equal(move("End", "a|bc\ndef", { toDocEdge: true }), "abc\ndef|");
});

test("PageDown은 페이지 줄 수만큼 아래로, 열을 유지한다", () => {
  assert.equal(move("PageDown", "ab|cd\nefgh\nijkl\nmnop", { pageLines: 2 }), "abcd\nefgh\nij|kl\nmnop");
});

test("PageUp은 같은 만큼 위로", () => {
  assert.equal(move("PageUp", "abcd\nefgh\nij|kl\nmnop", { pageLines: 2 }), "ab|cd\nefgh\nijkl\nmnop");
});

// 뒤에 줄이 더 있어야 clamp가 드러난다 - 목표가 마지막 줄이면 넘친 열이 문서 끝과 겹친다.
test("목표 줄이 짧으면 그 줄 끝에 멈춘다", () => {
  assert.equal(move("PageDown", "abcdef|gh\nij\nklmnop", { pageLines: 1 }), "abcdefgh\nij|\nklmnop");
});

// 첫 줄/끝 줄에서 멈추되 열은 그대로다 - 문서 끝(Ctrl 조합)과 다른 동작이다.
test("문서 경계를 넘지 않는다", () => {
  assert.equal(move("PageUp", "abc\nd|ef", { pageLines: 99 }), "a|bc\ndef");
  assert.equal(move("PageDown", "ab|c\ndef", { pageLines: 99 }), "abc\nde|f");
});

test("한 줄짜리 문서에서 페이지 이동은 제자리", () => {
  assert.equal(move("PageDown", "ab|c", { pageLines: 5 }), "ab|c");
  assert.equal(move("PageUp", "ab|c", { pageLines: 5 }), "ab|c");
});

test("다루지 않는 키는 null - 브라우저에 맡긴다", () => {
  assert.equal(move("ArrowLeft", "ab|c"), null);
  assert.equal(move("a", "ab|c"), null);
});
