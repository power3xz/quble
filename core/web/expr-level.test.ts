// 식의 level - 읽는 변수 중 가장 깊은 변수가 정의된 스코프의 깊이.
//   props가 a, b, rows이면 scope_index는 a 0, b 1, rows 2이고, 바깥 @for의 item/index가 3, 4, 안쪽 @for의 item/index가
//   5, 6이다. 그래서 scope_index 0~2는 깊이 0, 3~4는 깊이 1, 5~6은 깊이 2다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { decode, type TQubleBytecode } from "./decode.ts";
import { exprLevelsOf } from "./expr-level.ts";
import { buildFixture } from "./test-helpers/build.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("expr_level");
});

test("식마다 읽는 변수의 가장 깊은 깊이를 돌려준다", () => {
  const module = decode(qubb as TQubleBytecode);

  // 식 표는 템플릿에 처음 나온 순서다.
  //   0  a * b           props만 읽는다 -> 0
  //   1  row.base + a    바깥 item과 props -> 1
  //   2  cell * a        안쪽 item과 props -> 2
  //   3  row.base * 2    @for 안쪽에 있어도 바깥 item만 읽는다 -> 1
  //   4  a + 1           안쪽 @for 안에 있어도 props만 읽는다 -> 0
  assert.deepEqual(exprLevelsOf(module, 0), [0, 1, 2, 1, 0]);
});
