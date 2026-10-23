// 식의 공유 범위(level) - 식이 읽는 변수 중 가장 깊은 변수가 정의된 스코프의 깊이(컴포넌트 0, 첫 @for 1, 안쪽 @for 2).
// 슬롯 배치(props 뒤에 @for마다 item, index 2개)와 식 바이트의 scope_index에서 구한다(DECISIONS.md "식 인스턴스 공유").

import type { TModule } from "./decode.ts";
import { maxScopeIndexRead } from "./expr-opcode.ts";

// 컴포넌트 def 하나의 식마다 level. 결과[localExprIndex]가 defs[compId].exprBytecodes[localExprIndex]의 level이다.
// props가 a, b, rows면 propsCount는 3이고 scope_index 3, 4는 깊이 1, 5, 6은 깊이 2다.
export const exprLevelsOf = (module: TModule, compId: number): number[] => {
  const def = module.defs[compId];
  const propsType = module.types[def.propsTypeRef];
  const propsCount = propsType.tag === "object" ? propsType.fields.length : 0;
  return def.exprBytecodes.map((expr) => {
    const scopeIndex = maxScopeIndexRead(expr);
    return scopeIndex < propsCount ? 0 : ((scopeIndex - propsCount) >> 1) + 1;
  });
};
