// 식의 모듈 전체 번호(globalExprIndex) - 컴포넌트 def 안의 번호(localExprIndex)에 def의 첫 번호(globalExprBase)를 더한
// 값이다. 건너뛰기 표는 이 번호로 찾고, 평가기(VM)마다 따로 만든다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { decode, type TQubleBytecode } from "./decode.ts";
import { ExprEvaluator } from "./expr-eval.ts";
import { EXPR_ADD, EXPR_LOAD_VAR, EXPR_MUL, EXPR_SUB } from "./expr-opcode.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_partial_reeval");
});

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];

// a + b. 건너뛸 부분식이 없어 표가 null이다.
const sum = () => new Uint8Array([...load(0), ...load(1), EXPR_ADD]);

// (a + b) * (c - d). 건너뛸 부분식이 있어 표가 있다.
const product = () => new Uint8Array([...load(0), ...load(1), EXPR_ADD, ...load(2), ...load(3), EXPR_SUB, EXPR_MUL]);

const evaluatorOf = (exprBytes: Uint8Array[]) =>
  new ExprEvaluator([], exprBytes, createLeafStoreSubject([1, 2, 5, 3]), new Pool());

test("globalExprBase는 def별 식 수의 누적 합이다", () => {
  const module = decode(qubb as TQubleBytecode);
  assert.ok(module.defs.length >= 2, "식이 든 컴포넌트가 둘 이상인 픽스처다");

  let expectedBase = 0;
  for (let compId = 0; compId < module.defs.length; compId++) {
    assert.equal(module.globalExprBase[compId], expectedBase, `def ${compId}의 첫 번호`);
    expectedBase += module.defs[compId].exprBytecodes.length;
  }
});

test("exprBytes[globalExprBase[compId] + localExprIndex]는 그 def의 식 바이트와 같은 객체다", () => {
  const module = decode(qubb as TQubleBytecode);
  let count = 0;
  for (let compId = 0; compId < module.defs.length; compId++) {
    const { exprBytecodes } = module.defs[compId];
    for (let localExprIndex = 0; localExprIndex < exprBytecodes.length; localExprIndex++) {
      assert.equal(module.exprBytes[module.globalExprBase[compId] + localExprIndex], exprBytecodes[localExprIndex]);
      count++;
    }
  }
  assert.equal(module.exprBytes.length, count, "def의 식을 빠짐없이 한 번씩 담는다");
});

test("skipTable은 같은 globalExprIndex에 같은 표를 돌려준다", () => {
  const evaluator = evaluatorOf([sum(), product()]);
  const table = evaluator.skipTable(1);
  assert.notEqual(table, null, "부분식 표가 있는 식이다");
  assert.equal(evaluator.skipTable(1), table);
});

test("건너뛸 부분식이 없는 식의 skipTable은 null이다", () => {
  const evaluator = evaluatorOf([sum(), product()]);
  assert.equal(evaluator.skipTable(0), null);
  assert.equal(evaluator.skipTable(0), null, "다시 물어도 같다");
});

test("평가기가 다르면 같은 식 바이트라도 표를 따로 만든다", () => {
  const expr = product();
  const first = evaluatorOf([expr]).skipTable(0);
  const second = evaluatorOf([expr]).skipTable(0);
  assert.notEqual(first, null);
  assert.notEqual(second, null);
  assert.notEqual(first, second, "VM마다 표를 갖는다");
});

// props 선언 순서가 곧 고정부 leafIndex. 0=a 1=b 2=c 3=d 4=rows 5=cursor 6=x 7=shared 8=z 9=show 10=big
const A = 0;
const SHARED = 7;
const Z = 8;

test("두 컴포넌트가 각자 localExprIndex 0을 가져도 서로 다른 식으로 센다", () => {
  const inst = compile(qubb)(0)(
    {
      a: 1,
      b: 2,
      c: 5,
      d: 3,
      rows: [{ score: 10 }, { score: 20 }],
      cursor: 0,
      x: 100,
      shared: 2,
      z: 3,
      show: false,
      big: 100,
    },
    {},
  );
  const host = mount(inst);
  const textOf = (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent;
  assert.equal(textOf("arith"), "6", "부모의 식 0: (1 + 2) * (5 - 3)");
  assert.equal(textOf("pair"), "8", "자식의 식 0: 2 + 2 * 3");

  inst.store.set(SHARED, 3);
  assert.equal(textOf("pair"), "12", "자식의 식만 바뀐다: 3 + 3 * 3");
  assert.equal(textOf("arith"), "6", "부모의 식은 그대로다");

  inst.store.set(A, 4);
  assert.equal(textOf("arith"), "12", "부모의 식만 바뀐다: (4 + 2) * (5 - 3)");
  assert.equal(textOf("pair"), "12", "자식의 식은 그대로다");

  inst.store.set(Z, 1);
  assert.equal(textOf("pair"), "6", "3 + 3 * 1");
});
