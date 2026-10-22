// 표현식 opcode(BYTECODE.md #4 <EXPR>). OP와 다른 이름공간이다 - 같은 값이 서로 다른 뜻이라
// 식 바이트를 OP로 읽으면 안 된다.
//
// 식은 후위 표기라 앞에서 뒤로 한 번 훑으면 끝난다. 타입은 컴파일타임에 검사가 끝나
// (compiler/src/expr_type.rs) 여기서 타입을 안 본다.
//
// 스택에는 값이 오르는 것이 기본이고, ELEM_AT/FIELD_AT만 leafIndex를 올린다 - 요소 위치는
// 인덱스를 세어 봐야 정해져 컴파일타임에 슬롯으로 접히지 않는다. READ_LEAF가 그 leafIndex를
// 값으로 바꾸므로 연산자에는 늘 값만 닿는다.
export const EXPR_LOAD_VAR = 0x00; // scope_index: u8, offset: u8
export const EXPR_LOAD_CONST = 0x01; // const_index: u16
export const EXPR_LOAD_ARRAY_LENGTH = 0x02; // scope_index: u8, offset: u8
export const EXPR_LOAD_STRING_LENGTH = 0x03; // scope_index: u8, offset: u8
export const EXPR_LOAD_SMALL_INT = 0x04; // value: u8
export const EXPR_LOAD_TRUE = 0x05;
export const EXPR_LOAD_FALSE = 0x06;
export const EXPR_ADD = 0x10;
export const EXPR_SUB = 0x11;
export const EXPR_MUL = 0x12;
export const EXPR_DIV = 0x13;
export const EXPR_REM = 0x14;
export const EXPR_EQ = 0x15;
export const EXPR_NE = 0x16;
export const EXPR_LT = 0x17;
export const EXPR_LE = 0x18;
export const EXPR_GT = 0x19;
export const EXPR_GE = 0x1a;
export const EXPR_AND = 0x1b;
export const EXPR_OR = 0x1c;
export const EXPR_NOT = 0x1d;
export const EXPR_NEG = 0x1e;
export const EXPR_ELEM_AT = 0x1f; // 인덱스와 arrayInfoIndex를 꺼내 elemStartLeafIndices[i]를 올린다
export const EXPR_FIELD_AT = 0x20; // offset: u8 - leafIndex에 필드 거리를 더한다
export const EXPR_READ_LEAF = 0x21; // leafIndex를 꺼내 그 칸의 값을 올린다

// 식이 읽는 scope_index 중 가장 큰 값. 읽는 것이 없으면 -1.
// a * row.x   props가 a, b이고 @for 하나의 item이 row라면 scope_index는 a가 0, b가 1, row가 2다.
//
//   위치    0         1            2       3         4            5       6
//   바이트  LOAD_VAR  0            0       LOAD_VAR  2            0       MUL
//   역할    opcode    scope_index  offset  opcode    scope_index  offset  opcode
//                     (a)                            (row)
//
//   scope_index는 위치 1의 0과 위치 4의 2라 결과는 2다. offset(위치 2, 5)은 세지 않는다.
export const maxScopeIndexRead = (expr: Uint8Array): number => {
  let max = -1;
  for (let pc = 0; pc < expr.length; pc += instrSize(expr[pc])) {
    const opcode = expr[pc];
    if (
      (opcode === EXPR_LOAD_VAR || opcode === EXPR_LOAD_ARRAY_LENGTH || opcode === EXPR_LOAD_STRING_LENGTH) &&
      expr[pc + 1] > max
    ) {
      max = expr[pc + 1];
    }
  }
  return max;
};

// 명령 하나가 차지하는 바이트 수(opcode 포함). LOAD_VAR a -> 3, FIELD_AT 1 -> 2, ADD -> 1
export const instrSize = (opcode: number) => {
  switch (opcode) {
    case EXPR_LOAD_VAR:
    case EXPR_LOAD_CONST:
    case EXPR_LOAD_ARRAY_LENGTH:
    case EXPR_LOAD_STRING_LENGTH:
      return 3;
    case EXPR_LOAD_SMALL_INT:
    case EXPR_FIELD_AT:
      return 2;
    default:
      return 1;
  }
};
