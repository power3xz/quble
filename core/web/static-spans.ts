// 구멍(값 텍스트, 동적 속성, 이벤트, 합성, 제어 흐름)이 하나도 없는 정적 서브트리를 찾는다.
// 정적 서브트리는 안쪽에 연결할 것이 없어 resume이 자손을 방문하지 않고 건너뛸 수 있다.

import { OP_ATTR_G, OP_ATTR_L, OP_ELEM_CLOSE_OPEN, OP_ELEM_END, OP_ELEM_OPEN, OP_TEXT, operandLen } from "./opcodes.ts";

// 정적 서브트리를 연 ELEM_OPEN의 pc -> 그 요소의 ELEM_END 다음 pc. 구멍이 하나라도 있는 요소는 키에 없다.
// code의 [start, end)를 앞에서부터 한 번 훑는다. 열린 요소를 스택에 두고, 구멍을 만나면 꼭대기를 동적으로
// 표시한다. 닫을 때 동적이면 부모도 동적으로 올리므로(자손의 구멍은 조상의 구멍이다) 다시 훑지 않는다.
export const staticElementEnds = (code: Uint8Array, start: number, end: number): Map<number, number> => {
  const ends = new Map<number, number>();
  const openPcs: number[] = [];
  const dynamic: boolean[] = [];
  for (let pc = start; pc < end; ) {
    const op = code[pc];
    if (op === OP_ELEM_OPEN) {
      openPcs.push(pc);
      dynamic.push(false);
    } else if (op === OP_ELEM_END) {
      const openPc = openPcs.pop() as number;
      if (dynamic.pop()) {
        if (dynamic.length > 0) {
          dynamic[dynamic.length - 1] = true;
        }
      } else {
        ends.set(openPc, pc + 1);
      }
    } else if (op !== OP_ATTR_G && op !== OP_ATTR_L && op !== OP_ELEM_CLOSE_OPEN && op !== OP_TEXT) {
      if (dynamic.length > 0) {
        dynamic[dynamic.length - 1] = true;
      }
    }
    pc += 1 + operandLen(op);
  }
  return ends;
};
