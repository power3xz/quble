// 식의 level - 읽는 변수 중 가장 깊은 변수가 정의된 스코프의 깊이.
//   props가 a, b, rows이면 scope_index는 a 0, b 1, rows 2이고, 바깥 @for의 item/index가 3, 4, 안쪽 @for의 item/index가
//   5, 6이다. 그래서 scope_index 0~2는 깊이 0, 3~4는 깊이 1, 5~6은 깊이 2다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { decode, type TQubleBytecode } from "./decode.ts";
import { exprLevelsOf } from "./expr-level.ts";
import { buildFixture } from "./test-helpers/build.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_level");
});

test("식마다 읽는 변수의 가장 깊은 깊이를 돌려준다", () => {
  const module = decode(qubb as TQubleBytecode);

  // 식 표는 템플릿에 처음 나온 순서다.
  //   0  a * b           props만 읽는다 -> 0
  //   1  row.base + a    바깥 item과 props -> 1
  //   2  cell * a        안쪽 item과 props -> 2
  //   3  row.base * 2    @for 안쪽에 있어도 바깥 item만 읽는다 -> 1
  //   4  a + 1           안쪽 @for 안에 있어도 props만 읽는다 -> 0
  assert.deepEqual(exprLevelsOf(module, 0), [0, 1, 2, 1, 0]);
});

// 삼항과 입력이 있는 계산 식이 든 qubb를 손으로 만든다. props는 셋이라 scope_index 0~2는 깊이 0, 3~4는 깊이 1, 5~6은 깊이 2다. 상수 0은 상수풀 0번.
//   #0 = s0 ? s5 : 0       삼항. 참 갈래가 깊이 2를 읽는다
//   #1 = s0 + #0           계산 식. 더 깊은 삼항을 입력으로 받는다
//   #2 = s0 ? 0 : 0        삼항. 갈래가 모두 상수다
//   #3 = s3                계산 식. 입력이 없다
//   #4 = s0 ? #3 : 0       삼항. 참 갈래가 식이다
const ternaryLevels = (): Uint8Array =>
  new Uint8Array([
    ...[0x51, 0x42, 0x4c, 0x00, 0, 0], // "QBL\0", version 0
    ...[1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], // 상수풀: 숫자 0 하나
    ...[2, 0], // 타입 2개
    ...[1, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0], // #0 Object, 필드 셋이 모두 #1
    0, // #1 Scalar
    ...[1, 0], // 컴포넌트 1개
    ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 이름, props 타입 #0, code_off, code_len
    ...[0, 0, 0, 0], // 이벤트 0개, 컨텍스트 0개
    5, // exprs: 식 5개
    0, // #0 삼항
    ...[6, 0x00, 0, 0, 0x22, 0, 0x10], // #1 LoadVar(0, 0) LoadInput 0 Add
    0, // #2 삼항
    ...[3, 0x00, 3, 0], // #3 LoadVar(3, 0)
    0, // #4 삼항
    4, // expr_inputs: 항목 4개
    ...[0, 255, 0, 0, 0, 0, 5, 0, 1, 0, 0], // #0: Scope(0, 0), Scope(5, 0), Const(0)
    ...[1, 1, 0], // #1: 입력 #0
    ...[2, 255, 0, 0, 0, 1, 0, 0, 1, 0, 0], // #2: Scope(0, 0), Const(0), Const(0)
    ...[4, 255, 0, 0, 0, 3, 3, 1, 0, 0], // #4: Scope(0, 0), Expr(3), Const(0)
    ...[0, 0, 0, 0], // 코드 길이 0
  ]);

test("삼항은 피연산자의 level 중 가장 큰 값, 계산 식은 입력 식의 level까지 본다", () => {
  const module = decode(ternaryLevels() as TQubleBytecode);
  //   #0  참 갈래 s5 -> 2
  //   #1  s0은 0이지만 입력 #0이 2 -> 2
  //   #2  cond s0이 0, 상수 갈래는 0 -> 0
  //   #3  s3 -> 1
  //   #4  참 갈래 #3이 1 -> 1
  assert.deepEqual(exprLevelsOf(module, 0), [2, 2, 0, 1, 1]);
});
