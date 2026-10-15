// 인스턴스의 snapshot - 루트 props의 지금 값을 mount 때 넘긴 data와 같은 모양으로 다시 짓는다.
// 핸들러가 store를 바꾼 뒤에도 바뀐 값이 그 모양 그대로 나와야 한다(배열 요소 추가/제거 포함).
// snapshot(typeRef, base, offset)은 타입과 위치(store의 base + offset)를 받아 그 자리의 값을 짓는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { decode, type TField } from "./decode.ts";
import { compile, leafCountOf, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

let setObject: Uint8Array;
let pushObj: Uint8Array;
before(() => {
  setObject = buildFixture("set_object");
  pushObj = buildFixture("for_array_push_obj");
});

const user = {
  name: "kim",
  age: 30,
  tags: ["a", "b"],
  posts: [
    { title: "p1", marks: ["x"] },
    { title: "p2", marks: [] },
  ],
  contact: { email: "k@x" },
};

test("처음에는 넘긴 data와 같다 - 중첩 객체와 배열의 배열까지", () => {
  const values = { title: "T", user };
  const inst = compile(setObject)(0)(structuredClone(values));
  assert.deepEqual(inst.snapshot(), values);
});

test("핸들러가 set한 값이 나온다", () => {
  const handlers: THandlers = {
    SWAP: (_data, ctx) => {
      const set = ctx.set as (leaf: number, value: unknown) => void;
      const props = ctx.props as { title: number; user: { age: number } };
      set(props.title, "U");
      set(props.user.age, 31);
    },
  };
  const inst = compile(setObject)(0)({ title: "T", user: structuredClone(user) }, handlers);
  const host = mount(inst);
  (host.querySelector("h1") as HTMLElement).click();
  assert.deepEqual(inst.snapshot(), { title: "U", user: { ...user, age: 31 } });
});

test("push와 removeAt 뒤 배열이 지금 요소로 나온다", () => {
  let step = 0;
  const handlers: THandlers = {
    ADD: (_data, ctx) => {
      const props = ctx.props as { stats: number };
      if (step++ === 0) {
        (ctx.push as (leaf: number, elem: unknown) => void)(props.stats, { label: "MP", value: "50" });
      } else {
        (ctx.removeAt as (leaf: number, i: number) => void)(props.stats, 0);
      }
    },
  };
  const inst = compile(pushObj)(0)({ stats: [{ label: "HP", value: "100" }] }, handlers);
  const host = mount(inst);
  const button = host.querySelector(".add") as HTMLButtonElement;
  button.click();
  assert.deepEqual(inst.snapshot(), {
    stats: [
      { label: "HP", value: "100" },
      { label: "MP", value: "50" },
    ],
  });
  button.click();
  assert.deepEqual(inst.snapshot(), { stats: [{ label: "MP", value: "50" }] });
});

// 루트 props의 필드 타입과, 그 필드가 store에서 시작하는 위치. 필드는 앞 필드의 칸 수만큼 이어서 놓인다.
const rootFields = (bytes: Uint8Array) => {
  const module = decode(bytes);
  const rootTypeRef = module.defs[0].propsTypeRef;
  const fields = (module.types[rootTypeRef] as { fields: TField[] }).fields;
  let base = 0;
  const located = fields.map(([nameConstIndex, typeRef]) => {
    const field = { name: module.constpool[nameConstIndex] as string, typeRef, base };
    base += leafCountOf(module, typeRef);
    return field;
  });
  return { rootTypeRef, located };
};

test("루트 타입을 base 0, offset 0으로 주면 인자 없는 snapshot과 같다", () => {
  const values = { title: "T", user };
  const inst = compile(setObject)(0)(structuredClone(values));
  const { rootTypeRef } = rootFields(setObject);
  assert.deepEqual(inst.snapshot(rootTypeRef, 0, 0), values);
});

test("필드 하나의 타입과 위치를 주면 그 필드의 값만 나온다", () => {
  const values = { title: "T", user };
  const inst = compile(setObject)(0)(structuredClone(values));
  const { located } = rootFields(setObject);
  const field = located.find((f) => f.name === "user");
  assert.ok(field);
  assert.deepEqual(inst.snapshot(field.typeRef, field.base, 0), user);
});

test("위치는 base와 offset의 합이다", () => {
  const values = { title: "T", user };
  const inst = compile(setObject)(0)(structuredClone(values));
  const { located } = rootFields(setObject);
  const field = located.find((f) => f.name === "user");
  assert.ok(field);
  assert.deepEqual(inst.snapshot(field.typeRef, 0, field.base), user);
});

test("핸들러가 set한 뒤 필드만 읽어도 바뀐 값이 나온다", () => {
  const handlers: THandlers = {
    SWAP: (_data, ctx) => {
      const props = ctx.props as { user: { age: number } };
      (ctx.set as (leaf: number, value: unknown) => void)(props.user.age, 31);
    },
  };
  const inst = compile(setObject)(0)({ title: "T", user: structuredClone(user) }, handlers);
  const host = mount(inst);
  (host.querySelector("h1") as HTMLElement).click();
  const { located } = rootFields(setObject);
  const field = located.find((f) => f.name === "user");
  assert.ok(field);
  assert.deepEqual(inst.snapshot(field.typeRef, field.base, 0), { ...user, age: 31 });
});
