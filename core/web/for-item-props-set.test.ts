// @for 회차 요소를 자식으로 넘겼을 때 자식 핸들러의 `props`가 "그 회차 요소"의 leafIndex를
// 주는지 검증한다. for-item-value-update.test.ts는 leafIndex를 손계산해 store.set으로 넣어
// 반응성만 봤고, 핸들러가 props로 그 주소를 얻는 경로는 빈 케이스였다.
//
// 이게 성립하면 "배열 요소를 편집하려면 상태를 배열 밖으로 빼야 한다"가 아니라, @for +
// 자식 컴포넌트가 정상 경로가 된다(루트 store에서 인덱스로 내려가는 것만 여전히 안 됨).

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_item_props_set");
});

const cards = (host: HTMLElement) =>
  [...host.querySelectorAll(".card")].map((c) => ({
    label: c.querySelector(".label")?.textContent,
    value: c.querySelector(".value")?.textContent,
  }));

const seed = () => ({
  // detail 앞 tag는 요소 안 offset을 0이 아니게 한다(offset 회귀 방지).
  items: [
    { tag: "x", detail: { label: "A", value: "1" } },
    { tag: "y", detail: { label: "B", value: "2" } },
    { tag: "z", detail: { label: "C", value: "3" } },
  ],
});

type TCtx = {
  props: { info: { value: number } };
  set: (leafIndex: number, v: unknown) => void;
  $0: number;
};

// 자식이 자기 prop을 set한다 - 어느 회차에서 눌렸는지는 props가 준 주소로만 결정된다.
// 값에 $0를 실어 "누른 회차가 자기 자리에 썼는지"가 결과로 드러나게 한다.
const handlers = {
  "Card[$0].BUMP": (_data: unknown, { props, set, $0 }: TCtx) => {
    set(props.info.value, `v${$0}`);
  },
};

test("자식 핸들러의 props가 자기 회차 요소를 가리킨다(set이 그 회차만 바꾼다)", () => {
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);

  // 가운데 카드를 누르면 그 회차의 value만 바뀌어야 한다.
  host.querySelectorAll<HTMLElement>(".card")[1].click();
  assert.deepEqual(cards(host), [
    { label: "A", value: "1" },
    { label: "B", value: "v1" },
    { label: "C", value: "3" },
  ]);
});

test("회차마다 자기 요소에 쓴다(교차 오염 없음)", () => {
  const inst = compile(qubb)(0)(seed(), handlers);
  const host = mount(inst);

  const els = host.querySelectorAll<HTMLElement>(".card");
  els[0].click();
  els[2].click();
  // 누른 두 회차만, 각자 자기 인덱스 값으로 바뀐다. label은 아무도 안 건드린다.
  assert.deepEqual(cards(host), [
    { label: "A", value: "v0" },
    { label: "B", value: "2" },
    { label: "C", value: "v2" },
  ]);
});
