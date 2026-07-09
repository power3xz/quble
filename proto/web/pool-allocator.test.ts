import assert from "node:assert/strict";
import { test } from "node:test";
import { allocInPool, freeInPool } from "./pool-allocator.ts";

test("빈 풀에 alloc하면 끝에 순서대로 append된다", () => {
  const pool: (string | null)[] = [];
  const freeList: number[] = [];
  assert.equal(allocInPool(pool, freeList, "a"), 0);
  assert.equal(allocInPool(pool, freeList, "b"), 1);
  assert.deepEqual(pool, ["a", "b"]);
  assert.deepEqual(freeList, []);
});

test("free하면 그 칸이 null이 되고 freeList에 인덱스가 쌓인다", () => {
  const pool: (string | null)[] = ["a", "b", "c"];
  const freeList: number[] = [];
  freeInPool(pool, freeList, 1);
  assert.deepEqual(pool, ["a", null, "c"]);
  assert.deepEqual(freeList, [1]);
});

test("free한 칸은 다음 alloc에서 재사용된다(배열이 안 늘어난다)", () => {
  const pool: (string | null)[] = ["a", "b", "c"];
  const freeList: number[] = [];
  freeInPool(pool, freeList, 1);
  const index = allocInPool(pool, freeList, "b2");
  assert.equal(index, 1); // 끝(3)이 아니라 재사용된 1
  assert.deepEqual(pool, ["a", "b2", "c"]);
  assert.deepEqual(freeList, []);
});

test("여러 칸을 free하면 LIFO로 재사용된다(마지막에 free한 칸부터)", () => {
  const pool: (string | null)[] = ["a", "b", "c", "d"];
  const freeList: number[] = [];
  freeInPool(pool, freeList, 1);
  freeInPool(pool, freeList, 3);
  assert.equal(allocInPool(pool, freeList, "x"), 3); // 나중에 free한 3 먼저
  assert.equal(allocInPool(pool, freeList, "y"), 1);
  assert.deepEqual(pool, ["a", "y", "c", "x"]);
  assert.deepEqual(freeList, []);
});

test("freeList가 소진되면 다시 끝에 append한다", () => {
  const pool: (string | null)[] = ["a", "b"];
  const freeList: number[] = [];
  freeInPool(pool, freeList, 0);
  assert.equal(allocInPool(pool, freeList, "a2"), 0); // 재사용
  assert.equal(allocInPool(pool, freeList, "c"), 2); // freeList 비어 끝에
  assert.deepEqual(pool, ["a2", "b", "c"]);
});
