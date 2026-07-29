// 슬롯 x 제어구조 - 슬롯 콘텐츠는 부모 def에 남고 실행만 자식 자리로 밀리므로, 부모의 @for
// 회차변수/회차 인덱스와 @if 지연 빌드를 가로질러도 "쓴 자리"의 컨텍스트를 지켜야 한다.
// 즉시 실행(회차 pop 전)과 지연 실행(@if lazyBuild) 양쪽을 덮는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("slot_placeholder_control");
});

// @for (tag of tags) { Row() { span.cell {tag} } }  - 회차마다 합성하고 그 슬롯에 회차변수를 보간
// @if (open) { Lazy() { em.late {label} } }         - 비활성이면 lazyBuild로 실행이 더 밀린다
const instantiate = (tags: string[], open: boolean, label: string, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)({ tags, open, label }, handlers as unknown as THandlers);
  const host = mount(inst);
  return { host, setOpen: (v: boolean) => inst.store.set(1, v) };
};

const cells = (host: ParentNode) => [...host.querySelectorAll("div.row > span.cell")].map((s) => s.textContent);

test("@for 회차마다 슬롯 콘텐츠가 자기 회차변수를 보간한다", () => {
  const { host } = instantiate(["a", "b", "c"], false, "L");
  assert.deepEqual(cells(host), ["a", "b", "c"], "회차별 {tag} - 콘텐츠가 자기 회차 슬롯을 읽는다");
});

test("@for 안 슬롯 콘텐츠도 자식 자리에 붙는다", () => {
  const { host } = instantiate(["a", "b"], false, "L");
  assert.equal(host.querySelectorAll("li > div.row").length, 2, "회차마다 Row의 div.row 안");
});

test("@for 안 슬롯 콘텐츠의 이벤트는 회차 인덱스를 붙인다", () => {
  const hits: unknown[] = [];
  // 콘텐츠는 루트에 적혀 있으므로 Row 세그먼트는 안 붙고 @for 익명 세그먼트만 붙는다.
  const { host } = instantiate(["a", "b", "c"], false, "L", {
    "[$0].HIT": (_data, { $0 }) => {
      hits.push($0);
    },
  });
  const spans = [...host.querySelectorAll<HTMLElement>("span.cell")];
  assert.equal(spans.length, 3, "회차마다 슬롯 콘텐츠 하나씩");
  spans[2].click();
  spans[0].click();
  assert.deepEqual(hits, [2, 0], "각 회차가 자기 인덱스로 발화");
});

test("@if 비활성 가지 안 슬롯은 활성화 전엔 안 그려진다", () => {
  const { host } = instantiate(["a"], false, "지연");
  assert.equal(host.querySelector("p.wrap"), null, "가지가 꺼져 있으면 합성 자체가 없다");
});

test("나중에 활성화(lazyBuild)된 가지의 슬롯 콘텐츠도 부모 값을 읽는다", () => {
  const { host, setOpen } = instantiate(["a"], false, "지연");
  setOpen(true);
  const late = host.querySelector("p.wrap > em.late");
  assert.ok(late, "lazyBuild가 합성과 슬롯 채움을 함께 실행");
  assert.equal(late.textContent, "지연", "지연 실행 시점에도 부모 scope로 해석");
});

test("활성 가지로 시작해도 같은 결과", () => {
  const { host } = instantiate(["a"], true, "즉시");
  assert.equal(host.querySelector("p.wrap > em.late")?.textContent, "즉시");
});

// 가장 미뤄지는 경로: @for 몸체 안 @if가 비활성이면 콘텐츠 실행이 그 회차가 끝난 뒤(lazyBuild)로
// 밀린다. 그래도 각 회차는 자기 회차변수/인덱스를 지켜야 한다.
const deferred = (host: ParentNode) => [...host.querySelectorAll("i.deferred")].map((s) => s.textContent);

test("@for 안 비활성 @if의 슬롯 콘텐츠는 나중에 켜도 자기 회차변수를 지킨다", () => {
  const { host, setOpen } = instantiate(["a", "b", "c"], false, "L");
  assert.equal(deferred(host).length, 0, "꺼져 있으면 아직 안 그려진다");
  setOpen(true); // 회차 pop이 이미 끝난 뒤 lazyBuild 실행
  assert.deepEqual(deferred(host), ["a", "b", "c"], "지연돼도 각 회차가 자기 {tag}");
});

test("지연 실행된 슬롯 콘텐츠의 이벤트도 자기 회차 인덱스로 발화한다", () => {
  const hits: unknown[] = [];
  const { host, setOpen } = instantiate(["a", "b", "c"], false, "L", {
    "[$0].HIT": (_data, { $0 }) => {
      hits.push($0);
    },
  });
  setOpen(true);
  const items = [...host.querySelectorAll<HTMLElement>("i.deferred")];
  items[2].click();
  items[0].click();
  assert.deepEqual(hits, [2, 0], "지연돼도 각 회차가 자기 인덱스");
});
