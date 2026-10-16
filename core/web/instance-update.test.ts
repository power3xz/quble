// 인스턴스 update - 루트 props를 이름으로 갱신한다. 스칼라는 값을 기록하고, 배열은 통째로 교체하며,
// 객체는 mode에 따라 교체(안 준 필드는 undefined)하거나 병합(준 필드만)한다. 기본값은 병합이다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("update_props");
});

const DATA = { title: "T", user: { name: "kim", age: 30 }, tags: ["a", "b"] };

const instantiate = () => {
  const inst = compile(qubb)(0)(structuredClone(DATA), {});
  return { inst, host: mount(inst) };
};

const text = (host: ParentNode, selector: string) => host.querySelector(selector)?.textContent;
const tags = (host: ParentNode) => [...host.querySelectorAll(".tag")].map((n) => n.textContent);

test("스칼라 prop을 이름으로 갱신한다", () => {
  const { inst, host } = instantiate();
  inst.update({ title: "N" });
  assert.equal(text(host, ".title"), "N");
  assert.equal(text(host, ".name"), "kim", "준 키만 바뀐다");
});

test("기본값은 병합이라 객체의 안 준 필드는 그대로다", () => {
  const { inst, host } = instantiate();
  inst.update({ user: { name: "lee" } });
  assert.equal(text(host, ".name"), "lee");
  assert.equal(text(host, ".age"), "30");
});

test("merge를 명시해도 같다", () => {
  const { inst, host } = instantiate();
  inst.update({ user: { age: 31 } }, "merge");
  assert.equal(text(host, ".name"), "kim");
  assert.equal(text(host, ".age"), "31");
});

test("replace는 객체의 안 준 필드를 undefined로 만든다", () => {
  const { inst, host } = instantiate();
  inst.update({ user: { name: "lee" } }, "replace");
  assert.equal(text(host, ".name"), "lee");
  assert.equal(text(host, ".age"), "", "안 준 age는 비어 보인다");
  assert.equal((inst.snapshot().user as { age: unknown }).age, undefined);
});

test("replace여도 준 키가 아닌 루트 prop은 건드리지 않는다", () => {
  const { inst, host } = instantiate();
  inst.update({ user: { name: "lee", age: 1 } }, "replace");
  assert.equal(text(host, ".title"), "T");
  assert.deepEqual(tags(host), ["a", "b"]);
});

test("배열은 mode와 상관없이 통째로 교체된다 - 늘리기", () => {
  for (const mode of ["merge", "replace"] as const) {
    const { inst, host } = instantiate();
    inst.update({ tags: ["x", "y", "z"] }, mode);
    assert.deepEqual(tags(host), ["x", "y", "z"], mode);
  }
});

test("배열은 줄이거나 비울 수 있다", () => {
  const { inst, host } = instantiate();
  inst.update({ tags: ["x"] });
  assert.deepEqual(tags(host), ["x"]);
  inst.update({ tags: [] });
  assert.deepEqual(tags(host), []);
});

test("한 번의 update로 여러 prop을 함께 갱신한다", () => {
  const { inst, host } = instantiate();
  inst.update({ title: "N", user: { name: "lee" }, tags: ["x"] });
  assert.equal(text(host, ".title"), "N");
  assert.equal(text(host, ".name"), "lee");
  assert.deepEqual(tags(host), ["x"]);
});

test("update 뒤 snapshot이 갱신된 값을 돌려준다", () => {
  const { inst } = instantiate();
  inst.update({ title: "N", tags: ["x"] });
  assert.deepEqual(inst.snapshot(), { title: "N", user: { name: "kim", age: 30 }, tags: ["x"] });
});

test("루트 props에 없는 이름은 이름을 담은 예외를 throw한다", () => {
  const { inst } = instantiate();
  assert.throws(() => inst.update({ typo: 1 }), /typo/);
});

// 핸들러 컨텍스트의 update - 인스턴스의 update와 같은 동작이다.
type TUpdate = (values: Record<string, unknown>, mode?: "replace" | "merge") => void;
const instantiateWith = (run: (update: TUpdate) => void) => {
  const handlers = { GO: (_data: unknown, ctx: { update: TUpdate }) => run(ctx.update) } as unknown as THandlers;
  const inst = compile(qubb)(0)(structuredClone(DATA), handlers);
  const host = mount(inst);
  return { inst, host, click: () => (host.querySelector(".go") as HTMLButtonElement).click() };
};

test("핸들러 컨텍스트의 update가 스칼라, 객체, 배열을 함께 갱신한다", () => {
  const { host, click } = instantiateWith((update) =>
    update({ title: "N", user: { name: "lee" }, tags: ["x", "y", "z"] }),
  );
  click();
  assert.equal(text(host, ".title"), "N");
  assert.equal(text(host, ".name"), "lee");
  assert.equal(text(host, ".age"), "30", "기본값은 병합");
  assert.deepEqual(tags(host), ["x", "y", "z"]);
});

test("핸들러 컨텍스트의 update에 replace를 주면 안 준 필드가 비워진다", () => {
  const { host, click } = instantiateWith((update) => update({ user: { name: "lee" } }, "replace"));
  click();
  assert.equal(text(host, ".age"), "");
});

test("핸들러 컨텍스트의 update가 없는 이름이면 이름을 담은 예외를 throw한다", () => {
  let thrown: unknown;
  const { click } = instantiateWith((update) => {
    try {
      update({ typo: 1 });
    } catch (error) {
      thrown = error;
    }
  });
  click();
  assert.match(String(thrown), /typo/);
});

test("destroy 뒤 update는 아무 일도 하지 않고 VM을 붙들지 않는다", () => {
  const { inst } = instantiate();
  const before = inst.update;
  inst.destroy();
  assert.notEqual(inst.update, before, "destroy가 VM을 잡은 update를 놓는다");
  assert.doesNotThrow(() => inst.update({ title: "N" }));
});
