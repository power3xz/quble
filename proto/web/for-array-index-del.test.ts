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

const instantiate = (values: unknown, addQueue: string[] = []) => {
  const handlers: THandlers = {
    ADD: (_d, ctx) => {
      const push = ctx.push as (a: number, e: unknown) => void;
      const props = ctx.props as Record<string, number>;
      push(props.tags, addQueue.shift() ?? "n");
    },
    // @for 안 element라 fullname은 익명 [$0] 접미(for_event_element와 같은 규칙).
    "[$0].DEL": (_d, ctx) => {
      const removeAt = ctx.removeAt as (a: number, i: number) => void;
      const props = ctx.props as Record<string, number>;
      removeAt(props.tags, ctx.$0 as number); // 자기 회차 인덱스로 자기를 지운다
    },
  };
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  return { host, add: host.querySelector(".add") as HTMLButtonElement };
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

// 전부 제거해 0개가 된 뒤 다시 추가·제거가 이어지는지 - "@for 순회 중"을 indexLeafIndices.length(빈 배열 0)로
// 판단하면 여기서 인덱스 채움을 건너뛰어 인덱스 없는 요소가 쌓이고, 다음 제거가 region과 어긋나 크래시했다.
// forRegionIndex 기준으로 고쳤다. 회귀 방지.
test("전부 제거해 0개가 된 뒤 다시 추가하면 인덱스가 정상 부여된다", () => {
  const { host, add } = instantiate({ tags: ["a"] });
  delButton(host, 0).click(); // 0개로
  assert.deepEqual(rows(host), [], "빈 목록");
  add.click(); // 다시 추가 - 인덱스 0이 붙어야(옛 버그면 빈칸)
  assert.deepEqual(rows(host), ["0:n"], "추가된 요소에 인덱스 0");
  add.click();
  assert.deepEqual(rows(host), ["0:n", "1:n"], "인덱스 이어짐");
});

test("0개 후 재추가한 요소도 삭제가 정상 동작한다(옛 버그: region 어긋나 크래시)", () => {
  const { host, add } = instantiate({ tags: ["a"] });
  delButton(host, 0).click(); // 0개
  add.click();
  add.click(); // [0:n, 1:n]
  delButton(host, 0).click(); // 크래시 없이 앞을 제거, 뒤 당김
  assert.deepEqual(rows(host), ["0:n"], "재추가분도 제거·당김 정상");
  delButton(host, 0).click();
  assert.deepEqual(rows(host), [], "다시 0개까지");
});
