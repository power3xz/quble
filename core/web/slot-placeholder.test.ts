// 슬롯 통합 - 사용쪽이 넘긴 콘텐츠가 자식의 `@slot` 자리에 실제로 그려지는지.
// 세 축이 갈리는 게 핵심(BYTECODE.md 슬롯 메모): 해석 컨텍스트/수명은 콘텐츠를 쓴 부모,
// DOM 부착 위치만 자식. 그래서 콘텐츠 안 보간은 부모 prop을 읽고, 부모 store 갱신에 반응해야 한다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

import type { TTestHandlers } from "./test-helpers/handlers.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("slot_placeholder");
});

// Panel: div.head > @slot(Header), div.body > @slot(Body), p.own > {heading}
// Plain: article > div.inner > @slot()
// 사용쪽은 Header만 채우고(Body는 미채움) Plain엔 무기명 블록을 준다.
const instantiate = (title: string, note: string, handlers: TTestHandlers = {}) => {
  const inst = compile(qubb)(0)({ title, note }, handlers as unknown as THandlers);
  const host = mount(inst);
  return {
    host,
    setTitle: (v: string) => inst.store.set(0, v),
    setNote: (v: string) => inst.store.set(1, v),
  };
};

test("기명 슬롯 콘텐츠가 자식의 그 자리에 그려진다", () => {
  const { host } = instantiate("제목", "메모");
  const filled = host.querySelector("div.head > h1.filled");
  assert.ok(filled, "콘텐츠는 div.head 안에 붙는다 - 부착 위치는 자식 자리");
  assert.equal(filled.textContent, "제목");
});

test("무기명 슬롯도 같은 자리 규칙을 따른다", () => {
  const { host } = instantiate("제목", "메모");
  const anon = host.querySelector("article > div.inner > span.anon");
  assert.ok(anon, "무기명 콘텐츠는 Plain의 div.inner 안");
  assert.equal(anon.textContent, "메모");
});

test("안 채운 슬롯은 아무것도 안 넣는다", () => {
  const { host } = instantiate("제목", "메모");
  const body = host.querySelector("div.body");
  assert.ok(body, "자리를 잡은 요소 자체는 남는다");
  assert.equal(body.childNodes.length, 0, "Body는 미채움이라 비어 있다");
});

test("슬롯 콘텐츠는 부모 scope로 해석된다", () => {
  const { host } = instantiate("제목", "메모");
  // {title}은 부모(SlotPlaceholder)의 prop이지 Panel의 것이 아니다. Panel의 자기 prop은 따로 그려진다.
  assert.equal(host.querySelector("h1.filled")?.textContent, "제목");
  assert.equal(host.querySelector("p.own")?.textContent, "panel", "자식 자기 prop은 자식 값");
});

test("부모 store 갱신이 슬롯 콘텐츠에 반영된다", () => {
  const { host, setTitle } = instantiate("제목", "메모");
  setTitle("바뀐제목");
  assert.equal(
    host.querySelector("h1.filled")?.textContent,
    "바뀐제목",
    "구독이 부모 가지에 쌓여 부모 갱신을 받는다",
  );
});

test("무기명 슬롯 콘텐츠도 부모 갱신에 반응한다", () => {
  const { host, setNote } = instantiate("제목", "메모");
  setNote("바뀐메모");
  assert.equal(host.querySelector("span.anon")?.textContent, "바뀐메모");
});

// path 축은 콘텐츠를 "쓴 곳" 기준이다 - h1은 Panel 안에 그려지지만 소스에선 루트에 적혀 있으므로
// fullname에 Panel 세그먼트가 붙으면 안 된다. 세 축 분리(해석 컨텍스트 = 부모)의 진짜 시험.
test("슬롯 콘텐츠의 이벤트는 쓴 곳(부모) 경로로 발화한다", () => {
  let picked: unknown = null;
  const { host } = instantiate("제목", "메모", {
    PICK: (payload: unknown) => {
      picked = payload;
    },
  });
  host.querySelector<HTMLElement>("h1.filled")!.click();
  assert.deepEqual(picked, { title: "제목" }, "payload도 부모 prop을 읽는다");
});

test("슬롯 콘텐츠 이벤트에 자식 세그먼트가 붙지 않는다", () => {
  let wrong = 0;
  const { host } = instantiate("제목", "메모", {
    "Panel.PICK": () => {
      wrong += 1;
    },
  });
  host.querySelector<HTMLElement>("h1.filled")!.click();
  assert.equal(wrong, 0, "그려진 위치(Panel)가 아니라 쓴 위치(루트)가 경로를 정한다");
});

test("자식 자기 요소의 이벤트는 자식 세그먼트를 그대로 붙인다", () => {
  let own: unknown = null;
  const { host } = instantiate("제목", "메모", {
    "Panel.OWN": (payload: unknown) => {
      own = payload;
    },
  });
  host.querySelector<HTMLElement>("p.own")!.click();
  assert.deepEqual(own, { heading: "panel" }, "슬롯과 무관한 자식 요소는 평소대로 Panel.OWN");
});
