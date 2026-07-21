// 회차 인덱스 반응성 - array-for 몸체 {i}가 회차 번호를 표시하고, 요소 옆 삭제 버튼이 자기 회차 인덱스($0)로
// 자기를 지운다(@for 안 element라 fullname은 익명 [$0].DEL). 값 고정·위치 이동 설계라 중간 제거 시 요소는 store에서
// 안 움직이고 목록만 당겨지는데, 인덱스는 store leaf(indexLeafIndices)라 removeAt이 뒤 인덱스를 set으로 당긴다.
// 그래서 (1) 몸체 {i}가 당겨진 새 번호로 자동 갱신되고, (2) 뒤 요소의 삭제 버튼 $0도 당겨진 값이라 자기를 정확히 지운다.
// (이전 한계: 인덱스가 build 시점 스냅샷이라 안 당겨져, b 지운 뒤 c 버튼이 $0=2로 d를 지우던 버그 - 해소됨.)

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_index_del");
});

// 각 행을 "인덱스:값"으로 - 인덱스 표시(몸체 {i})와 값을 함께 본다.
const rows = (host: ParentNode) =>
  [...host.querySelectorAll(".tag")].map(
    (li) => `${li.querySelector(".idx")?.textContent}:${li.querySelector(".val")?.textContent}`,
  );

const instantiate = (values: unknown) => {
  const handlers: THandlers = {
    // @for 안 element라 fullname은 익명 [$0] 접미(for_event_element와 같은 규칙).
    "[$0].DEL": (_d, ctx) => {
      const removeAt = ctx.removeAt as (a: number, i: number) => void;
      const props = ctx.props as Record<string, number>;
      removeAt(props.tags, ctx.$0 as number); // 자기 회차 인덱스로 자기를 지운다
    },
  };
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return { host };
};

const delButton = (host: ParentNode, row: number) =>
  [...host.querySelectorAll(".tag")][row].querySelector(".del") as HTMLButtonElement;

test("몸체 {i}가 회차 번호를 표시한다", () => {
  const { host } = instantiate({ tags: ["a", "b", "c", "d"] });
  assert.deepEqual(rows(host), ["0:a", "1:b", "2:c", "3:d"], "각 행이 인덱스:값");
});

test("중간 요소를 지우면 뒤 회차의 몸체 {i}가 당겨진 새 번호로 갱신된다", () => {
  const { host } = instantiate({ tags: ["a", "b", "c", "d"] });
  delButton(host, 1).click(); // b(idx1) 제거
  assert.deepEqual(rows(host), ["0:a", "1:c", "2:d"], "c는 2->1, d는 3->2로 인덱스 갱신");
});

test("요소 옆 삭제 버튼이 자기 $0으로 자기를 정확히 지운다(중간 제거 후에도)", () => {
  const { host } = instantiate({ tags: ["a", "b", "c", "d"] });
  delButton(host, 1).click(); // b 제거 -> c가 idx1로 당겨짐
  delButton(host, 1).click(); // 지금 idx1은 c - c의 버튼 $0=1이라 c를 지운다(옛 버그면 d를 지웠다)
  assert.deepEqual(rows(host), ["0:a", "1:d"], "c가 정확히 지워짐(d 아님)");
});

test("맨 앞을 반복해 지우면 매번 앞이 당겨져 인덱스가 재정렬된다", () => {
  const { host } = instantiate({ tags: ["a", "b", "c"] });
  delButton(host, 0).click(); // a 제거 -> b,c 앞으로
  assert.deepEqual(rows(host), ["0:b", "1:c"], "b:0, c:1");
  delButton(host, 0).click(); // b 제거
  assert.deepEqual(rows(host), ["0:c"], "c:0");
});
