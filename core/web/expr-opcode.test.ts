// 식 바이트를 훑어 읽는 scope_index의 최댓값을 구한다. operand 바이트를 opcode로 오인하지 않아야 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arityOf,
  EXPR_ADD,
  EXPR_AND,
  EXPR_DIV,
  EXPR_ELEM_AT,
  EXPR_EQ,
  EXPR_FIELD_AT,
  EXPR_GE,
  EXPR_GT,
  EXPR_LE,
  EXPR_LOAD_ARRAY_LENGTH,
  EXPR_LOAD_CONST,
  EXPR_LOAD_FALSE,
  EXPR_LOAD_SMALL_INT,
  EXPR_LOAD_STRING_LENGTH,
  EXPR_LOAD_TRUE,
  EXPR_LOAD_VAR,
  EXPR_LT,
  EXPR_MUL,
  EXPR_NE,
  EXPR_NEG,
  EXPR_NOT,
  EXPR_OR,
  EXPR_READ_LEAF,
  EXPR_REM,
  EXPR_SUB,
  maxScopeIndexRead,
} from "./expr-opcode.ts";

test("opcode마다 스택에서 꺼내는 값의 수가 고정돼 있다", () => {
  const arities: Array<[number, 0 | 1 | 2]> = [
    [EXPR_LOAD_VAR, 0],
    [EXPR_LOAD_CONST, 0],
    [EXPR_LOAD_ARRAY_LENGTH, 0],
    [EXPR_LOAD_STRING_LENGTH, 0],
    [EXPR_LOAD_SMALL_INT, 0],
    [EXPR_LOAD_TRUE, 0],
    [EXPR_LOAD_FALSE, 0],
    [EXPR_NOT, 1],
    [EXPR_NEG, 1],
    [EXPR_FIELD_AT, 1],
    [EXPR_READ_LEAF, 1],
    [EXPR_ADD, 2],
    [EXPR_SUB, 2],
    [EXPR_MUL, 2],
    [EXPR_DIV, 2],
    [EXPR_REM, 2],
    [EXPR_EQ, 2],
    [EXPR_NE, 2],
    [EXPR_LT, 2],
    [EXPR_LE, 2],
    [EXPR_GT, 2],
    [EXPR_GE, 2],
    [EXPR_AND, 2],
    [EXPR_OR, 2],
    [EXPR_ELEM_AT, 2],
  ];
  for (const [opcode, arity] of arities) {
    assert.equal(arityOf(opcode), arity, `opcode 0x${opcode.toString(16)}`);
  }
});

test("변수를 읽지 않는 식은 -1이다", () => {
  const expr = new Uint8Array([EXPR_LOAD_SMALL_INT, 5, EXPR_LOAD_TRUE, EXPR_ADD]);
  assert.equal(maxScopeIndexRead(expr), -1);
});

test("LOAD_VAR 하나면 그 scope_index다", () => {
  const expr = new Uint8Array([EXPR_LOAD_VAR, 3, 0]);
  assert.equal(maxScopeIndexRead(expr), 3);
});

test("여러 변수를 읽으면 가장 큰 scope_index다", () => {
  const expr = new Uint8Array([EXPR_LOAD_VAR, 1, 0, EXPR_LOAD_VAR, 4, 0, EXPR_ADD, EXPR_LOAD_VAR, 2, 0, EXPR_ADD]);
  assert.equal(maxScopeIndexRead(expr), 4);
});

test("배열 길이와 문자열 길이가 읽는 scope_index도 센다", () => {
  const expr = new Uint8Array([EXPR_LOAD_STRING_LENGTH, 2, 0, EXPR_LOAD_ARRAY_LENGTH, 5, 0, EXPR_ADD]);
  assert.equal(maxScopeIndexRead(expr), 5);
});

test("operand 바이트는 scope_index로 세지 않는다", () => {
  // offset 9, 작은 정수 200, 상수 인덱스 7, 필드 거리 250은 scope_index 1보다 크지만 읽는 슬롯이 아니다.
  const expr = new Uint8Array([
    EXPR_LOAD_VAR,
    1,
    9,
    EXPR_LOAD_SMALL_INT,
    200,
    EXPR_ADD,
    EXPR_LOAD_CONST,
    7,
    0,
    EXPR_ADD,
    EXPR_FIELD_AT,
    250,
  ]);
  assert.equal(maxScopeIndexRead(expr), 1);
});
