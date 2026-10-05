import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPR_ADD,
  EXPR_AND,
  EXPR_ELEM_AT,
  EXPR_FIELD_AT,
  EXPR_GT,
  EXPR_LOAD_ARRAY_LENGTH,
  EXPR_LOAD_SMALL_INT,
  EXPR_LOAD_STRING_LENGTH,
  EXPR_LOAD_TRUE,
  EXPR_LOAD_VAR,
  EXPR_MUL,
  EXPR_NEG,
  EXPR_OR,
  EXPR_READ_LEAF,
  EXPR_SUB,
} from "./expr-opcode.ts";
import { buildSkipPastOp, buildSkipTable, CHAIN_END } from "./expr-skip-table.ts";

// LOAD_VAR는 opcode, scope_index, offset으로 3바이트다. 테스트의 슬롯은 모두 scope 0이고 offset으로
// 변수를 구별한다.
const v = (offset: number) => [EXPR_LOAD_VAR, 0, offset];
const bytes = (...parts: (number | number[])[]) => Uint8Array.from(parts.flat());

// 건너뛸 부분식이 있는 식의 표. 없으면 buildSkipTable이 null을 돌려주므로 여기서 실패한다.
const tableOf = (expr: Uint8Array) => {
  const table = buildSkipTable(expr);
  assert.ok(table);
  return table;
};

// 길이 len인 사슬 표를 모두 CHAIN_END로 채우고 entries에 적은 위치에만 값을 넣는다.
// (5, { 0: 4 }) -> [4, CHAIN_END, CHAIN_END, CHAIN_END, CHAIN_END]
const chain = (len: number, entries: Record<number, number>) => {
  const table = new Uint8Array(len).fill(CHAIN_END);
  for (const [position, value] of Object.entries(entries)) {
    table[Number(position)] = value;
  }
  return table;
};

// ((a + b) * c) - (d + e)
//   위치  0          3          6    7          10   11         14         17   18
//         LOAD_VAR a LOAD_VAR b ADD  LOAD_VAR c MUL  LOAD_VAR d LOAD_VAR e ADD  SUB
const MIXED = bytes(v(0), v(1), EXPR_ADD, v(2), EXPR_MUL, v(3), v(4), EXPR_ADD, EXPR_SUB);

test("같은 위치에서 시작하는 부분식들을 바깥부터 잇는다", () => {
  const table = tableOf(MIXED);
  // 위치 0에서 식 전체(18), (a + b) * c(10), a + b(6)가, 위치 11에서 d + e(17)가 시작한다.
  assert.deepEqual(table.sameStartOpChain, chain(19, { 0: 18, 18: 10, 10: 6, 11: 17 }));
});

test("연산마다 캐시 번호를 매기고 연산 수를 센다", () => {
  const table = tableOf(MIXED);
  assert.deepEqual(
    [table.cacheIndex[6], table.cacheIndex[10], table.cacheIndex[17], table.cacheIndex[18]],
    [0, 1, 2, 3],
  );
  assert.equal(table.opCount, 4);
});

test("단항 연산은 자식 하나를 왼쪽 자식으로 쳐 같은 위치에서 시작한다", () => {
  // -(a + b) * c
  //   위치  0          3          6    7    8          11
  //         LOAD_VAR a LOAD_VAR b ADD  NEG  LOAD_VAR c MUL
  // 위치 0에서 식 전체(11), -(a + b)(7), a + b(6)가 시작한다.
  const table = tableOf(bytes(v(0), v(1), EXPR_ADD, EXPR_NEG, v(2), EXPR_MUL));
  assert.deepEqual(table.sameStartOpChain, chain(12, { 0: 11, 11: 7, 7: 6 }));
  assert.equal(table.opCount, 3);
});

test("operand 길이가 다른 명령도 위치를 맞게 센다", () => {
  // true && (n + 5) || m
  //   위치  0         1          4                6    7    8          11
  //         LOAD_TRUE LOAD_VAR n LOAD_SMALL_INT 5 ADD  AND  LOAD_VAR m OR
  // LOAD_TRUE는 1바이트, LOAD_VAR는 3바이트, LOAD_SMALL_INT는 2바이트다.
  const table = tableOf(bytes(EXPR_LOAD_TRUE, v(0), EXPR_LOAD_SMALL_INT, 5, EXPR_ADD, EXPR_AND, v(1), EXPR_OR));
  assert.deepEqual(table.sameStartOpChain, chain(12, { 0: 11, 11: 7, 1: 6 }));
});

test("배열 인덱스 접근의 요소 칸을 읽는 명령(READ_LEAF)도 변수로 치고 건너뛰는 표를 만든다", () => {
  // a[i].b + x
  //   위치  0          3          6       7          9         10         13
  //         LOAD_VAR a LOAD_VAR i ELEM_AT FIELD_AT 0 READ_LEAF LOAD_VAR x ADD
  // FIELD_AT은 operand(필드 거리)까지 2바이트다. 위치 0에서 식 전체(13), a[i].b(9), a[i].b의
  // leafIndex(7), a[i]의 leafIndex(6)가 시작한다.
  const table = tableOf(bytes(v(0), v(1), EXPR_ELEM_AT, EXPR_FIELD_AT, 0, EXPR_READ_LEAF, v(2), EXPR_ADD));
  // 변수는 a(0), i(1), READ_LEAF(2), x(3)
  assert.deepEqual(
    table.positionsByVar,
    [[0], [3], [9], [10]].map((p) => Int32Array.from(p)),
  );
  // i(3)가 바뀌면 a[i].b 전체와 루트가 i를 품어 건너뛸 것이 없다.
  assert.deepEqual(table.skipPastOpByVar[1], {});
  // READ_LEAF가 읽는 요소 칸(9)이 바뀌면, 그 칸의 leafIndex를 내는 a[i].b의 앞부분(0~7)은 그대로라
  // 지난번 leafIndex를 쓰고 READ_LEAF만 다시 읽는다.
  assert.deepEqual(table.skipPastOpByVar[2], { 0: 7 });
  // x(10)가 바뀌면 a[i].b(0~9)를 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[3], { 0: 9 });
});

test("READ_LEAF가 읽을 leafIndex를 정하는 데 쓰인 변수에 그 leafIndex를 넘기는 연산을 단다", () => {
  // a[i].b + x
  //   위치  0          3          6       7          9         10         13
  //         LOAD_VAR a LOAD_VAR i ELEM_AT FIELD_AT 0 READ_LEAF LOAD_VAR x ADD
  // READ_LEAF(9)는 FIELD_AT(7)이 넘긴 leafIndex의 leaf를 읽는다. 그 leafIndex는 a, i로 계산된다.
  const table = tableOf(bytes(v(0), v(1), EXPR_ELEM_AT, EXPR_FIELD_AT, 0, EXPR_READ_LEAF, v(2), EXPR_ADD));
  // 변수는 a(0), i(1), READ_LEAF(2), x(3). READ_LEAF 자신과 x는 읽을 leafIndex를 바꾸지 않는다.
  assert.deepEqual(
    table.readLeafIndexOpsByVar,
    [[7], [7], [], []].map((p) => Int32Array.from(p)),
  );
});

test("중첩된 인덱스 접근은 안쪽이 바뀌면 바깥 READ_LEAF가 읽을 leafIndex도 바뀐다", () => {
  // a[b[k]].q
  //   위치  0          3          6          9       10        11      12         14
  //         LOAD_VAR a LOAD_VAR b LOAD_VAR k ELEM_AT READ_LEAF ELEM_AT FIELD_AT 0 READ_LEAF
  // 안쪽 READ_LEAF(10)는 ELEM_AT(9)이, 바깥 READ_LEAF(14)는 FIELD_AT(12)이 leafIndex를 넘긴다.
  const table = tableOf(
    bytes(v(0), v(1), v(2), EXPR_ELEM_AT, EXPR_READ_LEAF, EXPR_ELEM_AT, EXPR_FIELD_AT, 0, EXPR_READ_LEAF),
  );
  // 변수는 a(0), b(1), k(2), 안쪽 READ_LEAF(3), 바깥 READ_LEAF(4). 안쪽 READ_LEAF가 읽은 값은 바깥의
  // 인덱스라, 그 leaf가 바뀌면 바깥이 읽을 leafIndex가 바뀐다.
  assert.deepEqual(
    table.readLeafIndexOpsByVar,
    [[12], [9, 12], [9, 12], [12], []].map((p) => Int32Array.from(p)),
  );
});

test("배열 인덱스 접근이 없는 식은 READ_LEAF가 읽을 leafIndex를 바꾸는 변수가 없다", () => {
  assert.deepEqual(
    tableOf(MIXED).readLeafIndexOpsByVar,
    [[], [], [], [], []].map((p) => Int32Array.from(p)),
  );
});

test("operand가 붙은 FIELD_AT에서 끝나는 부분식을 건너뛰면 그 operand 다음 명령부터 이어 본다", () => {
  // a[i].b + (c + d), b는 요소의 둘째 필드라 FIELD_AT 1
  //   위치  0          3          6       7          9         10         13         16   17
  //         LOAD_VAR a LOAD_VAR i ELEM_AT FIELD_AT 1 READ_LEAF LOAD_VAR c LOAD_VAR d ADD  ADD
  const table = tableOf(
    bytes(v(0), v(1), EXPR_ELEM_AT, EXPR_FIELD_AT, 1, EXPR_READ_LEAF, v(2), v(3), EXPR_ADD, EXPR_ADD),
  );
  // READ_LEAF가 읽는 요소 칸(9)이 바뀌면 a[i].b의 leafIndex(0~7)를 건너뛰고 9로 간다. 8은 FIELD_AT의
  // operand 1이라 명령으로 읽으면 안 된다. 이어서 c + d(10~16)도 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[2], { 0: 7, 10: 16 });
});

test("READ_LEAF는 둘이 같은 칸을 읽을 수 있어도 명령마다 따로 변수다", () => {
  // a[i].b + a[i].b
  //   위치  0 LOAD_VAR a ... 9 READ_LEAF, 10 LOAD_VAR a ... 19 READ_LEAF, 20 ADD
  const one = [v(0), v(1), EXPR_ELEM_AT, EXPR_FIELD_AT, 0, EXPR_READ_LEAF];
  const table = tableOf(bytes(...one, ...one, EXPR_ADD));
  // a와 i는 두 번씩 나와 한 변수로 묶이고, READ_LEAF 둘은 따로다.
  assert.deepEqual(
    table.positionsByVar,
    [[0, 10], [3, 13], [9], [19]].map((p) => Int32Array.from(p)),
  );
});

test("칸을 읽는 명령을 변수로 묶어 번호를 매긴다", () => {
  const table = tableOf(MIXED);
  assert.deepEqual(
    table.positionsByVar,
    [[0], [3], [7], [11], [14]].map((p) => Int32Array.from(p)),
  );
  assert.deepEqual([table.varAt[0], table.varAt[3], table.varAt[7], table.varAt[11], table.varAt[14]], [0, 1, 2, 3, 4]);
});

test("같은 슬롯이라도 값 칸과 길이 칸은 다른 변수다", () => {
  // a + a.length + items.length   (a는 문자열, items는 배열이고 둘 다 offset 0 슬롯이라고 친다)
  //   위치  0          3                    6    7                 10
  //         LOAD_VAR a LOAD_STRING_LENGTH a ADD  LOAD_ARRAY_LENGTH a ADD
  // LOAD_VAR와 LOAD_STRING_LENGTH는 a의 값 칸을, LOAD_ARRAY_LENGTH는 길이 칸을 읽는다.
  const table = tableOf(bytes(v(0), EXPR_LOAD_STRING_LENGTH, 0, 0, EXPR_ADD, EXPR_LOAD_ARRAY_LENGTH, 0, 0, EXPR_ADD));
  assert.deepEqual(
    table.positionsByVar,
    [[0, 3], [7]].map((p) => Int32Array.from(p)),
  );
});

test("변수마다 바뀐 잎에서 루트로 가는 길 옆의 부분식을 건너뛰는 표를 만든다", () => {
  const table = tableOf(MIXED);
  // a(0)가 바뀌면 길은 ADD(6), MUL(10), SUB(18)이다. 옆의 d + e(11~17)를 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[0], { 11: 17 });
  // c(7)가 바뀌면 길은 MUL(10), SUB(18)이다. 옆의 a + b(0~6), d + e(11~17)를 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[2], { 0: 6, 11: 17 });
  // d(11)가 바뀌면 길은 ADD(17), SUB(18)이다. 옆의 (a + b) * c(0~10)를 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[3], { 0: 10 });
});

test("변수가 여러 위치에서 읽히면 모든 위치가 함께 바뀐 것으로 본다", () => {
  // (a + b) * (a - c)
  //   위치  0          3          6    7          10         13   14
  //         LOAD_VAR a LOAD_VAR b ADD  LOAD_VAR a LOAD_VAR c SUB  MUL
  const table = tableOf(bytes(v(0), v(1), EXPR_ADD, v(0), v(2), EXPR_SUB, EXPR_MUL));
  // a는 위치 0과 7에서 읽는다. 두 길이 ADD, SUB, MUL을 모두 지나 건너뛸 것이 없다.
  assert.deepEqual(table.skipPastOpByVar[0], {});
  // b(3)만 바뀌면 a - c(7~13)를 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[1], { 7: 13 });
  // c(10)만 바뀌면 a + b(0~6)를 건너뛴다.
  assert.deepEqual(table.skipPastOpByVar[2], { 0: 6 });
});

test("어느 변수가 바뀌어도 건너뛸 부분식이 없으면 표를 만들지 않는다", () => {
  // a - b: 어느 쪽이 바뀌어도 식 전체를 다시 센다. 잎은 읽는 비용이 cache와 같아 건너뛰지 않는다.
  assert.equal(buildSkipTable(bytes(v(0), v(1), EXPR_SUB)), null);
  // a > 50: 변수가 하나라 모든 연산이 그 변수를 품는다.
  assert.equal(buildSkipTable(bytes(v(0), EXPR_LOAD_SMALL_INT, 50, EXPR_GT)), null);
  // 연산이 없는 식
  assert.equal(buildSkipTable(bytes(v(0))), null);
  // (a + b) * (a - c): a가 바뀌면 건너뛸 것이 없지만 b가 바뀌면 a - c를 건너뛰어 표가 있다.
  assert.notEqual(buildSkipTable(bytes(v(0), v(1), EXPR_ADD, v(0), v(2), EXPR_SUB, EXPR_MUL)), null);
});

test("서로 다른 변수가 같은 칸을 가리키면 위치를 합쳐 표를 만든다", () => {
  const table = tableOf(MIXED);
  // d(11)와 e(14)가 같은 칸이면 (a + b) * c(0~10)만 건너뛰고, d + e는 다시 센다.
  assert.deepEqual(buildSkipPastOp(table, MIXED, Int32Array.of(11, 14)), { 0: 10 });
});

test("식에 없는 칸이면 식 전체를 건너뛴다", () => {
  const table = tableOf(MIXED);
  assert.deepEqual(buildSkipPastOp(table, MIXED, new Int32Array(0)), { 0: 18 });
});
