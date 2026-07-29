// 객체 요소 배열에 push - 요소가 {label,value}(elemSize=2)라 push가 고정부 두 칸을 store에 심고, @for 몸체가
// 두 필드를 요소 base+offset로 읽는다. 스칼라(elemSize=1) 외에 객체 요소도 plantFixed 재사용으로 심어짐을 확인.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

const { compile } = await import("./runtime.ts");
type THandlers = import("./runtime.ts").THandlers;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_array_push_obj");
});

const stats = (host: ParentNode) => [...host.querySelectorAll(".stat")].map((s) => s.textContent);

const instantiate = (values: unknown, handlers: THandlers = {}) => {
  const inst = compile(qubb)(0)(values, handlers);
  const host = mount(inst);
  const button = host.querySelector(".add") as HTMLButtonElement;
  return { host, button };
};

const pushHandler = (queue: Array<{ label: string; value: string }>) => ({
  ADD: (_data: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
    const props = ctx.props as Record<string, number>;
    const next = queue.shift();
    if (next !== undefined) {
      push(props.stats, next);
    }
  },
});

test("초기 렌더: 객체 요소의 필드를 읽어 표시", () => {
  const { host } = instantiate({ stats: [{ label: "HP", value: "100" }] });
  assert.deepEqual(stats(host), ["HP: 100"], "초기 HP");
});

test("push: 추가한 객체 요소가 필드까지 렌더된다", () => {
  const { host, button } = instantiate(
    { stats: [{ label: "HP", value: "100" }] },
    pushHandler([
      { label: "MP", value: "50" },
      { label: "ATK", value: "12" },
    ]),
  );
  assert.deepEqual(stats(host), ["HP: 100"], "초기");
  button.click();
  assert.deepEqual(stats(host), ["HP: 100", "MP: 50"], "push MP");
  button.click();
  assert.deepEqual(stats(host), ["HP: 100", "MP: 50", "ATK: 12"], "push ATK");
});
