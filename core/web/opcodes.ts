// qubb 바이트코드의 opcode 상수와 코드 경계 탐색. 포맷은 core/BYTECODE.md.

export const OP_HALT = 0x00;
export const OP_ELEM_OPEN = 0x01;
export const OP_ATTR_G = 0x02;
export const OP_ELEM_CLOSE_OPEN = 0x03;
export const OP_TEXT = 0x04;
export const OP_ELEM_END = 0x05;
export const OP_RENDER = 0x06;
export const OP_ATTR_L = 0x07;
export const OP_TEXT_VAR = 0x08;
export const OP_ATTR_G_VAR = 0x09;
export const OP_ATTR_L_VAR = 0x0a;
export const OP_PUSH_THROUGH = 0x0b;
export const OP_IF = 0x0c;
const OP_ELSE = 0x0d;
const OP_IF_END = 0x0e;
export const OP_LOAD_RES = 0x0f;
export const OP_BIND_EVENT = 0x10;
export const OP_PUSH_ARG_LIT = 0x11;
export const OP_PUSH_PATH_SEGMENT = 0x12;
export const OP_ENTER_CONTEXT = 0x13;
export const OP_EXIT_CONTEXT = 0x14;
export const OP_FOR_RAW = 0x15;
export const OP_FOR_COUNT_VAR = 0x16;
const OP_FOR_END = 0x17;
export const OP_PUSH_PATH_INDEX_SEGMENT = 0x18;
export const OP_PUSH_FIELD = 0x19;
export const OP_FOR_ARRAY_VAR = 0x1a;
export const OP_PUSH_SLOT_PLACEHOLDER_CONTENT = 0x1b;
const OP_SLOT_PLACEHOLDER_CONTENT_END = 0x1c;
export const OP_FILL_SLOT_PLACEHOLDER = 0x1d;
export const OP_IF_EXPR = 0x1e;
export const OP_TEXT_EXPR = 0x1f;
export const OP_ATTR_G_EXPR = 0x20;
export const OP_ATTR_L_EXPR = 0x21;

// opcode의 operand 바이트 수를 돌려준다.
//
// skipBranch가 op 경계를 짚어 마커(IF/ELSE/IF_END)를 operand 값과 혼동하지 않게 한다.
// (SSR renderer operand_len과 동일.)
//
// @param op opcode 바이트
// @returns  operand 바이트 수(0/2/4)
export const operandLen = (op: number): number => {
  switch (op) {
    case OP_HALT:
    case OP_ELEM_CLOSE_OPEN:
    case OP_ELEM_END:
    case OP_ELSE:
    case OP_IF_END:
    case OP_EXIT_CONTEXT:
    case OP_FOR_END:
    case OP_SLOT_PLACEHOLDER_CONTENT_END:
      return 0;
    case OP_PUSH_THROUGH: // scope_index: u8
    case OP_IF_EXPR: // expr_index: u8
    case OP_TEXT_EXPR: // expr_index: u8
      return 1;
    case OP_ELEM_OPEN:
    case OP_TEXT:
    case OP_TEXT_VAR: // scope_index: u8, offset: u8
    case OP_RENDER:
    case OP_PUSH_FIELD: // scope_index: u8, offset: u8
    case OP_PUSH_ARG_LIT:
    case OP_PUSH_PATH_SEGMENT:
    case OP_IF: // scope_index: u8, offset: u8
    case OP_LOAD_RES:
    case OP_ENTER_CONTEXT:
    case OP_FOR_RAW:
    case OP_FOR_COUNT_VAR: // scope_index: u8, offset: u8
    case OP_FOR_ARRAY_VAR: // scope_index: u8, offset: u8
    case OP_PUSH_PATH_INDEX_SEGMENT:
    case OP_PUSH_SLOT_PLACEHOLDER_CONTENT:
    case OP_FILL_SLOT_PLACEHOLDER:
      return 2;
    case OP_ATTR_G_EXPR: // name: u16, expr_index: u8
    case OP_ATTR_L_EXPR: // name: u16, expr_index: u8
      return 3;
    case OP_ATTR_G:
    case OP_ATTR_L:
    case OP_ATTR_G_VAR: // name: u16, scope_index: u8, offset: u8
    case OP_ATTR_L_VAR: // name: u16, scope_index: u8, offset: u8
    case OP_BIND_EVENT:
      return 4;
    default:
      throw new Error(`bad opcode 0x${op.toString(16)}`);
  }
};

// 현재 가지를 통째로 스킵하고 끝 마커(ELSE/IF_END)의 pc를 돌려준다.
//
// op 경계를 따라 전진하며 중첩 if 깊이를 센다. 같은 깊이(0)에서 만난 ELSE/IF_END가 이 가지의
// 끝이다. build 안 하는 비활성 가지의 경계 위치만 얻을 때 쓴다. (SSR skip_branch의 JS 포팅.)
//
// @param code    def 바이트코드
// @param startPc 스킵 시작 위치(가지 첫 op)
// @returns       끝 마커(ELSE/IF_END)의 pc - 호출자가 그 마커를 소비
const skipBranch = (code: Uint8Array, startPc: number): number => {
  let pc = startPc;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    // IF_EXPR도 IF와 같은 분기다 - 깊이를 안 세면 중첩 안쪽의 IF_END를 이 가지 끝으로 오인한다.
    if (op === OP_IF || op === OP_IF_EXPR) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP_IF_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else if (op === OP_ELSE && depth === 0) {
      return markerPc;
    } else {
      pc += operandLen(op);
    }
  }
  throw new Error("unbalanced branch - no matching ELSE/IF_END");
};

// @for 몸체 끝(FOR_END)의 pc를 찾는다.
//
//   FOR op | operand | 몸체 ......... | FOR_END
//                    ^bodyStart      ^반환 pc(호출자가 마커 소비)
//
// bodyStart부터 op 경계를 전진하며 중첩 @for 깊이를 센다(같은 깊이 0의 FOR_END가 이 몸체 끝).
// IF는 몸체 안에 섞여도 무시 - @for 여는 opcode와 FOR_END만 깊이에 관여한다.
export const forBodyEnd = (code: Uint8Array, bodyStart: number): number => {
  let pc = bodyStart;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    if (op === OP_FOR_RAW || op === OP_FOR_COUNT_VAR || op === OP_FOR_ARRAY_VAR) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP_FOR_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else {
      pc += operandLen(op);
    }
  }
  throw new Error("unbalanced @for - no matching FOR_END");
};

// 슬롯 콘텐츠 구간 끝(SLOT_PLACEHOLDER_CONTENT_END)의 pc를 찾는다.
//
//   PUSH_SLOT_PLACEHOLDER_CONTENT | idx | 콘텐츠 ........ | SLOT_PLACEHOLDER_CONTENT_END
//                                       ^contentStart    ^반환 pc(호출자가 마커 소비)
//
// 콘텐츠 안에서 또 합성하며 슬롯을 채울 수 있어 깊이를 센다. IF/@for는 자기 마커로 닫히므로
// 여기 깊이에 관여하지 않는다.
export const slotPlaceholderContentEnd = (code: Uint8Array, contentStart: number): number => {
  let pc = contentStart;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    if (op === OP_PUSH_SLOT_PLACEHOLDER_CONTENT) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP_SLOT_PLACEHOLDER_CONTENT_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else {
      pc += operandLen(op);
    }
  }
  throw new Error("unbalanced slot content - no matching SLOT_PLACEHOLDER_CONTENT_END");
};

// IF 블록의 if/else 몸체 코드 경계를 구한다(순수 - code와 if 몸체 시작 pc만 본다).
//
//   IF operand | if 몸체 ... | ELSE | else 몸체 ... | IF_END
//              ^ifBodyStart  ^ifBodyEnd             ^ifEndPc
//                                   ^elseBodyStart
//
// else 없으면 elseBodyStart = -1이고 ifBodyEnd === ifEndPc === IF_END 위치.
// 마커는 skipBranch로 찾고 호출자가 소비한다.
export const ifBranchRanges = (
  code: Uint8Array,
  ifBodyStart: number,
): { ifBodyEnd: number; elseBodyStart: number; ifEndPc: number } => {
  const ifBodyEnd = skipBranch(code, ifBodyStart); // ELSE 또는 IF_END
  if (code[ifBodyEnd] === OP_ELSE) {
    const elseBodyStart = ifBodyEnd + 1;
    return { ifBodyEnd, elseBodyStart, ifEndPc: skipBranch(code, elseBodyStart) };
  }
  return { ifBodyEnd, elseBodyStart: -1, ifEndPc: ifBodyEnd }; // else 없는 if
};
