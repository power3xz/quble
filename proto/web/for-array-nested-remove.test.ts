// 중첩 배열 요소의 재귀 회수 - 요소가 {label, cells: string[]}라 요소 제거 시 안쪽 cells 배열의 arrayInfo와
// 요소 leaf까지 재귀로 반납돼야 한다(freeElem). 제거된 요소 서브트리는 어디서도 참조되지 않으므로 누수 없이
// 안쪽까지 회수. 검증: 제거 후 push해도 arrayPool·leaves 길이가 안 늘면(반납분 재사용) 회수가 된 것이다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_nested_edit");
});

type Row = { label: string; cells: string[] };
const rows = (host: ParentNode) => [...host.querySelectorAll(".row")].map((r) => r.textContent?.replace(/\s+/g, ""));

const instantiate = (values: unknown, addQueue: Row[] = [], delQueue: number[] = []) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (a: number, e: unknown) => void;
      const props = ctx.props as Record<string, number>;
      const v = addQueue.shift();
      if (v !== undefined) {
        push(props.rows, v);
      }
    },
    DEL: (_d, ctx) => {
      const removeAt = ctx.removeAt as (a: number, i: number) => void;
      const props = ctx.props as Record<string, number>;
      const i = delQueue.shift();
      if (i !== undefined) {
        removeAt(props.rows, i);
      }
    },
  };
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return {
    host,
    add: host.querySelector(".add") as HTMLButtonElement,
    del: host.querySelector(".del") as HTMLButtonElement,
    inst,
  };
};

const initial = { rows: [{ label: "R1", cells: ["a", "b"] }, { label: "R2", cells: ["c"] }] };

test("중첩 배열 요소를 제거하면 안쪽 셀까지 그 행이 통째로 사라진다", () => {
  const { host, del } = instantiate(initial, [], [0]);
  assert.deepEqual(rows(host), ["R1ab", "R2c"], "초기(각 행이 label+cells)");
  del.click(); // R1 제거
  assert.deepEqual(rows(host), ["R2c"], "R1 행이 안쪽 셀까지 사라짐");
});

test("제거 후 push는 arrayPool을 안 늘린다(내부 배열 arrayInfo까지 재귀 회수·재사용)", () => {
  const { del, add, inst } = instantiate(initial, [{ label: "R3", cells: ["z"] }], [0]);
  const poolBefore = inst.arrayPool.length;
  del.click(); // R1 제거 -> 내부 cells arrayInfo 재귀 반납
  add.click(); // R3 push -> 반납분 재사용
  assert.equal(inst.arrayPool.length, poolBefore, "arrayPool 안 늘어남(내부 arrayInfo 재사용)");
});

test("제거 후 push한 행이 안쪽 셀까지 렌더된다", () => {
  const { host, del, add } = instantiate(initial, [{ label: "R3", cells: ["z"] }], [0]);
  del.click();
  add.click();
  assert.deepEqual(rows(host), ["R2c", "R3z"], "R3 행이 셀 z까지 렌더");
});
