// store의 파생 구독 - notify 전 단계에서 입력 leaf의 값으로 파생값을 만들고, 구독 층이 그 값을 결과 leaf에
// write하는 구독. 파생 구독이 모두 끝난 뒤에 통지 구독(subscribe)이 불린다.
//
// 규칙: 파생 구독은 식 인스턴스 번호로 걸고, store는 setDeriveRunner로 등록한 함수에 번호를 넘겨 값을 받는다.
// 그 함수는 값을 돌려주기만 하고 store에 쓰지 않는다. 번호 하나를 여러 leaf에 걸 수 있고 flush마다 한 번만,
// 등록한 leaf 중 바뀐 것만 받아 센다. 결과 leaf는 없을 수 있고, 없으면 돌려준 값을 쓰지 않는다. 결과 leaf에
// write한 값이 바뀌었으면 그 leaf도 통지 구독을 부른다. 파생 구독이 던져도 나머지는 모두 불리고 첫 예외가
// 올라간다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeafStoreSubject } from "./leaf-store.ts";

type TDeriveFn = (changedLeaves: ReadonlySet<number>) => unknown;

// leaf 0(a), 1(b), 3(c)는 입력, 2와 4는 결과. 일어난 일을 순서대로 모으는 log를 함께 돌려준다.
// derive(fn, resultLeafIndex)는 fn에 식 인스턴스 번호를 매겨 돌려준다 - store가 그 번호를 세면 fn이 불린다.
// resultLeafIndex를 주면 그 번호에 결과 leaf를 연결한다.
const setup = () => {
  const store = createLeafStoreSubject([1, 2, 0, 3, 0]);
  const log: string[] = [];
  const fns: TDeriveFn[] = [];
  store.setDeriveRunner((exprInstanceIndex, changedLeaves) => fns[exprInstanceIndex](changedLeaves));
  const derive = (fn: TDeriveFn, resultLeafIndex?: number): number => {
    const exprInstanceIndex = fns.push(fn) - 1;
    if (resultLeafIndex !== undefined) {
      store.bindDeriveResult(exprInstanceIndex, resultLeafIndex);
    }
    return exprInstanceIndex;
  };
  return { store, log, derive };
};

test("파생값은 결과 leaf에 write되고 통지 구독은 파생 구독이 끝난 뒤 확정된 값으로 불린다", () => {
  const { store, log, derive } = setup();
  store.subscribeDerive(
    0,
    derive(() => {
      log.push("derive");
      return (store.get(0) as number) + (store.get(1) as number);
    }, 2),
  );
  store.subscribe(0, () => log.push(`notify 0 result=${store.get(2)}`));
  store.subscribe(2, (value) => log.push(`notify 2 value=${value}`));

  store.set(0, 10);

  assert.deepEqual(log, ["derive", "notify 0 result=12", "notify 2 value=12"]);
});

test("파생값이 결과 leaf의 값과 같으면 결과 leaf의 통지 구독은 불리지 않는다", () => {
  const { store, log, derive } = setup();
  store.subscribeDerive(
    0,
    derive(() => 5, 2),
  );
  store.subscribe(2, () => log.push("notify 2"));

  store.set(0, 10);
  store.set(0, 11);

  assert.deepEqual(log, ["notify 2"], "첫 set만 결과 leaf를 5로 바꾼다");
});

test("결과 leaf가 없으면 파생 구독은 불리지만 돌려준 값은 쓰지 않는다", () => {
  const { store, derive } = setup();
  let calls = 0;
  store.subscribeDerive(
    0,
    derive(() => {
      calls++;
      return 99;
    }),
  );

  store.set(0, 10);

  assert.equal(calls, 1);
  assert.deepEqual([store.get(1), store.get(2), store.get(3), store.get(4)], [2, 0, 3, 0], "다른 leaf는 그대로다");
});

test("batch에서 파생 구독은 식 인스턴스당 한 번, 이번 flush에서 바뀐 leaf 전체를 받아 불린다", () => {
  const { store, derive } = setup();
  const received: Array<readonly number[]> = [];
  const exprInstanceIndex = derive((changedLeaves) => {
    received.push([...changedLeaves]);
    return 0;
  }, 2);
  store.subscribeDerive(0, exprInstanceIndex);
  store.subscribeDerive(1, exprInstanceIndex);

  store.batch(() => {
    store.set(1, 20);
    store.set(0, 10);
    store.set(3, 99);
  });
  assert.deepEqual(
    received,
    [[1, 0, 3]],
    "한 번, 처음 쓴 순서로, 등록하지 않은 leaf 3도 들어 있다(걸러내는 것은 함수 몫이다)",
  );

  store.batch(() => {
    store.set(0, 11);
  });
  assert.deepEqual(received, [[1, 0, 3], [0]], "a만 바뀌면 a만 받는다");
});

test("파생 구독은 바뀐 leaf를 has로 물을 수 있는 Set으로 받는다", () => {
  const { store, derive } = setup();
  const answers: boolean[][] = [];
  store.subscribeDerive(
    0,
    derive((changedLeaves) => {
      answers.push([changedLeaves.has(0), changedLeaves.has(1), changedLeaves.has(3)]);
      return 0;
    }, 2),
  );

  store.set(0, 10);
  store.batch(() => {
    store.set(0, 11);
    store.set(3, 99);
  });

  assert.deepEqual(answers, [
    [true, false, false],
    [true, false, true],
  ]);
});

test("batch 밖 set과 notify는 바뀐 leaf 하나로 파생 구독을 바로 부른다", () => {
  const { store, derive } = setup();
  const received: Array<readonly number[]> = [];
  store.subscribeDerive(
    1,
    derive((changedLeaves) => {
      received.push([...changedLeaves]);
      return 0;
    }, 2),
  );

  store.set(1, 20);
  store.notify(1);

  assert.deepEqual(received, [[1], [1]]);
});

test("같은 leaf에 파생 구독이 여럿이면 batch 밖 set에서 각각 한 번씩 그 leaf를 받고 결과 leaf에 write한다", () => {
  const { store, log, derive } = setup();
  const received: Array<[string, readonly number[]]> = [];
  store.subscribeDerive(
    0,
    derive((changedLeaves) => {
      received.push(["first", [...changedLeaves]]);
      return 5;
    }, 2),
  );
  store.subscribeDerive(
    0,
    derive((changedLeaves) => {
      received.push(["second", [...changedLeaves]]);
      return 6;
    }, 4),
  );
  store.subscribe(0, () => log.push("notify 0"));
  store.subscribe(2, () => log.push("notify 2"));
  store.subscribe(4, () => log.push("notify 4"));

  store.set(0, 10);

  assert.deepEqual(received, [
    ["first", [0]],
    ["second", [0]],
  ]);
  assert.deepEqual([store.get(2), store.get(4)], [5, 6]);
  assert.deepEqual(log, ["notify 0", "notify 2", "notify 4"]);
});

test("batch 끝에 바뀐 leaf가 하나여도 파생 구독을 한 번 부르고 입력 leaf와 결과 leaf에 통지한다", () => {
  const { store, log, derive } = setup();
  const received: Array<readonly number[]> = [];
  store.subscribeDerive(
    0,
    derive((changedLeaves) => {
      received.push([...changedLeaves]);
      return 5;
    }, 2),
  );
  store.subscribe(0, () => log.push("notify 0"));
  store.subscribe(2, () => log.push("notify 2"));

  store.batch(() => {
    store.set(0, 10);
    store.set(0, 11);
  });

  assert.deepEqual(received, [[0]]);
  assert.deepEqual(log, ["notify 0", "notify 2"]);
});

test("값이 같은 set은 파생 구독을 부르지 않는다", () => {
  const { store, derive } = setup();
  let calls = 0;
  store.subscribeDerive(
    0,
    derive(() => calls++, 2),
  );

  store.set(0, 1);

  assert.equal(calls, 0);
});

test("unsubscribeDerive 뒤에는 파생 구독이 불리지 않는다", () => {
  const { store, derive } = setup();
  let calls = 0;
  const exprInstanceIndex = derive(() => calls++, 2);
  store.subscribeDerive(0, exprInstanceIndex);
  store.subscribeDerive(1, exprInstanceIndex);

  store.unsubscribeDerive(0, exprInstanceIndex);
  store.set(0, 10);
  assert.equal(calls, 0, "해제한 leaf는 부르지 않는다");

  store.set(1, 20);
  assert.equal(calls, 1, "해제하지 않은 leaf는 그대로 부른다");
});

test("refreshDerive는 파생 구독을 주어진 leaf 모음으로 한 번 부르고 결과 leaf에 write한 뒤 통지한다", () => {
  const { store, log, derive } = setup();
  const received: Array<readonly number[]> = [];
  const exprInstanceIndex = derive((changedLeaves) => {
    received.push([...changedLeaves]);
    return (store.get(0) as number) + (store.get(1) as number);
  }, 2);
  store.subscribeDerive(0, exprInstanceIndex);
  store.subscribeDerive(1, exprInstanceIndex);
  store.subscribe(2, (value) => log.push(`notify 2 value=${value}`));

  store.write(0, 10);
  store.write(1, 20);
  store.refreshDerive(exprInstanceIndex, new Set([0, 1]));

  assert.deepEqual(received, [[0, 1]]);
  assert.equal(store.get(2), 30);
  assert.deepEqual(log, ["notify 2 value=30"]);
});

test("refreshDerive는 값이 결과 leaf와 같으면 통지하지 않는다", () => {
  const { store, log, derive } = setup();
  const exprInstanceIndex = derive(() => 5, 2);
  store.subscribeDerive(0, exprInstanceIndex);
  store.subscribe(2, () => log.push("notify 2"));

  store.refreshDerive(exprInstanceIndex, new Set([0]));
  log.length = 0;
  store.refreshDerive(exprInstanceIndex, new Set([0]));

  assert.deepEqual(log, []);
});

test("refreshDerive는 같은 leaf의 다른 식 인스턴스를 세지 않는다", () => {
  const { store, log, derive } = setup();
  const target = derive(() => 1, 2);
  const other = derive(() => {
    log.push("other derive");
    return 2;
  }, 4);
  store.subscribeDerive(0, target);
  store.subscribeDerive(0, other);
  store.subscribe(0, () => log.push("notify 0"));

  store.refreshDerive(target, new Set([0]));

  assert.deepEqual(log, [], "target만 세고 다른 파생 구독과 통지 구독은 불리지 않는다");
});

test("refreshDerive는 결과 leaf가 없으면 파생 구독만 부르고 값을 쓰지 않는다", () => {
  const { store, derive } = setup();
  let calls = 0;
  const exprInstanceIndex = derive(() => {
    calls++;
    return 99;
  });
  store.subscribeDerive(0, exprInstanceIndex);

  store.refreshDerive(exprInstanceIndex, new Set([0]));

  assert.equal(calls, 1);
  assert.deepEqual([store.get(2), store.get(4)], [0, 0]);
});

test("bindDeriveResult로 연결한 결과 leaf에 구독 전에 연결해도 값이 write된다", () => {
  const { store, log, derive } = setup();
  const exprInstanceIndex = derive(() => 42);
  store.bindDeriveResult(exprInstanceIndex, 2);
  store.subscribeDerive(0, exprInstanceIndex);
  store.subscribe(2, (value) => log.push(`notify 2 value=${value}`));

  store.set(0, 10);

  assert.equal(store.get(2), 42);
  assert.deepEqual(log, ["notify 2 value=42"]);
});

test("deriveResultOf는 연결한 결과 leaf를, 연결하지 않았거나 반납했으면 undefined를 돌려준다", () => {
  const { store, derive } = setup();
  const bound = derive(() => 1, 2);
  const unbound = derive(() => 1);

  assert.equal(store.deriveResultOf(bound), 2);
  assert.equal(store.deriveResultOf(unbound), undefined);

  store.freeDeriveResult(bound);
  assert.equal(store.deriveResultOf(bound), undefined);
});

test("freeDeriveResult는 결과 leaf를 반납해 다음 alloc이 그 자리를 다시 쓴다", () => {
  const { store, derive } = setup();
  const exprInstanceIndex = derive(() => 1, 2);

  store.freeDeriveResult(exprInstanceIndex);

  assert.equal(store.alloc([9]), 2);
});

test("freeDeriveResult를 같은 식 인스턴스로 여러 번 불러도 한 번만 반납한다", () => {
  const { store, derive } = setup();
  const exprInstanceIndex = derive(() => 1, 2);

  store.freeDeriveResult(exprInstanceIndex);
  store.freeDeriveResult(exprInstanceIndex);

  assert.deepEqual([store.alloc([9]), store.alloc([9])], [2, 5], "2는 한 번만 재사용되고 다음은 끝에 붙는다");
});

test("freeDeriveResult는 결과 leaf가 없는 식 인스턴스에는 아무것도 하지 않는다", () => {
  const { store, derive } = setup();
  store.freeDeriveResult(derive(() => 1));
  assert.equal(store.alloc([9]), 5);
});

test("freeDeriveResult 뒤에 센 파생 구독은 결과 leaf에 쓰지 않는다", () => {
  const { store, derive } = setup();
  const exprInstanceIndex = derive(() => 42, 2);
  store.subscribeDerive(0, exprInstanceIndex);

  store.freeDeriveResult(exprInstanceIndex);
  store.set(0, 10);

  assert.equal(store.get(2), 0);
});

test("파생 구독이 던져도 나머지 파생 구독과 통지 구독은 모두 불리고 첫 예외가 올라간다", () => {
  const { store, log, derive } = setup();
  store.subscribeDerive(
    0,
    derive(() => {
      log.push("derive 0");
      throw new Error("첫 파생 구독 오류");
    }, 4),
  );
  store.subscribeDerive(
    1,
    derive(() => {
      log.push("derive 1");
      return 7;
    }, 2),
  );
  store.subscribe(0, () => log.push("notify 0"));
  store.subscribe(2, () => log.push("notify 2"));

  assert.throws(
    () =>
      store.batch(() => {
        store.set(0, 10);
        store.set(1, 20);
      }),
    /첫 파생 구독 오류/,
  );
  assert.deepEqual(log, ["derive 0", "derive 1", "notify 0", "notify 2"]);
});
