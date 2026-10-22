// 식 평가 - 후위 바이트를 세고, 식 정의당 건너뛰기 표를 둔다(EXPR-EVAL.md). 구독은 여기서 걸지 않는다.

import type { TArrayInfo } from "./array-info.ts";
import type { TModule } from "./decode.ts";
import {
  EXPR_ADD,
  EXPR_AND,
  EXPR_DIV,
  EXPR_ELEM_AT,
  EXPR_EQ,
  EXPR_FIELD_AT,
  EXPR_GE,
  EXPR_GT,
  EXPR_LE,
  EXPR_LOAD_ARRAY_LENGTH,
  EXPR_LOAD_CONST,
  EXPR_LOAD_FALSE,
  EXPR_LOAD_SMALL_INT,
  EXPR_LOAD_STRING_LENGTH,
  EXPR_LOAD_TRUE,
  EXPR_LOAD_VAR,
  EXPR_LT,
  EXPR_MUL,
  EXPR_NE,
  EXPR_NEG,
  EXPR_NOT,
  EXPR_OR,
  EXPR_READ_LEAF,
  EXPR_REM,
  EXPR_SUB,
  instrSize,
} from "./expr-opcode.ts";
import { buildSkipTable, type TExprSkipTable, type TSkipPastOps } from "./expr-skip-table.ts";
import type { LeafStoreSubject } from "./leaf-store.ts";
import type { Pool } from "./pool-allocator.ts";
import { CONST, RAW, slotKind, slotRef, type TScope } from "./scope.ts";

// 이항 연산자 하나를 적용한다. 피연산자 타입은 컴파일타임에 맞춰져(compiler/src/expr_type.rs)
// 여기서 검사하지 않는다 - 산술/비교는 number, 논리는 bool, `==`/`!=`는 양쪽이 같은 타입이다.
const applyBinary = (op: number, left: unknown, right: unknown): unknown => {
  switch (op) {
    case EXPR_ADD:
      return (left as number) + (right as number);
    case EXPR_SUB:
      return (left as number) - (right as number);
    case EXPR_MUL:
      return (left as number) * (right as number);
    case EXPR_DIV:
      return (left as number) / (right as number);
    case EXPR_REM:
      return (left as number) % (right as number);
    case EXPR_EQ:
      return left === right;
    case EXPR_NE:
      return left !== right;
    case EXPR_LT:
      return (left as number) < (right as number);
    case EXPR_LE:
      return (left as number) <= (right as number);
    case EXPR_GT:
      return (left as number) > (right as number);
    case EXPR_GE:
      return (left as number) >= (right as number);
    case EXPR_AND:
      return (left as boolean) && (right as boolean);
    case EXPR_OR:
      return (left as boolean) || (right as boolean);
    default:
      throw new Error(`bad expr opcode 0x${op.toString(16)}`);
  }
};

// 식 정의(expr 바이트)당 건너뛰기 표 하나. 같은 식을 쓰는 인스턴스(@for 회차마다 생기는 것)끼리
// 공유한다. expr 바이트는 decode한 모듈이 들고 있어, 모듈이 버려지면 표도 함께 버려진다.
const skipTables = new WeakMap<Uint8Array, TExprSkipTable | null>();

// 식을 처음 셀 때 runExpr에 넘기는 값 - 아무것도 건너뛰지 않는다.
export const SKIP_NOTHING: TSkipPastOps = {};

// 식 평가 스택. runExpr마다 새로 만들지 않고 이것을 다시 쓴다. 식 평가는 동기이고 runExpr가 다시 부르지
// 않아 런타임 인스턴스가 여럿이어도 하나를 함께 쓴다.
const exprStack: unknown[] = [];

export class ExprEvaluator {
  constpool: TModule["constpool"];
  store: LeafStoreSubject;
  arrayPool: Pool<TArrayInfo>;

  constructor(constpool: TModule["constpool"], store: LeafStoreSubject, arrayPool: Pool<TArrayInfo>) {
    this.constpool = constpool;
    this.store = store;
    this.arrayPool = arrayPool;
  }

  // 식 정의당 건너뛰기 표 하나. 같은 expr 바이트면 같은 표를 돌려준다. 건너뛸 부분식이 없는 식은
  // null이고, 그것도 담아 두어 다시 판정하지 않는다.
  skipTable = (expr: Uint8Array): TExprSkipTable | null => {
    let table = skipTables.get(expr);
    if (table === undefined) {
      table = buildSkipTable(expr);
      skipTables.set(expr, table);
    }
    return table;
  };

  // 식을 처음부터 센다. 값과 함께, 변수(expr-skip-table.ts)마다 읽은 leafIndex(leafOfVar)를 낸다.
  // 연산 결과는 cache에 써 둔다.
  //
  // 읽은 leafIndex는 구독할 칸이다. 세어 보지 않고는 알 수 없어 값과 함께 나온다 - 인덱스 접근은
  // 어느 요소를 읽는지가 인덱스를 세어 봐야 정해진다. 범위 밖 에러로 식이 중간에 멈추면 못 읽은
  // 변수는 -1이다.
  //
  // ((a + b) * c) - (d + e)에서 a~e가 leafIndex 20~24를 읽는 인스턴스
  //   leafOfVar [20, 21, 22, 23, 24]
  // 부모가 d와 e에 같은 칸 23을 넘긴 인스턴스
  //   leafOfVar [20, 21, 22, 23, 23]
  //
  // leaf 기준(leaf마다 읽는 변수 목록)이 아니라 변수 기준이라, 길이가 식 정의로 정해져 처음부터 맞게
  // 잡는다. 빈 배열에 push로 채우면 V8이 늘어날 몫까지 잡아 1만 행에서 쓰지 않는 용량이 크게 남는다.
  evalExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable,
    cache: unknown[],
  ): { value: unknown; leafOfVar: number[] } => {
    const reads: number[] = [];
    const value = this.runExpr(expr, pairs, table, cache, SKIP_NOTHING, reads);
    const leafOfVar: number[] = new Array(table.positionsByVar.length).fill(-1);
    for (let i = 0; i < reads.length; i += 2) {
      leafOfVar[table.varAt[reads[i + 1]]] = reads[i];
    }
    return { value, leafOfVar };
  };

  // 식을 다시 센다. skipPastOps에 적힌 부분식은 계산하지 않고 cache의 지난번 값을 쓴다.
  reevalExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable,
    cache: unknown[],
    skipPastOps: TSkipPastOps,
  ): unknown => this.runExpr(expr, pairs, table, cache, skipPastOps, null);

  // 식을 후위 표기로 센다(BYTECODE.md #4 <EXPR>). evalExpr와 reevalExpr가 함께 쓰는 본체다.
  //
  // 타입은 컴파일타임에 검사가 끝나(compiler/src/expr_type.rs) 여기서 안 본다.
  //
  //   - 잎 명령 위치 at에 skipPastOps[at]이 있으면, 그 연산까지를 계산하지 않고 cache에 든 그 연산의
  //     지난번 값을 올린 뒤 그 연산 다음 명령으로 간다.
  //   - 연산 결과는 cache[table.cacheIndex[연산 위치]]에 써 둔다. 다음에 건너뛸 때 이 값을 쓴다.
  //     건너뛸 부분식이 없는 식은 표도 cache도 없어(null) 쓰지 않는다.
  //   - reads가 있으면 store 칸을 읽을 때마다 leafIndex와 읽은 명령의 위치를 이어 붙인다. a + b에서
  //     a, b가 칸 20, 21이면 [20, 0, 21, 3]. 다시 셀 때는 구독이 이미 걸려 있어 null을 넘긴다.
  runExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable | null,
    cache: unknown[] | null,
    skipPastOps: TSkipPastOps,
    reads: number[] | null,
  ): unknown => {
    // 스택 높이. 0부터 센다 - 앞선 평가가 ELEM_AT의 RangeError로 중간에 멈췄으면 배열에 그때 값이
    // 남아 있다. 배열 길이를 0으로 비우지 않는 것은 V8이 저장 공간을 놓아 다음에 다시 할당하기 때문이다.
    let sp = 0;
    for (let pc = 0; pc < expr.length; ) {
      const at = pc;
      const skipPastOpsAt = skipPastOps[at];
      if (skipPastOpsAt !== undefined && table !== null && cache !== null) {
        exprStack[sp++] = cache[table.cacheIndex[skipPastOpsAt]];
        pc = skipPastOpsAt + instrSize(expr[skipPastOpsAt]);
        continue;
      }
      const op = expr[pc++];
      // 연산의 결과. 값을 올리기만 하는 명령은 직접 올리고 다음 명령으로 넘어간다.
      let result: unknown;
      switch (op) {
        case EXPR_LOAD_VAR: {
          exprStack[sp++] = this.slotValue(pairs, expr[pc], expr[pc + 1], at, reads);
          pc += 2;
          continue;
        }
        case EXPR_LOAD_ARRAY_LENGTH: {
          // 배열 칸의 값이 arrayInfoIndex - 요소 수는 그 arrayInfo가 든다.
          //
          // 구독은 배열 칸이 아니라 길이 칸(sizeLeafIndex)에 건다 - 배열 칸의 값은 요소가 늘고
          // 줄어도 안 바뀐다. @for가 grow/shrink 발화에 쓰는 그 칸이고, 아직 없으면 여기서
          // 확보한다(주인은 배열이라 식이 없어져도 안 반납).
          const leafIndex = slotRef(pairs, expr[pc]) + expr[pc + 1];
          const info = this.arrayPool.entries[this.store.get(leafIndex) as number];
          if (slotKind(pairs, expr[pc]) !== CONST) {
            info.sizeLeafIndex ??= this.store.alloc([info.elemStartLeafIndices.length]);
            reads?.push(info.sizeLeafIndex, at);
          }
          exprStack[sp++] = info.elemStartLeafIndices.length;
          pc += 2;
          continue;
        }
        case EXPR_LOAD_STRING_LENGTH: {
          // 길이는 값 칸 자체를 구독해 바뀔 때 다시 잰다 - slotValue가 그 칸을 담는다.
          exprStack[sp++] = String(this.slotValue(pairs, expr[pc], expr[pc + 1], at, reads)).length;
          pc += 2;
          continue;
        }
        case EXPR_LOAD_CONST: {
          exprStack[sp++] = this.constpool[expr[pc] | (expr[pc + 1] << 8)];
          pc += 2;
          continue;
        }
        case EXPR_LOAD_SMALL_INT:
          exprStack[sp++] = expr[pc++];
          continue;
        case EXPR_LOAD_TRUE:
          exprStack[sp++] = true;
          continue;
        case EXPR_LOAD_FALSE:
          exprStack[sp++] = false;
          continue;
        // 단항 - 하나 꺼내 하나 넣는다.
        case EXPR_NOT:
          result = !exprStack[--sp];
          break;
        case EXPR_NEG:
          result = -(exprStack[--sp] as number);
          break;
        // 인덱스 접근 - 값 대신 leafIndex를 올린다. 요소 위치는 인덱스를 세어 봐야 정해진다.
        // 요소가 없는 인덱스(범위 밖, 음수, 정수 아님)는 에러다 - 범위는 핸들러 로직이 지킨다.
        case EXPR_ELEM_AT: {
          const i = exprStack[--sp] as number;
          const info = this.arrayPool.entries[exprStack[--sp] as number];
          const start = info.elemStartLeafIndices[i];
          if (start === undefined) {
            throw new RangeError(`index ${i} out of range (length ${info.elemStartLeafIndices.length})`);
          }
          result = start;
          break;
        }
        case EXPR_FIELD_AT:
          result = (exprStack[--sp] as number) + expr[pc++];
          break;
        case EXPR_READ_LEAF: {
          const leafIndex = exprStack[--sp] as number;
          reads?.push(leafIndex, at);
          result = this.store.get(leafIndex);
          break;
        }
        // 이항 - 둘 꺼내 하나 넣는다. 나중에 밀린 것이 오른쪽이라 먼저 꺼내진다.
        default: {
          const right = exprStack[--sp];
          const left = exprStack[--sp];
          result = applyBinary(op, left, right);
          break;
        }
      }
      // 연산 결과를 스택에 올리고, cache가 있으면 거기에도 써 둔다.
      exprStack[sp++] = result;
      if (table !== null && cache !== null) {
        cache[table.cacheIndex[at]] = result;
      }
    }
    return exprStack[0];
  };

  // 슬롯 하나가 가리키는 값. CONST면 상수풀, RAW면 ref 자체(개수 반복의 회차 번호), STORE면 store 칸.
  // CONST와 RAW는 바뀌지 않아 구독하지 않는다. STORE 칸을 읽으면 reads에 leafIndex와 읽은 위치(at)를 붙인다.
  slotValue = (pairs: TScope, scopeIndex: number, offset: number, at: number, reads: number[] | null): unknown => {
    const ref = slotRef(pairs, scopeIndex);
    const kind = slotKind(pairs, scopeIndex);
    if (kind === CONST) {
      return this.constpool[ref];
    }
    if (kind === RAW) {
      return ref;
    }
    reads?.push(ref + offset, at);
    return this.store.get(ref + offset);
  };
}
