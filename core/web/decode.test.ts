// qubb 디코드 - 표현식 테이블과 그래프 섹션(expr_inputs)을 식마다 입력 하나로 펴는지.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "./decode.ts";

// 컴포넌트 하나에 아래 식 셋을 담은 qubb를 손으로 만든다(core/crates/bytecode의 calc_ternary_calc와 같은 식).
// props { ok: bool, price: number, base: number }의 슬롯 0, 1, 2.
//   #0 = price > 0          입력 없는 계산 식
//   #1 = ok ? price : 0     삼항. 상수 0은 상수풀 0번
//   #2 = base - #1          #1을 입력으로 받는 계산 식
const calcTernaryCalc = (): Uint8Array =>
  new Uint8Array([
    ...[0x51, 0x42, 0x4c, 0x00], // "QBL\0"
    ...[0, 0], // version 0
    ...[1, 0], // 상수풀 1개
    ...[1, 0, 0, 0, 0, 0, 0, 0, 0], // 숫자 0
    ...[0, 0], // 타입 0개
    ...[1, 0], // 컴포넌트 1개
    ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 이름, props 타입, code_off, code_len
    ...[0, 0, 0, 0], // 이벤트 0개, 컨텍스트 0개
    3, // exprs: 식 3개
    ...[6, 0x00, 1, 0, 0x04, 0, 0x19], // #0 LoadVar(1, 0) LoadSmallInt 0 Gt
    0, // #1 삼항
    ...[6, 0x00, 2, 0, 0x22, 0, 0x11], // #2 LoadVar(2, 0) LoadInput 0 Sub
    2, // expr_inputs: 항목 2개 - #0은 입력이 없어 싣지 않는다
    ...[1, 255, 0, 0, 0, 0, 1, 0, 1, 0, 0], // #1: TERNARY, Scope(0, 0), Scope(1, 0), Const(0)
    ...[2, 1, 1], // #2: 입력 1개, #1
    ...[0, 0, 0, 0], // 코드 길이 0
  ]);

test("그래프 섹션의 삼항과 입력 있는 계산 식을 읽고, 없는 식은 입력이 없는 계산 식으로 채운다", () => {
  const { exprInputs, exprBytecodes } = decode(calcTernaryCalc()).defs[0];
  assert.deepEqual(exprInputs, [
    { kind: "calc", inputs: [] },
    {
      kind: "ternary",
      cond: { kind: 0, ref: 0, offset: 0 },
      thenBranch: { kind: 0, ref: 1, offset: 0 },
      elseBranch: { kind: 1, ref: 0, offset: 0 },
    },
    { kind: "calc", inputs: [1] },
  ]);
  assert.equal(exprBytecodes[1].length, 0, "삼항은 식 바이트가 없다");
});
