// 식 인스턴스 공유 - 같은 스코프의 같은 식은 식 인스턴스 하나를 쓴다. 스코프는 식이 읽는 변수 중 가장 깊은 변수가
// 정의된 곳이다(DECISIONS.md "식 인스턴스 공유").
//
// 픽스처(expr_level)의 식 다섯 개와 level:
//   a * b          0  컴포넌트 루트
//   row.base + a   1  바깥 @for 안
//   cell * a       2  안쪽 @for 안
//   row.base * 2   1  안쪽 @for 안 - 바깥 행 변수만 읽는다
//   a + 1          0  안쪽 @for 안 - props만 읽는다
// 깊이와 같은 level의 식(row.base + a, cell * a)은 행마다 값이 달라 행마다 인스턴스를 만든다. 깊이보다 낮은 level의 식
// (row.base * 2, a + 1)은 그 level의 스코프 안에서 인스턴스 하나를 같이 쓴다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_level");
});

type TRow = { base: number; cells: number[] };

const instantiate = (rows: TRow[], addQueue: TRow[] = [], delQueue: number[] = []) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (array: number, element: unknown) => void;
      const props = ctx.props as Record<string, number>;
      const row = addQueue.shift();
      if (row !== undefined) {
        push(props.rows, row);
      }
    },
    DEL: (_d, ctx) => {
      const removeAt = ctx.removeAt as (array: number, index: number) => void;
      const props = ctx.props as Record<string, number>;
      const index = delQueue.shift();
      if (index !== undefined) {
        removeAt(props.rows, index);
      }
    },
  };
  const inst = compile(qubb)(0)({ a: 2, b: 3, rows }, handlers);
  const host = mount(inst);
  return {
    inst,
    add: () => (host.querySelector(".add") as HTMLButtonElement).click(),
    del: () => (host.querySelector(".del") as HTMLButtonElement).click(),
    // 살아 있는 식 인스턴스 수(풀 칸 수 - 반납된 칸 수).
    liveExprInstances: () => inst.exprInstances.entries.length - inst.exprInstances.free.length,
    texts: (className: string) => [...host.querySelectorAll(`.${className}`)].map((node) => node.textContent),
  };
};

test("한 바깥 행의 안쪽 행들은 바깥 행 변수만 읽는 식과 props만 읽는 식의 인스턴스를 하나씩만 쓴다", () => {
  const { liveExprInstances } = instantiate([
    { base: 10, cells: [1, 2] },
    { base: 20, cells: [] },
  ]);

  // a * b 1 + row.base + a 2(바깥 행마다) + cell * a 2(안쪽 행마다) + row.base * 2 1(바깥 행 1을 공유) + a + 1 1(공유)
  assert.equal(liveExprInstances(), 7);
});

test("서로 다른 바깥 행은 바깥 행 변수만 읽는 식의 인스턴스를 나눠 쓰지 않는다", () => {
  const { liveExprInstances, texts } = instantiate([
    { base: 10, cells: [1] },
    { base: 20, cells: [1] },
  ]);

  assert.deepEqual(texts("outer"), ["20", "40"], "바깥 행마다 row.base * 2가 다르다");
  // a * b 1 + row.base + a 2 + cell * a 2 + row.base * 2 2(바깥 행마다) + a + 1 1(컴포넌트 전체가 공유)
  assert.equal(liveExprInstances(), 8);
});

test("공유한 식도 입력이 바뀌면 쓰는 모든 자리가 맞게 갱신된다", () => {
  const { inst, texts } = instantiate([
    { base: 10, cells: [1, 2] },
    { base: 20, cells: [3] },
  ]);
  assert.deepEqual(texts("props"), ["3", "3", "3"]);
  assert.deepEqual(texts("outer"), ["20", "20", "40"]);

  inst.update({ a: 5 });

  assert.deepEqual(texts("top"), ["15"]);
  assert.deepEqual(texts("props"), ["6", "6", "6"], "a + 1을 쓰는 자리 셋이 모두 바뀐다");
  assert.deepEqual(texts("cell"), ["5", "10", "15"]);
  assert.deepEqual(texts("outer"), ["20", "20", "40"], "a를 읽지 않는 식은 그대로다");
});

test("@for가 늘어 나중에 만든 행도 같은 스코프의 식을 공유한다", () => {
  const { liveExprInstances, texts, add } = instantiate([{ base: 10, cells: [1, 2] }], [{ base: 30, cells: [5, 6] }]);
  // a * b 1 + row.base + a 1 + cell * a 2 + row.base * 2 1 + a + 1 1
  assert.equal(liveExprInstances(), 6);

  add();

  // 새 바깥 행이 row.base + a 1, cell * a 2, row.base * 2 1(새 바깥 행 몫)을 더한다. a + 1은 기존 인스턴스를 쓴다.
  assert.equal(liveExprInstances(), 10);
  assert.deepEqual(texts("outer"), ["20", "20", "60", "60"]);
  assert.deepEqual(texts("props"), ["3", "3", "3", "3"]);
});

test("행을 제거하면 그 행이 쓰던 식 인스턴스를 반납하고 다른 행이 공유하던 것은 남긴다", () => {
  const { inst, liveExprInstances, texts, del } = instantiate(
    [
      { base: 10, cells: [1, 2] },
      { base: 20, cells: [3] },
    ],
    [],
    [0, 0],
  );
  // a * b 1 + row.base + a 2 + cell * a 3 + row.base * 2 2 + a + 1 1
  assert.equal(liveExprInstances(), 9);

  del();

  // 행 1이 row.base + a 1, cell * a 2, row.base * 2 1을 반납한다. a + 1은 행 2의 안쪽 행이 아직 쓴다.
  assert.equal(liveExprInstances(), 5);
  inst.update({ a: 5 });
  assert.deepEqual(texts("props"), ["6"], "공유하던 인스턴스가 남아 갱신된다");
  assert.deepEqual(texts("cell"), ["15"]);

  del();

  // 마지막 안쪽 행이 사라지면 a + 1도 반납되어 a * b만 남는다.
  assert.equal(liveExprInstances(), 1);
});

// 픽스처(expr_share_hidden): 행마다 `@if (row > limit) { ${rate * 2} }`. rate * 2는 컴포넌트 전체가 공유한다.
test("공유한 식을 든 가지가 모두 꺼진 동안 입력이 바뀌면 새로 붙는 행이 따라잡는다", () => {
  const addQueue = [20];
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (array: number, element: unknown) => void;
      const props = ctx.props as Record<string, number>;
      push(props.rows, addQueue.shift());
    },
  };
  const inst = compile(buildFixture("expr_share_hidden"))(0)({ rate: 100, limit: 0, rows: [5, 6] }, handlers);
  const host = mount(inst);
  const doubles = () => [...host.querySelectorAll(".double")].map((node) => node.textContent);
  assert.deepEqual(doubles(), ["200", "200"]);

  inst.update({ limit: 10 });
  inst.update({ rate: 150 });
  (host.querySelector(".add") as HTMLButtonElement).click();

  assert.deepEqual(doubles(), ["300"], "꺼진 동안 구독이 없어 결과 leaf가 200으로 낡았다");
});
