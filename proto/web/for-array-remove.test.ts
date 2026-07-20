// 배열 요소 제거(removeAt)와 free list 재사용 - removeAt은 i번째 요소를 재귀 회수(freeElem)하고 그 회차 DOM만
// 뗀다(나머지 회차는 자기 요소 leaf를 그대로 보므로 무손상). 중간 제거로 생긴 빈 leaf 블록은 크기별 free
// list에 반납되어 다음 push(같은 크기)가 그 자리를 재사용한다. 끝 제거는 leaves를 되감아 pool을 줄인다.
//
// 한계: 요소 옆 삭제 버튼처럼 회차 인덱스($0)로 자기를 지우는 경우, 중간 제거 후 뒤 회차의 인덱스가 갱신되지
// 않는다(인덱스 반응성 미구현 - ISSUES.md). 그래서 여기선 @for 밖 버튼이 고정 index를 제거하는 형태로 검증한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_edit");
});

const tags = (host: ParentNode) => [...host.querySelectorAll(".tag")].map((li) => li.textContent);

const instantiate = (values: unknown, addQueue: string[] = [], delQueue: number[] = []) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (a: number, e: unknown) => void;
      const props = ctx.props as Record<string, number>;
      const v = addQueue.shift();
      if (v !== undefined) {
        push(props.tags, v);
      }
    },
    DEL: (_d, ctx) => {
      const removeAt = ctx.removeAt as (a: number, i: number) => void;
      const props = ctx.props as Record<string, number>;
      const i = delQueue.shift();
      if (i !== undefined) {
        removeAt(props.tags, i);
      }
    },
  };
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return {
    host,
    add: host.querySelector(".add") as HTMLButtonElement,
    del: host.querySelector(".del") as HTMLButtonElement,
    arrayPool: inst.arrayPool,
  };
};

test("중간 요소 제거: 그 회차만 빠지고 나머지는 유지", () => {
  const { host, del } = instantiate({ tags: ["a", "b", "c"] }, [], [1]); // b 제거
  assert.deepEqual(tags(host), ["a", "b", "c"], "초기");
  del.click();
  assert.deepEqual(tags(host), ["a", "c"], "b 빠지고 a·c 유지");
});

test("첫 요소 제거", () => {
  const { host, del } = instantiate({ tags: ["a", "b", "c"] }, [], [0]);
  del.click();
  assert.deepEqual(tags(host), ["b", "c"], "a 빠짐");
});

test("끝 요소 제거", () => {
  const { host, del } = instantiate({ tags: ["a", "b", "c"] }, [], [2]);
  del.click();
  assert.deepEqual(tags(host), ["a", "b"], "c 빠짐");
});

test("연속 제거로 빈 배열까지", () => {
  const { host, del } = instantiate({ tags: ["a", "b"] }, [], [0, 0]);
  del.click();
  del.click();
  assert.deepEqual(tags(host), [], "모두 제거");
});

test("중간 제거 후 push는 free된 leaf 자리를 재사용한다", () => {
  const { del, add, arrayPool } = instantiate({ tags: ["a", "b", "c"] }, ["d"], [1]);
  const info = arrayPool[0];
  const freedLeaf = info.elemStartLeafIndices[1]; // b의 leaf
  del.click(); // b 제거 -> freedLeaf가 free list(size 1)로
  add.click(); // d push -> 같은 크기라 freedLeaf 재사용
  assert.ok(
    info.elemStartLeafIndices.includes(freedLeaf),
    `push가 free된 leaf(${freedLeaf})를 재사용해야: ${JSON.stringify(info.elemStartLeafIndices)}`,
  );
});

test("끝 제거는 pool을 되감아 다음 push가 그 자리를 다시 쓴다", () => {
  const { del, add, arrayPool } = instantiate({ tags: ["a", "b", "c"] }, ["d"], [2]);
  const info = arrayPool[0];
  const tailLeaf = info.elemStartLeafIndices[2]; // c의 leaf(끝)
  del.click(); // c 제거 -> leaves.length 되감김
  add.click(); // d push -> 되감긴 끝 = 같은 자리
  assert.equal(info.elemStartLeafIndices[2], tailLeaf, "되감긴 끝 자리 재사용");
});
