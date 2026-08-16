// IF_EXPR 통합 테스트 - 연산자가 붙은 @if 조건이 실제로 계산되고, 식이 읽는 칸이 바뀌면
// 다시 계산돼 가지가 바뀌는지 본다. 실제 컴파일러(.qubc -> .qubb)와 실제 runtime.ts를 쓴다.
//
// 잎 하나짜리 조건(@if (cond))은 기존 IF가 받으므로 if-integration.test.ts가 덮는다. 여기서는
// 표현식 테이블을 거치는 경로만 본다 - 후위 표기 평가, 파생 칸, 원본 칸 구독.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts"; // jsdom 전역 document 주입(첫 import)

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("if_expr");
});

// 픽스처가 그리는 p들의 class 목록 - 어느 조건이 참인지가 곧 이 목록이다.
const shown = (host: ParentNode) => [...host.querySelectorAll("p")].map((p) => p.className);

// props 선언 순서가 곧 leafIndex(평탄 leaf). tags는 배열이라 칸 하나(arrayInfoIndex)를 차지한다.
const LEAF = { count: 0, limit: 1, isPaid: 2, isCancelled: 3, note: 4, tags: 5 };

const instantiate = (values: Record<string, unknown>) => {
  const inst = compile(qubb)(0)(values, {});
  const host = mount(inst);
  const set = (name: keyof typeof LEAF, value: unknown) => inst.store.set(LEAF[name], value);
  return { inst, host, set };
};

const BASE = {
  count: 0,
  limit: 0,
  isPaid: false,
  isCancelled: false,
  note: "",
  tags: [] as string[],
};

test("연산자 조건이 초기 렌더에서 계산된다", () => {
  const { host } = instantiate(BASE);
  // 0 > 0 거짓 -> else 가지, 0 == 0 참, 0 * 2 - 1 > 0 거짓, 길이는 둘 다 0이라 거짓.
  assert.deepEqual(shown(host), ["not-gt", "eq"]);
});

test("대소 비교와 산술이 각각 계산된다", () => {
  const { host } = instantiate({ ...BASE, count: 3, limit: 1 });
  // 3 > 0 참, 3 == 1 거짓, 3 * 2 - 1 > 1 참.
  assert.deepEqual(shown(host), ["gt", "arith"]);
});

test("논리 연산이 계산된다 - `isPaid && !isCancelled`", () => {
  const { host } = instantiate({ ...BASE, isPaid: true });
  assert.ok(shown(host).includes("and"), "isPaid이고 취소가 아니면 참");

  const other = instantiate({ ...BASE, isPaid: true, isCancelled: true });
  assert.ok(!shown(other.host).includes("and"), "취소면 거짓");
});

test("문자열 길이가 계산된다", () => {
  const { host } = instantiate({ ...BASE, note: "hi" });
  assert.ok(shown(host).includes("strlen"), "note.length > 0");
});

test("배열 길이가 계산된다", () => {
  const { host } = instantiate({ ...BASE, tags: ["a", "b"] });
  assert.ok(shown(host).includes("arrlen"), "tags.length > 1");

  const one = instantiate({ ...BASE, tags: ["a"] });
  assert.ok(!shown(one.host).includes("arrlen"), "요소가 하나면 거짓");
});

// ── 반응 - 식이 읽는 칸이 바뀌면 다시 센다 ────────────────────────────
test("식이 읽는 칸을 set하면 가지가 바뀐다", () => {
  const { host, set } = instantiate(BASE);
  assert.deepEqual(shown(host), ["not-gt", "eq"]);

  set("count", 5);
  // 5 > 0 참으로 뒤집히고, 5 == 0 거짓이 되며, 5 * 2 - 1 > 0 참이 된다.
  assert.deepEqual(shown(host), ["gt", "arith"]);

  set("count", 0);
  assert.deepEqual(shown(host), ["not-gt", "eq"], "되돌리면 원래대로");
});

test("식이 여러 칸을 읽으면 어느 쪽이 바뀌어도 다시 센다", () => {
  const { host, set } = instantiate({ ...BASE, count: 1, limit: 1 });
  assert.ok(shown(host).includes("eq"), "1 == 1");

  set("limit", 2);
  assert.ok(!shown(host).includes("eq"), "limit이 바뀌어 거짓");

  set("count", 2);
  assert.ok(shown(host).includes("eq"), "count가 따라와 다시 참");
});

test("문자열 칸이 바뀌면 길이를 다시 잰다", () => {
  const { host, set } = instantiate(BASE);
  assert.ok(!shown(host).includes("strlen"), "빈 문자열");

  set("note", "hello");
  assert.ok(shown(host).includes("strlen"), "길이가 늘어 참");

  set("note", "");
  assert.ok(!shown(host).includes("strlen"), "다시 비면 거짓");
});
