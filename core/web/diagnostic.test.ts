// 진단 텍스트 파싱 - 편집기가 에러 줄을 짚으려면 첫 줄에서 경로/줄/칸을 읽어야 한다.
//
// 형식의 출처는 컴파일러(core/crates/compiler/src/diagnostic.rs의 format)다. 그쪽이 바뀌면
// 여기가 먼저 깨져야 한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiagnostic } from "../../components/diagnostic.ts";

test("경로/줄/칸/메시지를 뽑는다", () => {
  const text = [
    "card.qubc:6:14: error: no field `nope` on prop `user`",
    "  6 |       p() { {user.nope} }",
    "    |              ^^^^^^^^^",
  ].join("\n");

  assert.deepEqual(parseDiagnostic(text), {
    path: "card.qubc",
    line: 6,
    column: 14,
    message: "no field `nope` on prop `user`",
  });
});

test("위치 없는 진단은 null이다", () => {
  // 탓할 자리를 모르는 codegen 에러는 첫 줄이 `path: error: msg`뿐이다.
  assert.equal(parseDiagnostic("card.qubc: error: something went wrong"), null);
});

test("컴파일러가 안 낸 메시지도 null이다", () => {
  // 핸들러 import 실패 등 JS 쪽 에러가 같은 자리에 온다.
  assert.equal(parseDiagnostic("Unexpected token '}'"), null);
  assert.equal(parseDiagnostic(""), null);
});

test("메시지에 콜론이 있어도 잘리지 않는다", () => {
  const parsed = parseDiagnostic("a.qubc:1:1: error: expected `{`, found `:` at top level");

  assert.equal(parsed?.message, "expected `{`, found `:` at top level");
});

test("경로에 디렉터리가 있어도 읽는다", () => {
  const parsed = parseDiagnostic("./ui/card.qubc:12:3: error: nope");

  assert.equal(parsed?.path, "./ui/card.qubc");
  assert.equal(parsed?.line, 12);
});
