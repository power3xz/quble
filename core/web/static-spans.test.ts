// staticElementEnds - 구멍이 없는 정적 서브트리만 표에 든다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "./decode.ts";
import { TAGS } from "./dom-tables.ts";
import { OP_ELEM_OPEN, operandLen } from "./opcodes.ts";
import { staticElementEnds } from "./static-spans.ts";
import { buildFixture } from "./test-helpers/build.ts";

const module = decode(buildFixture("static_spans"));

// def 하나의 요소를 코드 순서로 "태그:S"(정적) 또는 "태그:D"(구멍 있음)로 낸다.
const outline = (defIndex: number): string[] => {
  const def = module.defs[defIndex];
  const start = def.codeOff;
  const end = def.codeOff + def.codeLen;
  const ends = staticElementEnds(module.code, start, end);
  const out: string[] = [];
  for (let pc = start; pc < end; ) {
    const op = module.code[pc];
    if (op === OP_ELEM_OPEN) {
      const tag = module.code[pc + 1] | (module.code[pc + 2] << 8);
      out.push(`${TAGS[tag]}:${ends.has(pc) ? "S" : "D"}`);
    }
    pc += 1 + operandLen(op);
  }
  return out;
};

test("구멍이 없는 요소는 모두 정적이다", () => {
  assert.deepEqual(outline(0), ["div:S", "span:S", "p:S"]);
});

test("값 텍스트가 든 요소와 그 조상은 정적이 아니고 형제는 정적이다", () => {
  assert.deepEqual(outline(1), ["div:D", "span:D", "p:S"]);
});

test("동적 속성과 이벤트가 붙은 요소는 정적이 아니다", () => {
  assert.deepEqual(outline(2), ["div:D", "a:D", "button:D", "em:S"]);
});

test("합성을 품은 요소는 정적이 아니고 형제는 정적이다", () => {
  assert.deepEqual(outline(3), ["div:D", "b:S"]);
  assert.deepEqual(outline(4), ["i:S"]);
});

test("@if를 품은 요소는 정적이 아니고 가지 안의 정적 요소는 정적이다", () => {
  assert.deepEqual(outline(5), ["div:D", "span:S", "p:S"]);
});

test("정적 요소가 중첩돼도 모두 정적이다", () => {
  assert.deepEqual(outline(6), ["div:S", "ul:S", "li:S", "li:S"]);
});

test("값은 그 요소의 ELEM_END 다음 pc다", () => {
  const def = module.defs[0];
  const start = def.codeOff;
  const end = def.codeOff + def.codeLen;
  const ends = staticElementEnds(module.code, start, end);
  // 루트 div가 def의 첫 op이고, 그 ELEM_END 뒤에는 HALT 하나만 남는다.
  assert.equal(ends.get(start), end - 1);
});
