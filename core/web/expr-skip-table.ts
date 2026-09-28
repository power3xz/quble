import { EXPR, instrSize } from "./expr-opcode.ts";

// 식을 다시 셀 때, 바뀐 칸과 무관한 부분식을 계산하지 않고 지난번 값을 쓰려고 만드는 표.
//
// 표의 위치는 모두 식 바이트 안의 위치(0부터 센 바이트 번호)다. 명령은 opcode 1바이트에 operand가
// 붙어, 예를 들어 LOAD_VAR는 3바이트를 차지한다. 식은 최대 255바이트(BYTECODE.md <EXPR> len:u8)라
// 위치는 u8에 들어간다.
//
// 아래 설명은 모두 이 식을 예로 든다. 슬롯 a~e는 scope 0의 offset 0~4다.
//
// ((a + b) * c) - (d + e)
//   위치  0          3          6    7          10   11         14         17   18
//         LOAD_VAR a LOAD_VAR b ADD  LOAD_VAR c MUL  LOAD_VAR d LOAD_VAR e ADD  SUB
//
// 부분식은 후위 바이트에서 이어진 구간이고, 끝은 그 부분식의 마지막 연산이다.
//   a + b 는 0~6, (a + b) * c 는 0~10, d + e 는 11~17, 식 전체는 0~18

// sameStartOpChain에서: 사슬이 여기서 끝난다. 여기서 시작하는 부분식이 없거나 더 안쪽 부분식이
// 없다. 식의 첫 명령은 늘 잎이라 연산 위치가 0일 수 없어 0을 쓴다.
export const CHAIN_END = 0;

// 바뀐 칸이 있을 때 건너뛸 부분식. 키는 부분식이 시작하는 잎 위치, 값은 그 부분식의 끝 연산
// 위치다. 평가하다 잎 위치 p에 왔을 때 skipPastOp[p]가 있으면, 연산 skipPastOp[p]까지를 계산하지
// 않고 cache에 든 그 연산의 지난번 값을 쓴 뒤 그 연산 다음 명령으로 간다. 키가 없으면 잎을 읽는다.
// 다음 명령은 끝 연산 위치 + 그 명령의 바이트 수다 - FIELD_AT처럼 operand가 붙은 연산이 끝일 수
// 있어 + 1이 아니다.
//
// 위 식에서 c(위치 7)가 바뀌면 c에서 루트로 가는 길(MUL 10, SUB 18) 옆의 부분식을 건너뛴다.
//   { 0: 6, 11: 17 }   위치 0에서 a + b(끝 ADD 6)를, 위치 11에서 d + e(끝 ADD 17)를 건너뛴다
export type TSkipPastOp = Record<number, number>;

// 식 바이트만으로 정해지는 표. 같은 식을 쓰는 인스턴스(@for 회차마다 생기는 것)끼리 하나를
// 공유한다.
export type TExprSkipTable = {
  // skipPastOp를 만들 때 쓴다. 잎 위치에서는 그 위치에서 시작하는 부분식 가운데 가장 바깥 것의 끝
  // 연산을, 연산 위치에서는 같은 위치에서 시작하는 한 겹 안쪽 부분식의 끝 연산을 가리킨다.
  //
  // 위치 0에서는 식 전체, (a + b) * c, a + b 세 부분식이 시작한다. 바깥부터 이으면
  //   sameStartOpChain[0] = 18, [18] = 10, [10] = 6, [6] = CHAIN_END
  // 위치 11에서는 d + e만 시작한다.
  //   sameStartOpChain[11] = 17, [17] = CHAIN_END
  // b(3), c(7), e(14)는 부모의 오른쪽 자식이라 거기서 시작하는 부분식이 없어 CHAIN_END다.
  sameStartOpChain: Uint8Array;
  // 연산 위치 -> 캐시 배열 번호. 캐시 배열을 식 길이가 아니라 연산 수만큼만 잡으려고 둔다.
  // 위 식에서 ADD(6) -> 0, MUL(10) -> 1, ADD(17) -> 2, SUB(18) -> 3. 연산 위치에서만 읽는다.
  cacheIndex: Uint8Array;
  // 연산 수. 위 식은 4.
  opCount: number;
  // 변수는 store 칸을 읽는 명령을 "같은 칸을 읽는가"로 묶은 것이다. 번호는 식에 처음 나오는
  // 순서다.
  //   - 같은 슬롯이라도 값 칸과 길이 칸은 다른 변수다. LOAD_VAR a와 LOAD_STRING_LENGTH a는 a의 값
  //     칸을 읽어 같은 변수이고, LOAD_ARRAY_LENGTH a는 a 배열의 길이 칸을 읽어 다른 변수다.
  //   - READ_LEAF(배열 인덱스 접근 a[i].b에서 요소 칸을 읽는 명령)는 하나하나가 따로 변수다. 어느
  //     칸을 읽는지는 i에 따라 실행 중에 정해지지만, 읽는 명령의 위치는 바이트에 고정돼 있다.
  //
  // 위 식에서 a=0, b=1, c=2, d=3, e=4.
  // 변수 번호 -> 그 변수를 읽는 위치들(오름차순). [[0], [3], [7], [11], [14]]
  positionsByVar: Int32Array[];
  // 읽는 명령의 위치 -> 변수 번호. 0 -> 0, 3 -> 1, 7 -> 2, 11 -> 3, 14 -> 4. 런타임이 식을 세며
  // 어느 칸을 어느 변수가 읽었는지 모을 때 쓴다.
  varAt: Uint8Array;
  // 변수 번호 -> 그 변수가 바뀌었을 때의 skipPastOp. 변수가 식에 여러 번 나오면 그 위치들이 함께
  // 바뀐 것으로 본다. c(2)는 { 0: 6, 11: 17 }.
  skipPastOpByVar: TSkipPastOp[];
};

// 잎 명령인가. 스택에서 아무것도 꺼내지 않고 값 하나를 올린다.
const isLeaf = (opcode: number) =>
  opcode === EXPR.LOAD_VAR ||
  opcode === EXPR.LOAD_CONST ||
  opcode === EXPR.LOAD_ARRAY_LENGTH ||
  opcode === EXPR.LOAD_STRING_LENGTH ||
  opcode === EXPR.LOAD_SMALL_INT ||
  opcode === EXPR.LOAD_TRUE ||
  opcode === EXPR.LOAD_FALSE;

// 단항 연산인가. 값 하나를 꺼내 하나를 올린다. 나머지 연산(ADD, ELEM_AT 등)은 둘을 꺼내 하나를 올린다.
const isUnary = (opcode: number) =>
  opcode === EXPR.NOT || opcode === EXPR.NEG || opcode === EXPR.FIELD_AT || opcode === EXPR.READ_LEAF;

// store 칸을 읽는 명령인가. 이 명령들만 변수로 묶는다. LOAD_CONST, LOAD_SMALL_INT, LOAD_TRUE,
// LOAD_FALSE는 값이 바이트에 박혀 있어 바뀌지 않는다.
const readsCell = (opcode: number) =>
  opcode === EXPR.LOAD_VAR ||
  opcode === EXPR.LOAD_STRING_LENGTH ||
  opcode === EXPR.LOAD_ARRAY_LENGTH ||
  opcode === EXPR.READ_LEAF;

// varKey가 같으면 같은 변수다. 슬롯을 읽는 명령(LOAD_VAR, LOAD_STRING_LENGTH, LOAD_ARRAY_LENGTH)에만
// 쓴다. 같은 슬롯이라도 값 칸과 길이 칸은 다른 변수라 칸 종류까지 넣는다.
//
// 칸 종류, scope_index, offset을 한 바이트씩 이어 붙인다: 종류 << 16 | scope << 8 | offset
//   LOAD_VAR           scope 0, offset 2  -> 0x00_00_02    a의 값 칸
//   LOAD_STRING_LENGTH scope 0, offset 2  -> 0x00_00_02    문자열 길이는 값 칸을 읽어 위와 같다
//   LOAD_ARRAY_LENGTH  scope 0, offset 2  -> 0x01_00_02    배열 길이는 길이 칸을 읽어 다르다
//   LOAD_VAR           scope 1, offset 2  -> 0x00_01_02    scope가 달라 다르다
const VALUE_CELL = 0;
const LENGTH_CELL = 1;
const varKey = (expr: Uint8Array, pc: number) => {
  const cell = expr[pc] === EXPR.LOAD_ARRAY_LENGTH ? LENGTH_CELL : VALUE_CELL;
  return (cell << 16) | (expr[pc + 1] << 8) | expr[pc + 2];
};

export const buildSkipTable = (expr: Uint8Array): TExprSkipTable => {
  const len = expr.length;
  const sameStartOpChain = new Uint8Array(len).fill(CHAIN_END);
  const cacheIndex = new Uint8Array(len);
  const varAt = new Uint8Array(len);
  const positions: number[][] = [];
  let opCount = 0;

  // pc의 명령이 읽는 칸의 변수 번호. 처음 나온 칸이면 새 번호를 준다.
  //   READ_LEAF는 읽는 칸이 실행 중에 정해져 서로 비교할 수 없으므로 늘 새 번호다.
  //   슬롯을 읽는 명령은 varKey가 같으면 같은 번호다.
  const varNumberByKey = new Map<number, number>();
  const newVar = () => {
    positions.push([]);
    return positions.length - 1;
  };
  const varNumberOf = (pc: number) => {
    if (expr[pc] === EXPR.READ_LEAF) {
      return newVar();
    }
    const key = varKey(expr, pc);
    const found = varNumberByKey.get(key);
    if (found !== undefined) {
      return found;
    }
    const created = newVar();
    varNumberByKey.set(key, created);
    return created;
  };

  // 연산 op를 start에서 시작하는 사슬에 넣는다. 후위 표기에서는 바깥 연산이 안쪽 연산보다 뒤에
  // 나오므로, 새로 만난 연산을 사슬 맨 앞에 넣으면 사슬이 바깥부터 이어진다.
  //   위 식의 위치 0에서
  //     ADD(6)를 만남    0 -> 6
  //     MUL(10)을 만남   0 -> 10 -> 6
  //     SUB(18)을 만남   0 -> 18 -> 10 -> 6
  const addToChain = (start: number, op: number) => {
    sameStartOpChain[op] = sameStartOpChain[start];
    sameStartOpChain[start] = op;
  };

  // 식을 세듯 스택을 쓰되, 값 대신 "그 값을 만든 부분식이 시작하는 위치"를 올린다.
  //   잎을 만나면 자기 위치를 올린다.
  //   연산을 만나면 오른쪽 피연산자를 꺼낸다. 남은 왼쪽 피연산자의 시작 위치가 곧 이 연산의 부분식이
  //   시작하는 위치이므로 그대로 둔다. 단항 연산은 피연산자가 하나라 꺼내지 않는다.
  //
  //   위 식에서 위치 6(ADD)에 오면 스택은 [0, 3]이다. b의 3을 꺼내면 0이 남고, a + b는 0에서 시작한다.
  const startStack: number[] = [];
  for (let pc = 0; pc < len; pc += instrSize(expr[pc])) {
    const opcode = expr[pc];
    if (readsCell(opcode)) {
      const varNumber = varNumberOf(pc);
      positions[varNumber].push(pc);
      varAt[pc] = varNumber;
    }

    if (isLeaf(opcode)) {
      startStack.push(pc);
      continue;
    }
    if (!isUnary(opcode)) {
      startStack.pop();
    }
    addToChain(startStack[startStack.length - 1], pc);
    cacheIndex[pc] = opCount++;
  }

  const table: TExprSkipTable = {
    sameStartOpChain,
    cacheIndex,
    opCount,
    positionsByVar: positions.map((p) => Int32Array.from(p)),
    varAt,
    skipPastOpByVar: [],
  };
  table.skipPastOpByVar = table.positionsByVar.map((p) => buildSkipPastOp(table, expr, p));
  return table;
};

// 바뀐 위치들(changedPositions, 오름차순)을 품지 않은 부분식을 골라 skipPastOp를 만든다.
// buildSkipTable이 변수마다 부른다. 한 인스턴스에서 서로 다른 변수가 같은 칸을 가리키면, 그 칸이
// 바뀔 때 두 변수가 함께 바뀌므로 런타임이 두 변수의 위치를 합쳐 정렬해 부른다.
//
// 위 식에서 d와 e가 같은 칸을 가리키면 changedPositions = [11, 14]
//   { 0: 10 }   (a + b) * c(0~10)는 건너뛰고, d + e는 d, e를 품어 다시 센다
// 식에 없는 칸이면 changedPositions = []이고 식 전체를 건너뛴다. { 0: 18 }
export const buildSkipPastOp = (
  table: TExprSkipTable,
  expr: Uint8Array,
  changedPositions: Int32Array,
): TSkipPastOp => {
  const chain = table.sameStartOpChain;

  // 위치 start~end 구간에 바뀐 위치가 하나라도 있나. 표를 만들 때만 도는 코드라 그냥 다 본다.
  const hasChangeIn = (start: number, end: number) => changedPositions.some((p) => start <= p && p <= end);

  // pc에서 시작하는 부분식을 바깥부터 보며, 바뀐 위치가 없는 첫 부분식의 끝 연산을 찾는다. 모두 바뀐
  // 위치를 품으면 CHAIN_END다.
  //   위 식에서 c(7)가 바뀌고 pc = 0이면
  //     SUB(18): 0~18에 7이 있음 -> MUL(10): 0~10에 7이 있음 -> ADD(6): 0~6에 없음 -> 6
  const outermostUnchangedFrom = (pc: number) => {
    let op = chain[pc];
    while (op !== CHAIN_END && hasChangeIn(pc, op)) {
      op = chain[op];
    }
    return op;
  };

  // 식을 셀 때와 같은 순서로 앞에서부터 간다. 건너뛴 부분식의 안쪽은 들르지 않는다 - 평가할 때도
  // 들르지 않기 때문이다.
  const skipPastOp: TSkipPastOp = {};
  let pc = 0;
  while (pc < expr.length) {
    if (isLeaf(expr[pc])) {
      const op = outermostUnchangedFrom(pc);
      if (op !== CHAIN_END) {
        skipPastOp[pc] = op;
        pc = op + instrSize(expr[op]);
        continue;
      }
    }
    pc += instrSize(expr[pc]);
  }
  return skipPastOp;
};
