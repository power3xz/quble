// store의 요소 자리 확보/회수(alloc/free) - 배열 요소 추가·제거의 leaf 관리. createLeafStoreSubject(leaves)는
// leaves를 클로저에 갇으므로, 테스트가 그 배열을 직접 넘겨 길이·내용으로 회수 동작을 검증한다(노출 불필요).
//
// 규칙: alloc은 같은 크기 빈 블록이 free list에 있으면 재사용(뒤로 안 늘림) 없으면 끝에 확보. free는 그 블록이
// leaves 끝이면 length를 줄여 되감고(pool 축소), 중간이면 크기별 free list에 반납. 전부 O(1), 병합·정렬 없음.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";

test("alloc은 값 뭉치를 끝에 심고 시작 leafIndex를 돌려준다", () => {
  const leaves: unknown[] = ["p0"]; // 기존 칸 하나
  const store = createLeafStoreSubject(leaves);
  const start = store.alloc(["a", "b"]);
  assert.equal(start, 1, "끝(기존 뒤)부터");
  assert.deepEqual(leaves, ["p0", "a", "b"], "연속으로 심김");
});

test("끝 블록 free는 leaves를 되감아 pool을 줄인다", () => {
  const leaves: unknown[] = ["p0"];
  const store = createLeafStoreSubject(leaves);
  const start = store.alloc(["x", "y"]); // [p0,x,y]
  store.free(start, 2); // 끝 블록 -> 되감김
  assert.equal(leaves.length, 1, "length 되감김(x,y 제거)");
});

test("중간 블록 free는 free list에 반납되고 같은 크기 alloc이 재사용한다", () => {
  const leaves: unknown[] = [];
  const store = createLeafStoreSubject(leaves);
  const a = store.alloc(["a"]); // 0
  store.alloc(["b"]); // 1 (뒤에 남겨 a를 중간으로 만든다)
  assert.equal(leaves.length, 2);
  store.free(a, 1); // 0은 중간(끝 아님) -> free list(size 1)
  assert.equal(leaves.length, 2, "중간 free는 length 안 줄임");
  const reused = store.alloc(["c"]); // size 1 free list 재사용
  assert.equal(reused, a, "free된 자리(0) 재사용");
  assert.equal(leaves.length, 2, "재사용이라 뒤로 안 늘림");
  assert.equal(leaves[a], "c", "그 자리에 새 값");
});

test("free list는 크기별로 분리 - 다른 크기는 재사용 안 하고 끝에 확보", () => {
  const leaves: unknown[] = [];
  const store = createLeafStoreSubject(leaves);
  const a = store.alloc(["a"]); // 0, size 1
  store.alloc(["b0", "b1"]); // 1,2 (a를 중간으로)
  store.free(a, 1); // size 1 free list
  const sz2 = store.alloc(["c0", "c1"]); // size 2 - size1 자리 못 씀
  assert.equal(sz2, 3, "다른 크기라 끝에 확보(size1 자리 안 씀)");
  const sz1 = store.alloc(["d"]); // size 1 - 재사용
  assert.equal(sz1, a, "같은 크기는 재사용");
});
