// store의 통지 전 단계(derive stage) - flush마다 바뀐 leaf 모음을 단계에 넘기고, 단계가 돌려준 leaf 모음에 통지
// 구독을 부른다. store는 단계가 무엇을 어떻게 만드는지 모른다(표현식 층이 등록한다).
//
// 규칙: 단계는 flush마다 한 번, 이번 flush에서 바뀐 leaf 전체를 받는다. 단계가 write한 leaf는 통지 구독이 확정된
// 값으로 읽는다. 단계를 등록하지 않으면 바뀐 leaf만 통지한다. 단계나 통지 구독이 던져도 나머지 통지는 모두
// 나가고 첫 예외가 올라간다. clear는 등록한 단계를 놓는다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";

// leaf 0(a), 1(b)는 입력, 2는 단계가 a + b를 write하는 파생 leaf. 일어난 일을 순서대로 모으는 log와, 단계가 받은
// leaf 모음을 모으는 received를 함께 돌려준다.
const setup = () => {
  const store = createLeafStoreSubject([1, 2, 0]);
  const log: string[] = [];
  const received: Array<readonly number[]> = [];
  store.setDeriveStage((changed) => {
    received.push([...changed]);
    log.push("stage");
    store.write(2, (store.get(0) as number) + (store.get(1) as number));
    return new Set([...changed, 2]);
  });
  return { store, log, received };
};

test("단계가 write한 leaf는 단계가 돌려준 모음에 들어 통지 구독이 확정된 값으로 불린다", () => {
  const { store, log } = setup();
  store.subscribe(0, () => log.push(`notify 0 derived=${store.get(2)}`));
  store.subscribe(2, (value) => log.push(`notify 2 value=${value}`));

  store.set(0, 10);

  assert.deepEqual(log, ["stage", "notify 0 derived=12", "notify 2 value=12"]);
});

test("batch 밖 set과 notify는 바뀐 leaf 하나로 단계를 부른다", () => {
  const { store, received } = setup();

  store.set(1, 20);
  store.notify(1);

  assert.deepEqual(received, [[1], [1]]);
});

test("batch에서 단계는 한 번, 바뀐 leaf 전체를 처음 쓴 순서로 받는다", () => {
  const { store, received } = setup();

  store.batch(() => {
    store.set(1, 20);
    store.set(0, 10);
    store.set(1, 21);
  });

  assert.deepEqual(received, [[1, 0]]);
});

test("값이 같은 set은 단계를 부르지 않는다", () => {
  const { store, received } = setup();

  store.set(0, 1);

  assert.deepEqual(received, []);
});

test("단계를 등록하지 않으면 바뀐 leaf만 통지한다", () => {
  const store = createLeafStoreSubject([1, 2, 0]);
  const notified: number[] = [];
  store.subscribe(0, (_, leafIndex) => notified.push(leafIndex));
  store.subscribe(2, (_, leafIndex) => notified.push(leafIndex));

  store.set(0, 10);

  assert.deepEqual(notified, [0]);
});

test("단계가 onError로 넘긴 예외는 통지를 모두 보낸 뒤 첫 예외로 올라간다", () => {
  const store = createLeafStoreSubject([1, 2, 0]);
  const log: string[] = [];
  store.setDeriveStage((changed, onError) => {
    onError(new Error("첫 단계 오류"));
    onError(new Error("둘째 단계 오류"));
    return changed;
  });
  store.subscribe(0, () => log.push("notify 0"));
  store.subscribe(1, () => log.push("notify 1"));

  assert.throws(
    () =>
      store.batch(() => {
        store.set(0, 10);
        store.set(1, 20);
      }),
    /첫 단계 오류/,
  );
  assert.deepEqual(log, ["notify 0", "notify 1"]);
});

test("clear는 등록한 단계를 놓아 이후에는 바뀐 leaf만 통지한다", () => {
  const { store, received } = setup();
  store.clear();
  const notified: number[] = [];
  store.alloc([0, 0, 0]);
  store.subscribe(0, (_, leafIndex) => notified.push(leafIndex));
  store.subscribe(2, (_, leafIndex) => notified.push(leafIndex));

  store.set(0, 10);

  assert.deepEqual(received, [], "단계를 부르지 않는다");
  assert.deepEqual(notified, [0]);
});
