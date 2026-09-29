// 표현식 opcode(BYTECODE.md #4 <EXPR>). OP와 다른 이름공간이다 - 같은 값이 서로 다른 뜻이라
// 식 바이트를 OP로 읽으면 안 된다.
//
// 식은 후위 표기라 앞에서 뒤로 한 번 훑으면 끝난다. 타입은 컴파일타임에 검사가 끝나
// (compiler/src/expr_type.rs) 여기서 타입을 안 본다.
//
// 스택에는 값이 오르는 것이 기본이고, ELEM_AT/FIELD_AT만 leafIndex를 올린다 - 요소 위치는
// 인덱스를 세어 봐야 정해져 컴파일타임에 슬롯으로 접히지 않는다. READ_LEAF가 그 leafIndex를
// 값으로 바꾸므로 연산자에는 늘 값만 닿는다.
export const EXPR = {
  LOAD_VAR: 0x00, // scope_index: u8, offset: u8
  LOAD_CONST: 0x01, // const_index: u16
  LOAD_ARRAY_LENGTH: 0x02, // scope_index: u8, offset: u8
  LOAD_STRING_LENGTH: 0x03, // scope_index: u8, offset: u8
  LOAD_SMALL_INT: 0x04, // value: u8
  LOAD_TRUE: 0x05,
  LOAD_FALSE: 0x06,
  ADD: 0x10,
  SUB: 0x11,
  MUL: 0x12,
  DIV: 0x13,
  REM: 0x14,
  EQ: 0x15,
  NE: 0x16,
  LT: 0x17,
  LE: 0x18,
  GT: 0x19,
  GE: 0x1a,
  AND: 0x1b,
  OR: 0x1c,
  NOT: 0x1d,
  NEG: 0x1e,
  ELEM_AT: 0x1f, // 인덱스와 arrayInfoIndex를 꺼내 elemStartLeafIndices[i]를 올린다
  FIELD_AT: 0x20, // offset: u8 - leafIndex에 필드 거리를 더한다
  READ_LEAF: 0x21, // leafIndex를 꺼내 그 칸의 값을 올린다
} as const;

// 명령 하나가 차지하는 바이트 수(opcode 포함). LOAD_VAR a -> 3, FIELD_AT 1 -> 2, ADD -> 1
export const instrSize = (opcode: number) => {
  switch (opcode) {
    case EXPR.LOAD_VAR:
    case EXPR.LOAD_CONST:
    case EXPR.LOAD_ARRAY_LENGTH:
    case EXPR.LOAD_STRING_LENGTH:
      return 3;
    case EXPR.LOAD_SMALL_INT:
    case EXPR.FIELD_AT:
      return 2;
    default:
      return 1;
  }
};
