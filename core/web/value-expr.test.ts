// 값 자리 표현식 - 보간(`${count * 2}`)과 속성(`id={count * 10}`)에 연산자가 붙은 식.
//
// @if 조건이 쓰던 평가기/opcode를 그대로 쓰되, 값 자리는 파생 칸을 안 잡는다 - 값을 받아 DOM에
// 바로 쓰므로 중간에 담을 자리가 필요 없다(IF_EXPR은 분기가 조건 칸을 구독해야 해서 잡는다).
// 확인할 것은 (1) 초기 값이 맞는가 (2) 식이 읽는 칸이 바뀌면 따라오는가 - 한 식이 두 칸을
// 참조하면 둘 다 구독 대상이다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("value_expr");
});

// props 선언 순서가 곧 leafIndex(평탄 leaf). tags는 배열이라 칸 하나(arrayInfoIndex).
//   0=count 1=limit 2=isPaid 3=note 4=tags
const LEAF = { count: 0, limit: 1, isPaid: 2, note: 3 } as const;

const instantiate = (props: { count: number; limit: number; isPaid: boolean; note: string; tags: string[] }) => {
  const inst = compile(qubb)(0)(props, {});
  const host = mount(inst);
  const textOf = (cls: string) => (host.querySelector(`.${cls}`) as HTMLElement).textContent;
  return {
    host,
    textOf,
    set: (leafIndex: number, v: unknown) => inst.store.set(leafIndex, v),
  };
};

const base = { count: 3, limit: 5, isPaid: true, note: "hello", tags: ["a", "b"] };

test("보간이 산술 식을 센다", () => {
  const { textOf } = instantiate(base);
  assert.equal(textOf("arith"), "6", "count * 2");
});

test("보간이 두 칸을 참조하는 식을 센다", () => {
  const { textOf } = instantiate(base);
  assert.equal(textOf("mixed"), "8", "count + limit");
});

test("보간이 비교 식을 bool로 찍는다", () => {
  const { textOf } = instantiate(base);
  assert.equal(textOf("cmp"), "false", "3 > 5");
});

test("보간이 문자열/배열 길이를 센다", () => {
  const { textOf } = instantiate(base);
  assert.equal(textOf("strlen"), "5", "note.length");
  assert.equal(textOf("arrlen"), "2", "tags.length");
});

test("잎 하나짜리 보간은 그대로 값을 찍는다", () => {
  const { textOf } = instantiate(base);
  assert.equal(textOf("leaf"), "hello", "연산자 없는 참조는 TEXT_VAR 경로");
});

test("식이 읽는 칸이 바뀌면 보간이 따라온다", () => {
  const { textOf, set } = instantiate(base);
  set(LEAF.count, 10);
  assert.equal(textOf("arith"), "20", "count * 2");
  assert.equal(textOf("mixed"), "15", "count + limit");
  assert.equal(textOf("cmp"), "true", "10 > 5");
});

test("한 식이 참조하는 두 칸을 각각 구독한다", () => {
  const { textOf, set } = instantiate(base);
  set(LEAF.limit, 1); // count는 그대로 3
  assert.equal(textOf("mixed"), "4", "limit만 바뀌어도 다시 센다");
  assert.equal(textOf("cmp"), "true", "3 > 1");
});

test("문자열 길이는 값 칸을 구독해 바뀔 때 다시 잰다", () => {
  const { textOf, set } = instantiate(base);
  set(LEAF.note, "hi");
  assert.equal(textOf("strlen"), "2");
});

test("전역 속성값이 식을 센다", () => {
  const { host } = instantiate(base);
  const el = host.querySelector("[title]") as HTMLElement;
  assert.equal(el.id, "30", "id={count * 10}");
  assert.equal(el.getAttribute("title"), "true", "title={isPaid}");
});

test("컴포넌트 속성값이 식을 센다", () => {
  const { host } = instantiate(base);
  const el = host.querySelector("[data-n]") as HTMLElement;
  assert.equal(el.getAttribute("data-n"), "2", "count - 1");
});

test("속성값 식도 칸이 바뀌면 따라온다", () => {
  const { host, set } = instantiate(base);
  set(LEAF.count, 7);
  const el = host.querySelector("[data-n]") as HTMLElement;
  assert.equal(el.getAttribute("data-n"), "6", "7 - 1");
  assert.equal((host.querySelector("[title]") as HTMLElement).id, "70", "count * 10");
});
