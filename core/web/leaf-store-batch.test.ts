// store의 통지 배치 - batch(fn) 안의 set/notify는 값을 바로 기록하되 구독자 통지는 가장 바깥 batch가
// 끝날 때 칸마다 한 번씩 보낸다. 배치 밖은 지금처럼 set마다 바로 통지한다.
//
// 규칙: 값은 즉시 기록(get이 새 값을 읽음). 같은 칸을 여러 번 써도 통지는 한 번, 마지막 값으로.
// 서로 다른 칸은 처음 모은 순서대로. 중첩 batch는 가장 바깥이 끝날 때만 비운다. fn이 예외를 throw해도
// 모은 통지는 나가고 예외는 그대로 올라간다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";

// 칸 3개(0, 1, 2)를 가진 store와, 통지가 온 순서를 [leafIndex, value]로 모으는 구독자.
const setup = () => {
  const store = createLeafStoreSubject(["a", "b", "c"]);
  const calls: Array<[number, unknown]> = [];
  for (let leaf = 0; leaf < 3; leaf++) {
    store.subscribe(leaf, (value, leafIndex) => calls.push([leafIndex, value]));
  }
  return { store, calls };
};

test("배치 밖 set은 지금처럼 바로 통지한다", () => {
  const { store, calls } = setup();
  store.set(0, "x");
  assert.deepEqual(calls, [[0, "x"]]);
});

test("배치 안 set은 값을 바로 기록하고 통지는 배치가 끝난 뒤 보낸다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.set(0, "x");
    assert.equal(store.get(0), "x", "get은 새 값을 읽는다");
    assert.deepEqual(calls, [], "배치 안에서는 통지 없음");
  });
  assert.deepEqual(calls, [[0, "x"]], "끝난 뒤 한 번");
});

test("같은 칸을 여러 번 써도 통지는 한 번, 마지막 값으로 간다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.set(0, "x");
    store.set(0, "y");
    store.set(0, "z");
  });
  assert.deepEqual(calls, [[0, "z"]]);
});

test("서로 다른 칸은 처음 쓴 순서대로 칸마다 한 번씩 통지한다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.set(2, "p");
    store.set(0, "q");
    store.set(2, "r");
  });
  assert.deepEqual(calls, [
    [2, "r"],
    [0, "q"],
  ]);
});

test("값이 같은 set은 배치 안에서도 통지하지 않는다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.set(0, "a");
  });
  assert.deepEqual(calls, []);
});

test("배치 안 notify 직접 호출도 미루고 중복은 한 번으로 합친다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.notify(1);
    store.notify(1);
    assert.deepEqual(calls, []);
  });
  assert.deepEqual(calls, [[1, "b"]]);
});

test("중첩 batch는 가장 바깥이 끝날 때만 통지한다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.set(0, "x");
    store.batch(() => {
      store.set(1, "y");
    });
    assert.deepEqual(calls, [], "안쪽이 끝나도 아직 통지 없음");
    store.set(0, "z");
  });
  assert.deepEqual(calls, [
    [0, "z"],
    [1, "y"],
  ]);
});

test("배치가 끝나면 이후 set은 다시 바로 통지한다", () => {
  const { store, calls } = setup();
  store.batch(() => {
    store.set(0, "x");
  });
  calls.length = 0;
  store.set(1, "y");
  assert.deepEqual(calls, [[1, "y"]]);
});

test("fn이 예외를 throw해도 모은 통지는 나가고 예외는 그대로 올라간다", () => {
  const { store, calls } = setup();
  assert.throws(
    () =>
      store.batch(() => {
        store.set(0, "x");
        throw new Error("핸들러 오류");
      }),
    /핸들러 오류/,
  );
  assert.deepEqual(calls, [[0, "x"]], "쓴 값의 통지는 나간다");
  calls.length = 0;
  store.set(1, "y");
  assert.deepEqual(calls, [[1, "y"]], "예외 뒤에도 깊이가 돌아와 바로 통지한다");
});

test("통지 중 구독자가 예외를 throw해도 나머지 칸은 모두 통지하고 첫 예외를 올린다", () => {
  const store = createLeafStoreSubject(["a", "b", "c"]);
  const calls: number[] = [];
  store.subscribe(0, () => {
    calls.push(0);
    throw new Error("첫 칸 구독자 오류");
  });
  store.subscribe(1, () => calls.push(1));
  store.subscribe(2, () => calls.push(2));

  assert.throws(
    () =>
      store.batch(() => {
        store.set(0, "x");
        store.set(1, "y");
        store.set(2, "z");
      }),
    /첫 칸 구독자 오류/,
  );
  assert.deepEqual(calls, [0, 1, 2], "앞 칸에서 예외가 발생해도 뒤 칸의 통지는 건너뛰지 않는다");
});

test("통지를 보내는 중 구독자가 쓴 값은 바로 통지된다", () => {
  const { store, calls } = setup();
  store.subscribe(0, () => store.set(2, "from-subscriber"));
  store.batch(() => {
    store.set(0, "x");
  });
  assert.deepEqual(calls, [
    [0, "x"],
    [2, "from-subscriber"],
  ]);
});
