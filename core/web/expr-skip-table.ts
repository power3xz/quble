import {
  arityOf,
  EXPR_LOAD_ARRAY_LENGTH,
  EXPR_LOAD_INPUT,
  EXPR_LOAD_STRING_LENGTH,
  EXPR_LOAD_VAR,
  EXPR_READ_LEAF,
  instrSize,
} from "./expr-opcode.ts";

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
// 위치다. 평가하다 잎 위치 p에 왔을 때 skipPastOps[p]가 있으면, 연산 skipPastOps[p]까지를 계산하지
// 않고 cache에 든 그 연산의 지난번 값을 쓴 뒤 그 연산 다음 명령으로 간다. 키가 없으면 잎을 읽는다.
// 다음 명령은 끝 연산 위치 + 그 명령의 바이트 수다 - FIELD_AT처럼 operand가 붙은 연산이 끝일 수
// 있어 + 1이 아니다.
//
// 위 식에서 c(위치 7)가 바뀌면 c에서 루트로 가는 길(MUL 10, SUB 18) 옆의 부분식을 건너뛴다.
//   { 0: 6, 11: 17 }   위치 0에서 a + b(끝 ADD 6)를, 위치 11에서 d + e(끝 ADD 17)를 건너뛴다
export type TSkipPastOps = Record<number, number>;

// 식 바이트만으로 정해지는 표. 같은 식을 쓰는 인스턴스(@for 회차마다 생기는 것)끼리 하나를
// 공유한다.
export type TExprSkipTable = {
  // skipPastOps를 만들 때 쓴다. 잎 위치에서는 그 위치에서 시작하는 부분식 가운데 가장 바깥 것의 끝
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
  opInstrPosToCacheIndex: Uint8Array;
  // 연산 수. 위 식은 4.
  opCount: number;
  // 변수는 store 칸을 읽는 명령을 "같은 칸을 읽는가"로 묶은 것이다. 번호는 식에 처음 나오는
  // 순서다.
  //   - 같은 슬롯이라도 값 칸과 길이 칸은 다른 변수다. LOAD_VAR a와 LOAD_STRING_LENGTH a는 a의 값
  //     칸을 읽어 같은 변수이고, LOAD_ARRAY_LENGTH a는 a 배열의 길이 칸을 읽어 다른 변수다.
  //   - READ_LEAF(배열 인덱스 접근 a[i].b에서 요소 칸을 읽는 명령)는 하나하나가 따로 변수다. 어느
  //     칸을 읽는지는 i에 따라 실행 중에 정해지지만, 읽는 명령의 위치는 바이트에 고정돼 있다.
  //   - LOAD_INPUT(입력 식의 값을 올리는 명령)도 변수다. 칸을 읽지 않지만, 입력 식의 값이 바뀌면 칸이
  //     바뀐 것처럼 그 입력을 품지 않은 부분식을 건너뛴다. 같은 입력 자리를 읽으면 같은 변수다.
  //
  // 위 식에서 a=0, b=1, c=2, d=3, e=4.
  // 변수 번호 -> 그 변수를 읽는 위치들(오름차순). [[0], [3], [7], [11], [14]]
  varNumberToInstrPoses: Uint8Array[];
  // 읽는 명령의 위치 -> 변수 번호. 0 -> 0, 3 -> 1, 7 -> 2, 11 -> 3, 14 -> 4. 런타임이 식을 세며
  // 어느 칸을 어느 변수가 읽었는지 모을 때 쓴다.
  instrPosToVarNumber: Uint8Array;
  // 입력 자리(LOAD_INPUT의 operand, 식의 inputs 순번) -> 변수 번호. 입력 식의 값이 바뀌면 식 층이 이
  // 번호의 비트를 켠다. 입력 자리와 변수 번호는 식에 나오는 순서에 따라 어긋난다 - #0 + a + #1이면
  // 변수는 #0=0, a=1, #1=2라 [0, 2]다.
  inputPositionToVarNumber: Uint8Array;
  // 변수 번호 -> 그 변수가 바뀌었을 때의 skipPastOps. 변수가 식에 여러 번 나오면 그 위치들이 함께
  // 바뀐 것으로 본다. c(2)는 { 0: 6, 11: 17 }.
  varNumberToSkipPastOps: TSkipPastOps[];
  // 둘 이상의 변수가 함께 바뀌었을 때의 skipPastOps. 키는 바뀐 변수 번호를 비트로 모은 정수(변수 a=0, c=2가
  // 바뀌면 0b101). 같은 식을 쓰는 인스턴스(@for 행마다 하나씩)가 같은 조합이면 같은 표를 쓰도록, 조합이
  // 처음 나올 때 buildSkipPastOpsOfVars가 담는다.
  varMaskToSkipPastOps: Map<number, TSkipPastOps>;
  // 식에 READ_LEAF가 있는가. READ_LEAF는 읽는 leaf가 실행 중에 정해지는 유일한 명령이라, 이 식만 다시 셀 때
  // 읽은 leaf가 바뀌었는지 견주어 구독을 옮긴다. 다른 명령이 읽는 leaf는 scope로 정해져 바뀌지 않는다.
  hasIndexAccess: boolean;
};

// 변수로 묶는 명령인가 - store 칸을 읽는 명령과 입력 식의 값을 올리는 LOAD_INPUT. LOAD_CONST,
// LOAD_SMALL_INT, LOAD_TRUE, LOAD_FALSE는 값이 바이트에 박혀 있어 바뀌지 않는다.
const readsCell = (opcode: number) =>
  opcode === EXPR_LOAD_VAR ||
  opcode === EXPR_LOAD_STRING_LENGTH ||
  opcode === EXPR_LOAD_ARRAY_LENGTH ||
  opcode === EXPR_READ_LEAF ||
  opcode === EXPR_LOAD_INPUT;

// varKey가 같으면 같은 변수다. 슬롯을 읽는 명령(LOAD_VAR, LOAD_STRING_LENGTH, LOAD_ARRAY_LENGTH)과
// LOAD_INPUT에 쓴다. 같은 슬롯이라도 값 칸과 길이 칸은 다른 변수라 칸 종류까지 넣는다.
//
// 칸 종류, scope_index, offset을 한 바이트씩 이어 붙인다: 종류 << 16 | scope << 8 | offset
//   LOAD_VAR           scope 0, offset 2  -> 0x00_00_02    a의 값 칸
//   LOAD_STRING_LENGTH scope 0, offset 2  -> 0x00_00_02    문자열 길이는 값 칸을 읽어 위와 같다
//   LOAD_ARRAY_LENGTH  scope 0, offset 2  -> 0x01_00_02    배열 길이는 길이 칸을 읽어 다르다
//   LOAD_VAR           scope 1, offset 2  -> 0x00_01_02    scope가 달라 다르다
// LOAD_INPUT은 operand가 입력 자리 하나라 종류 << 16 | 입력 자리다.
//   LOAD_INPUT         입력 자리 1        -> 0x02_00_01
const VALUE_CELL = 0;
const LENGTH_CELL = 1;
const INPUT = 2;
const varKey = (expr: Uint8Array, pc: number) => {
  if (expr[pc] === EXPR_LOAD_INPUT) {
    return (INPUT << 16) | expr[pc + 1];
  }
  const cell = expr[pc] === EXPR_LOAD_ARRAY_LENGTH ? LENGTH_CELL : VALUE_CELL;
  return (cell << 16) | (expr[pc + 1] << 8) | expr[pc + 2];
};

// 바뀐 변수 조합을 비트마스크로 다루므로 표를 만들 수 있는 변수 수의 상한이다.
const MAX_VARS = 32;

// 어느 변수가 바뀌어도 건너뛸 부분식이 없는 식(a - b, big > 50)도 표를 만든다. 그 표의 skipPastOps는
// 모두 비어 처음부터 센다. 식 층이 계산 식의 읽은 leaf를 늘 변수 순서로 두려고 instrPosToVarNumber가
// 필요하다.
// 변수가 32개를 넘는 식만 null이다. 바뀐 변수를 번호를 비트로 모은 32비트 정수로 다루기 때문이다.
export const buildSkipTable = (expr: Uint8Array): TExprSkipTable | null => {
  const len = expr.length;
  const sameStartOpChain = new Uint8Array(len).fill(CHAIN_END);
  const opInstrPosToCacheIndex = new Uint8Array(len);
  const instrPosToVarNumber = new Uint8Array(len);
  const inputPositionToVarNumber: number[] = [];
  const positions: number[][] = [];
  let opCount = 0;

  // pc의 명령이 읽는 칸의 변수 번호. 처음 나온 칸이면 새 번호를 준다.
  //   READ_LEAF는 읽는 칸이 실행 중에 정해져 서로 비교할 수 없으므로 늘 새 번호다.
  //   슬롯을 읽는 명령과 LOAD_INPUT은 varKey가 같으면 같은 번호다.
  const varNumberByKey = new Map<number, number>();
  const newVar = () => {
    positions.push([]);
    return positions.length - 1;
  };
  const varNumberOf = (pc: number) => {
    if (expr[pc] === EXPR_READ_LEAF) {
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
  let hasIndexAccess = false;
  for (let pc = 0; pc < len; pc += instrSize(expr[pc])) {
    const opcode = expr[pc];
    if (opcode === EXPR_READ_LEAF) {
      hasIndexAccess = true;
    }
    if (readsCell(opcode)) {
      const varNumber = varNumberOf(pc);
      positions[varNumber].push(pc);
      instrPosToVarNumber[pc] = varNumber;
      if (opcode === EXPR_LOAD_INPUT) {
        inputPositionToVarNumber[expr[pc + 1]] = varNumber;
      }
    }

    const arity = arityOf(opcode);
    if (arity === 0) {
      startStack.push(pc);
      continue;
    }
    // 피연산자 arity개를 꺼내 하나를 올린다. 맨 왼쪽 피연산자의 시작 위치만 남기면 그것이 이 연산의
    // 부분식이 시작하는 위치다.
    for (let i = 1; i < arity; i++) {
      startStack.pop();
    }
    addToChain(startStack[startStack.length - 1], pc);
    opInstrPosToCacheIndex[pc] = opCount++;
  }

  if (positions.length > MAX_VARS) {
    return null;
  }

  const table: TExprSkipTable = {
    sameStartOpChain,
    opInstrPosToCacheIndex,
    opCount,
    varNumberToInstrPoses: positions.map((p) => Uint8Array.from(p)),
    instrPosToVarNumber,
    inputPositionToVarNumber: Uint8Array.from(inputPositionToVarNumber),
    varNumberToSkipPastOps: [],
    varMaskToSkipPastOps: new Map(),
    hasIndexAccess,
  };
  table.varNumberToSkipPastOps = table.varNumberToInstrPoses.map((p) => buildSkipPastOps(table, expr, p));
  return table;
};

// 바뀐 위치들(changedPositions)을 품지 않은 부분식을 골라 skipPastOps를 만든다.
// buildSkipTable이 변수마다 부른다. 변수 여럿이 함께 바뀌는 경우는 buildSkipPastOpsOfVars가 맡는다.
//
// 위 식에서 d와 e를 읽는 위치가 함께 바뀌면 changedPositions = [11, 14]
//   { 0: 10 }   (a + b) * c(0~10)는 건너뛰고, d + e는 d, e를 품어 다시 센다
// 식에 없는 칸이면 changedPositions = []이고 식 전체를 건너뛴다. { 0: 18 }
export const buildSkipPastOps = (
  table: TExprSkipTable,
  expr: Uint8Array,
  changedPositions: Uint8Array,
): TSkipPastOps => {
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
  const skipPastOps: TSkipPastOps = {};
  let pc = 0;
  while (pc < expr.length) {
    if (arityOf(expr[pc]) === 0) {
      const op = outermostUnchangedFrom(pc);
      if (op !== CHAIN_END) {
        skipPastOps[pc] = op;
        pc = op + instrSize(expr[op]);
        continue;
      }
    }
    pc += instrSize(expr[pc]);
  }
  return skipPastOps;
};

// 바뀐 변수들(changedVarMask)을 하나도 품지 않은 부분식의 skipPastOps를 만든다. 바뀐 변수는 변수 번호를
// 비트로 모은 정수다(변수 a=0, c=2가 바뀌면 0b101). 변수가 하나면 미리 만들어 둔 table.varNumberToSkipPastOps의
// 것을 그대로 돌려주고, 둘 이상이면 조합마다 한 번만 만들어 table.varMaskToSkipPastOps에 담는다.
//
// 위 식에서 변수 번호는 a=0, b=1, c=2, d=3, e=4다.
//   바뀐 변수  changedVarMask  skipPastOps
//   c          0b00100         { 0: 6, 11: 17 }   c만 바뀌면 a + b(0~6)와 d + e(11~17)를 건너뛴다
//   a          0b00001         { 11: 17 }         a만 바뀌면 d + e를 건너뛴다. a + b는 a를 품어 다시 센다
//   a, c       0b00101         { 11: 17 }         a와 c가 함께 바뀌면 위 둘 모두에 있는 d + e만 건너뛴다
//   a, d       0b01001         {}                 (a + b) * c는 a를, d + e는 d를 품어 건너뛸 것이 없다
export const buildSkipPastOpsOfVars = (
  table: TExprSkipTable,
  expr: Uint8Array,
  changedVarMask: number,
): TSkipPastOps => {
  // 비트가 하나뿐인가. 최상위 비트(31)만 켜진 음수에서도 changedVarMask - 1이 32비트로 감겨 맞다.
  if ((changedVarMask & (changedVarMask - 1)) === 0) {
    return table.varNumberToSkipPastOps[31 - Math.clz32(changedVarMask)];
  }
  const found = table.varMaskToSkipPastOps.get(changedVarMask);
  if (found !== undefined) {
    return found;
  }
  const positions: number[] = [];
  for (let varNumber = 0; varNumber < table.varNumberToInstrPoses.length; varNumber++) {
    if (changedVarMask & (1 << varNumber)) {
      positions.push(...table.varNumberToInstrPoses[varNumber]);
    }
  }
  const skipPastOps = buildSkipPastOps(table, expr, Uint8Array.from(positions));
  table.varMaskToSkipPastOps.set(changedVarMask, skipPastOps);
  return skipPastOps;
};
