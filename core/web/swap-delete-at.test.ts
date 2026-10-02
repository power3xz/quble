// swapDeleteAt - 배열의 i번째를 빼고 빈자리에 마지막 원소를 옮겨 온다. 순서는 지키지 않는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { swapDeleteAt } from "./runtime.ts";

test("처음을 빼면 마지막 원소가 그 자리로 온다", () => {
  const items = ["a", "b", "c"];
  swapDeleteAt(items, 0);
  assert.deepEqual(items, ["c", "b"]);
});

test("중간을 빼면 마지막 원소가 그 자리로 오고 나머지는 그대로다", () => {
  const items = ["a", "b", "c", "d"];
  swapDeleteAt(items, 1);
  assert.deepEqual(items, ["a", "d", "c"]);
});

test("끝을 빼면 길이만 준다", () => {
  const items = ["a", "b", "c"];
  swapDeleteAt(items, 2);
  assert.deepEqual(items, ["a", "b"]);
});

test("하나뿐인 원소를 빼면 빈 배열이 된다", () => {
  const items = ["a"];
  swapDeleteAt(items, 0);
  assert.deepEqual(items, []);
});
