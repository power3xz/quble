import assert from "node:assert/strict";
import { test } from "node:test";
import { allocInPool, freeInPool, type TPool } from "./pool-allocator.ts";

test("빈 풀에 alloc하면 끝에 순서대로 append된다", () => {
  const pool: TPool<string> = { entries: [], free: [] };
  assert.equal(allocInPool(pool, "a"), 0);
  assert.equal(allocInPool(pool, "b"), 1);
  assert.deepEqual(pool.entries, ["a", "b"]);
  assert.deepEqual(pool.free, []);
});

test("free하면 그 칸이 null로 비워지고(GC용) free에 인덱스가 쌓인다", () => {
  const pool: TPool<string> = { entries: ["a", "b", "c"], free: [] };
  freeInPool(pool, 1);
  assert.equal((pool.entries as (string | null)[])[1], null); // 빈 칸은 null(유닛 내부 세부)
  assert.deepEqual(pool.free, [1]);
});

test("free한 칸은 다음 alloc에서 재사용된다(배열이 안 늘어난다)", () => {
  const pool: TPool<string> = { entries: ["a", "b", "c"], free: [] };
  freeInPool(pool, 1);
  const index = allocInPool(pool, "b2");
  assert.equal(index, 1); // 끝(3)이 아니라 재사용된 1
  assert.deepEqual(pool.entries, ["a", "b2", "c"]);
  assert.deepEqual(pool.free, []);
});

test("여러 칸을 free하면 LIFO로 재사용된다(마지막에 free한 칸부터)", () => {
  const pool: TPool<string> = { entries: ["a", "b", "c", "d"], free: [] };
  freeInPool(pool, 1);
  freeInPool(pool, 3);
  assert.equal(allocInPool(pool, "x"), 3); // 나중에 free한 3 먼저
  assert.equal(allocInPool(pool, "y"), 1);
  assert.deepEqual(pool.entries, ["a", "y", "c", "x"]);
  assert.deepEqual(pool.free, []);
});

test("free가 소진되면 다시 끝에 append한다", () => {
  const pool: TPool<string> = { entries: ["a", "b"], free: [] };
  freeInPool(pool, 0);
  assert.equal(allocInPool(pool, "a2"), 0); // 재사용
  assert.equal(allocInPool(pool, "c"), 2); // free 비어 끝에
  assert.deepEqual(pool.entries, ["a2", "b", "c"]);
});
