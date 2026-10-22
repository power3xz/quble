// 식 바이트를 훑어 읽는 scope_index의 최댓값을 구한다. operand 바이트를 opcode로 오인하지 않아야 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPR_ADD,
  EXPR_FIELD_AT,
  EXPR_LOAD_ARRAY_LENGTH,
  EXPR_LOAD_CONST,
  EXPR_LOAD_SMALL_INT,
  EXPR_LOAD_STRING_LENGTH,
  EXPR_LOAD_TRUE,
  EXPR_LOAD_VAR,
  maxScopeIndexRead,
} from "./expr-opcode.ts";

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
