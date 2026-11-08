// 식의 공유 범위(level) - 식이 읽는 변수 중 가장 깊은 변수가 정의된 스코프의 깊이(컴포넌트 0, 첫 @for 1, 안쪽 @for 2).
// 슬롯 배치(props 뒤에 @for마다 item, index 2개)와 식 바이트의 scope_index에서 구한다(DECISIONS.md "식 인스턴스 공유").
// 입력 식이 있으면 그 식의 level까지 본다 - 소비 식은 입력 식의 인스턴스가 있는 scope와 같거나 그보다 안쪽에 있다.

import { FV_CONST, FV_EXPR, type TModule, type TRef } from "./decode.ts";
import { maxScopeIndexRead } from "./expr-opcode.ts";

// scope_index의 슬롯이 정의된 깊이. props 범위 안이면 0이고, 읽는 것이 없는 -1도 0이다. props 뒤로는 @for마다
// item과 index 두 칸이 붙는다.
//
//   props { a, b, rows }  @for (row of rows) {  @for (cell of row.cells) {
//
//   scope_index   0    1    2      3       4          5       6
//   슬롯          a    b    rows   row     row index  cell    cell index
//                 +-- props --+   +-- 바깥 @for --+  +-- 안쪽 @for --+
//   깊이          0    0    0      1       1          2       2
//
//   scope_index 5 -> (5 - 3) >> 1 = 1, + 1 = 2
const depthOfScopeIndex = (scopeIndex: number, propsCount: number): number =>
  scopeIndex < propsCount ? 0 : ((scopeIndex - propsCount) >> 1) + 1;

// 삼항 피연산자 하나의 level. 잎은 그 슬롯의 깊이, 상수는 0, 식은 levels에 이미 구한 그 식의 level이다.
const levelOfTernaryOperand = (operand: TRef, levels: number[], propsCount: number): number => {
  if (operand.tag === FV_CONST) {
    return 0;
  }
  if (operand.tag === FV_EXPR) {
    return levels[operand.ref];
  }
  return depthOfScopeIndex(operand.ref, propsCount);
};

// 컴포넌트 def 하나의 식마다 level. 결과[localExprIndex]가 defs[compId].exprBytecodes[localExprIndex]의 level이다.
//
// 계산 식은 바이트가 직접 읽는 scope_index의 깊이와 입력 식들의 level 중 큰 값이고, 삼항은 cond, 참 갈래, 거짓
// 갈래의 level 중 큰 값이다. 입력 식의 번호는 늘 자기 번호보다 작아, 번호가 작은 식부터 세면 입력의 level이 먼저 나온다.
export const exprLevelsOf = (module: TModule, compId: number): number[] => {
  const def = module.defs[compId];
  const propsType = module.types[def.propsTypeRef];
  const propsCount = propsType.tag === "object" ? propsType.fields.length : 0;
  const levels: number[] = [];
  def.exprInputs.forEach((exprInputs, localExprIndex) => {
    if (exprInputs.kind === "ternary") {
      levels.push(
        Math.max(
          levelOfTernaryOperand(exprInputs.cond, levels, propsCount),
          levelOfTernaryOperand(exprInputs.thenBranch, levels, propsCount),
          levelOfTernaryOperand(exprInputs.elseBranch, levels, propsCount),
        ),
      );
      return;
    }
    let level = depthOfScopeIndex(maxScopeIndexRead(def.exprBytecodes[localExprIndex]), propsCount);
    for (const input of exprInputs.inputs) {
      level = Math.max(level, levels[input]);
    }
    levels.push(level);
  });
  return levels;
};
