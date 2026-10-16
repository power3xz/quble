// createComponent가 TQubleBytecode를 React 컴포넌트로 그리는지. 같은 바이트코드를 순수 mount로도 그려 견준다.

import "../runtime/test-helpers/dom.ts";

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, type ReactElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mount, type THandlers, type TQubleBytecode } from "../../../core/web/runtime-entry.ts";
import { createComponent } from "./react.ts";
import { bytecodeOf } from "./test-helpers/bytecode.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let greeting: TQubleBytecode;
let counter: TQubleBytecode;
before(async () => {
  greeting = await bytecodeOf(join(FIXTURES, "greeting.qubc"));
  counter = await bytecodeOf(join(FIXTURES, "counter.qubc"));
});

// 컴포넌트 타입이 렌더마다 바뀌면 리마운트되므로 테스트마다 한 번만 만든다.
const makeGreeting = () => createComponent(greeting);
const makeCounter = () => createComponent(counter);

const render = async (element: ReactElement) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root, rerender: (next: ReactElement) => act(async () => root.render(next)) };
};

test("props를 루트 props로 mount해 그린다", async () => {
  const C = makeGreeting();
  const { host } = await render(createElement(C, { name: "Ann" }));
  assert.equal(host.querySelector("p span")?.textContent, "Ann");
});

test("같은 바이트코드를 순수 mount로 그린 것과 화면이 같다", async () => {
  const C = makeGreeting();
  const { host } = await render(createElement(C, { name: "Ann" }));
  const plain = document.createElement("div");
  mount(greeting, plain, { data: { name: "Ann" } });
  assert.equal(host.firstElementChild?.innerHTML, plain.innerHTML);
});

// destroy가 mount가 단 위임 리스너를 떼는지 본다 - document.removeEventListener로 떼는 이벤트 타입을 모은다.
const watchRemovals = () => {
  const removed: string[] = [];
  const original = document.removeEventListener.bind(document);
  document.removeEventListener = ((type: string, ...rest: unknown[]) => {
    removed.push(type);
    return (original as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof document.removeEventListener;
  return {
    removed,
    restore: () => {
      document.removeEventListener = original;
    },
  };
};

test("StrictMode의 이펙트 이중 실행 뒤에도 인스턴스는 하나고 앞의 인스턴스는 destroy됐다", async () => {
  const C = makeCounter();
  const watch = watchRemovals();
  try {
    const { host } = await render(createElement(StrictMode, null, createElement(C, { label: "Go", count: 1 })));
    assert.equal(host.querySelectorAll("p").length, 1);
  } finally {
    watch.restore();
  }
  assert.ok(watch.removed.includes("click"), "이중 실행의 정리 단계가 앞 인스턴스의 위임 리스너를 뗀다");
});

test("언마운트하면 인스턴스를 destroy한다", async () => {
  const C = makeCounter();
  const { root } = await render(createElement(C, { label: "Go", count: 1 }));
  const watch = watchRemovals();
  try {
    await act(async () => root.unmount());
  } finally {
    watch.restore();
  }
  assert.ok(watch.removed.includes("click"), "mount가 단 위임 리스너를 destroy가 뗀다");
});

test("props 내용이 바뀌면 다시 mount하지 않고 update로 갱신한다", async () => {
  const C = makeGreeting();
  const { host, rerender } = await render(createElement(C, { name: "Ann" }));
  const before = host.querySelector("p span") as Element;
  await rerender(createElement(C, { name: "Bob" }));
  assert.equal(host.querySelector("p span"), before, "DOM 노드가 그대로다");
  assert.equal(before.textContent, "Bob");
});

test("바뀐 prop만 갱신하고 나머지는 그대로 둔다", async () => {
  const C = makeCounter();
  const { host, rerender } = await render(createElement(C, { label: "Go", count: 1 }));
  const labelText = host.querySelector("button")?.firstChild;
  await rerender(createElement(C, { label: "Go", count: 2 }));
  assert.equal(host.querySelector("p")?.textContent, "2");
  assert.equal(host.querySelector("button")?.firstChild, labelText, "안 바뀐 label의 텍스트 노드는 그대로다");
});

test("update한 뒤에도 언마운트하면 destroy한다", async () => {
  const C = makeCounter();
  const { root, rerender } = await render(createElement(C, { label: "Go", count: 1 }));
  await rerender(createElement(C, { label: "Go", count: 2 }));
  const watch = watchRemovals();
  try {
    await act(async () => root.unmount());
  } finally {
    watch.restore();
  }
  assert.ok(watch.removed.includes("click"));
});

test("내용이 같은 새 props 객체로는 다시 mount하지 않는다", async () => {
  const C = makeGreeting();
  const { host, rerender } = await render(createElement(C, { name: "Ann" }));
  const before = host.querySelector("p span");
  await rerender(createElement(C, { name: "Ann" }));
  assert.equal(host.querySelector("p span"), before);
});

test("handlers prop의 핸들러가 이벤트를 받는다", async () => {
  const C = makeCounter();
  const calls: unknown[] = [];
  const handlers: THandlers = { CLICK: (data) => calls.push(data) };
  const { host } = await render(createElement(C, { label: "Go", count: 1, handlers }));
  (host.querySelector("button") as HTMLButtonElement).click();
  assert.deepEqual(calls, [{ label: "Go" }]);
});

test("handlers 객체만 바뀌면 다시 mount하지 않는다", async () => {
  const C = makeCounter();
  const { host, rerender } = await render(createElement(C, { label: "Go", count: 1, handlers: { CLICK: () => {} } }));
  const before = host.querySelector("button");
  await rerender(createElement(C, { label: "Go", count: 1, handlers: { CLICK: () => {} } }));
  assert.equal(host.querySelector("button"), before);
});
