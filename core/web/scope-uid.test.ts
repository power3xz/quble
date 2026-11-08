// 부모 scopeUid를 따라 조상 scope 찾기.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "./pool-allocator.ts";
import { ancestorScopeUid, NO_PARENT_SCOPE_UID, type TScopeParentPool } from "./scope-uid.ts";

test("부모를 steps번 따라 올라간 scope의 scopeUid를 준다", () => {
  // root > 행 > item > tag
  const scopeParentPool: TScopeParentPool = new Pool<number>();
  const root = scopeParentPool.alloc(NO_PARENT_SCOPE_UID);
  const row = scopeParentPool.alloc(root);
  const item = scopeParentPool.alloc(row);
  const tag = scopeParentPool.alloc(item);
  assert.equal(ancestorScopeUid(scopeParentPool, tag, 0), tag);
  assert.equal(ancestorScopeUid(scopeParentPool, tag, 1), item);
  assert.equal(ancestorScopeUid(scopeParentPool, tag, 3), root);
});

test("반납한 scopeUid를 다시 할당받은 scope는 새 부모를 따라 올라간다", () => {
  const scopeParentPool: TScopeParentPool = new Pool<number>();
  const rootA = scopeParentPool.alloc(NO_PARENT_SCOPE_UID);
  const rootB = scopeParentPool.alloc(NO_PARENT_SCOPE_UID);
  const row = scopeParentPool.alloc(rootA);
  scopeParentPool.release(row);
  const reallocated = scopeParentPool.alloc(rootB);
  assert.equal(reallocated, row);
  assert.equal(ancestorScopeUid(scopeParentPool, reallocated, 1), rootB);
});
