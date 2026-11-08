// store가 leaf마다 통지 구독을 담는 방식 - 구독이 하나뿐인 leaf가 대부분이라 하나면 함수를 그대로, 둘 이상이면
// Set에 담는다. 그 전환이 구독/해제/통지의 동작을 바꾸지 않는지 본다.
//
// 규칙: 같은 함수를 두 번 걸어도 한 번만 불린다. 해제하면 불리지 않고 다시 걸면 다시 불린다. 구독하지 않은 함수를
// 해제해도 다른 구독은 그대로다. 불리는 도중에 자기를 해제하거나 다른 구독을 더해도 이번 통지의 대상은 바뀌지 않는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";

const setup = () => createLeafStoreSubject([0, 0, 0]);

test("통지 구독: 같은 함수를 두 번 걸어도 한 번만 불린다", () => {
  const store = setup();
  let calls = 0;
  const fn = () => calls++;
  store.subscribe(0, fn);
  store.subscribe(0, fn);

  store.set(0, 1);

  assert.equal(calls, 1);
});

test("통지 구독: 둘 중 하나를 해제하면 나머지만 불린다", () => {
  const store = setup();
  const log: string[] = [];
  const a = () => log.push("a");
  const b = () => log.push("b");
  store.subscribe(0, a);
  store.subscribe(0, b);

  store.unsubscribe(0, a);
  store.set(0, 1);

  assert.deepEqual(log, ["b"]);
});

test("통지 구독: 하나뿐인 구독을 해제하면 불리지 않고 다시 걸면 다시 불린다", () => {
  const store = setup();
  let calls = 0;
  const fn = () => calls++;
  store.subscribe(0, fn);

  store.unsubscribe(0, fn);
  store.set(0, 1);
  assert.equal(calls, 0);

  store.subscribe(0, fn);
  store.set(0, 2);
  assert.equal(calls, 1);
});

test("통지 구독: 구독하지 않은 함수를 해제해도 다른 구독은 그대로다", () => {
  const store = setup();
  let calls = 0;
  store.subscribe(0, () => calls++);

  store.unsubscribe(0, () => {});
  store.unsubscribe(1, () => {});
  store.set(0, 1);

  assert.equal(calls, 1);
});

test("통지 구독: 불리는 도중 자기를 해제해도 그 호출은 끝나고 다음 set부터 불리지 않는다", () => {
  const store = setup();
  const log: string[] = [];
  const once = () => {
    log.push("once");
    store.unsubscribe(0, once);
  };
  store.subscribe(0, once);

  store.set(0, 1);
  store.set(0, 2);

  assert.deepEqual(log, ["once"]);
});

test("통지 구독: 불리는 도중 다른 구독을 더하면 이번 통지에는 안 불리고 다음부터 불린다", () => {
  const store = setup();
  const log: string[] = [];
  const late = () => log.push("late");
  store.subscribe(0, () => {
    log.push("first");
    store.subscribe(0, late);
  });

  store.set(0, 1);
  assert.deepEqual(log, ["first"]);

  log.length = 0;
  store.set(0, 2);
  assert.deepEqual(log, ["first", "late"]);
});
