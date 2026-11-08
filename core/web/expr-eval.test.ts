// 식 평가의 LoadInput - 식 층이 입력 식의 값을 먼저 모아 inputValues로 넘기고, LoadInput i는 inputValues[i]를 올린다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprEvaluator, SKIP_NOTHING } from "./expr-eval.ts";
import { EXPR_ADD, EXPR_LOAD_INPUT, EXPR_LOAD_VAR, EXPR_MUL, EXPR_SUB } from "./expr-opcode.ts";
import type { TExprSkipTable } from "./expr-skip-table.ts";
import { createLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import { STORE } from "./scope.ts";

const load = (slot: number) => [EXPR_LOAD_VAR, slot, 0];
const loadInput = (inputPosition: number) => [EXPR_LOAD_INPUT, inputPosition];

// 슬롯 0~2가 leaf 0~2를 읽는다. leaf 값은 a = 10, b = 20, c = 30.
const pairs = [STORE, 0, STORE, 1, STORE, 2];

const evaluatorOf = (exprBytes: Uint8Array[]) =>
  new ExprEvaluator([], exprBytes, createLeafStoreSubject([10, 20, 30]), new Pool());

test("LoadInput i는 inputValues[i]를 올린다", () => {
  const expr = new Uint8Array([...loadInput(0), ...loadInput(1), EXPR_SUB]); // #0 - #1
  const evaluator = evaluatorOf([expr]);
  assert.equal(evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, null, [10, 3]), 7); // 10 - 3
});

test("같은 입력을 두 번 읽으면 두 번 모두 같은 inputValues[i]를 올린다", () => {
  const expr = new Uint8Array([...loadInput(0), ...loadInput(0), EXPR_ADD]); // #0 + #0
  const evaluator = evaluatorOf([expr]);
  assert.equal(evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, null, [4]), 8);
});

test("LoadInput은 store 칸을 읽지 않아 varNumberToLeafIndex에 자리를 차지하지 않는다", () => {
  // (a + b) * (c - #0). 변수는 a, b, c 셋이다.
  const expr = new Uint8Array([...load(0), ...load(1), EXPR_ADD, ...load(2), ...loadInput(0), EXPR_SUB, EXPR_MUL]);
  const evaluator = evaluatorOf([expr]);
  const table = evaluator.skipTable(0) as TExprSkipTable;
  const cache = new Array(table.opCount);
  const { value, varNumberToLeafIndex } = evaluator.evalExpr(expr, pairs, table, cache, [5]);
  assert.equal(value, 750); // (10 + 20) * (30 - 5)
  assert.deepEqual(varNumberToLeafIndex, [0, 1, 2]); // a, b, c가 읽은 leafIndex
});
