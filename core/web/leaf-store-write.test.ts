// store의 write - leaf에 값만 쓴다. set은 write에 파생 구독과 통지 구독을 트리거하는 과정이 붙은 상위 함수다.
//
// 규칙: write 뒤 get은 새 값을 읽는다. 통지 구독을 부르지 않고, batch 안에서도 통지 모음에 leaf를 넣지
// 않는다. 모으는 일은 write를 부른 쪽이 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";

const setup = () => {
  const store = createLeafStoreSubject(["a", "b"]);
  const calls: Array<[number, unknown]> = [];
  for (let leaf = 0; leaf < 2; leaf++) {
    store.subscribe(leaf, (value, leafIndex) => calls.push([leafIndex, value]));
  }
  return { store, calls };
};

test("write 뒤 get은 새 값을 읽는다", () => {
  const { store } = setup();
  store.write(0, "x");
  assert.equal(store.get(0), "x");
});

test("write는 통지 구독을 부르지 않는다", () => {
  const { store, calls } = setup();
  store.write(0, "x");
  assert.deepEqual(calls, []);
});

test("write는 batch 안에서도 통지 모음에 leaf를 넣지 않는다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.write(0, "x");
  });
  assert.deepEqual(calls, [], "batch가 끝나도 통지 구독은 불리지 않는다");
});

test("같은 값을 write해도 값은 그대로다", () => {
  const { store } = setup();
  store.write(0, "a");
  assert.equal(store.get(0), "a");
});
