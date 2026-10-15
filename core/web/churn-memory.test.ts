// 실행 중 갱신의 메모리 반환 - destroy 없이 오래 도는 인스턴스가 @for 요소를 추가/제거하고 @if를 토글해도
// 힙이 계속 늘지 않아야 한다. 같은 일을 많이 반복한 뒤 사이클당 힙 증가가 작은지 본다. 앞의 일부는 예열(JIT,
// 인라인 캐시)이라 재지 않는다. 한 사이클에 객체 하나(클로저 약 수십 바이트)라도 새면 사이클 수만큼 쌓여 기준을
// 넘는다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { compile, type THandlers } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

// --expose-gc 없이 gc()를 얻는다.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

const qubb: Record<string, Uint8Array> = {};
before(() => {
  for (const name of ["for_array_edit", "single_if", "for_with_context"]) {
    qubb[name] = buildFixture(name);
  }
});

const WARMUP_CYCLES = 2500;
const MEASURED_CYCLES = 50_000;
// 예열을 마친 뒤의 사이클당 허용 증가 바이트. 실측은 @for 5, @if 1 정도이고, 한 사이클에 작은 객체 하나만 새도
// 이보다 크다.
const MAX_BYTES_PER_CYCLE = 50;

// 한 턴 쉬고 gc를 돌린 뒤 힙 사용량을 읽는다. 한 번으로는 덜 거둬질 수 있어 네 번 돈다.
const heapUsed = async () => {
  for (let i = 0; i < 4; i++) {
    await setImmediate();
    gc();
  }
  return process.memoryUsage().heapUsed;
};

const bytesPerCycle = async (cycle: () => void) => {
  for (let i = 0; i < WARMUP_CYCLES; i++) {
    cycle();
  }
  const before = await heapUsed();
  for (let i = 0; i < MEASURED_CYCLES; i++) {
    cycle();
  }
  return ((await heapUsed()) - before) / MEASURED_CYCLES;
};

// ADD가 "x"를 push하고 DEL이 맨 앞 요소를 removeAt한다.
const handlers: THandlers = {
  ADD: (_data, ctx) => {
    const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
    push((ctx.props as Record<string, number>).tags, "x");
  },
  DEL: (_data, ctx) => {
    const removeAt = ctx.removeAt as (arrayLeafIndex: number, index: number) => void;
    removeAt((ctx.props as Record<string, number>).tags, 0);
  },
};

test("@for 요소를 추가하고 제거하기를 반복해도 힙이 늘지 않는다", async () => {
  const inst = compile(qubb.for_array_edit)(0)({ tags: ["a", "b"] }, handlers);
  const host = mount(inst);
  const add = host.querySelector(".add") as HTMLButtonElement;
  const del = host.querySelector(".del") as HTMLButtonElement;
  const perCycle = await bytesPerCycle(() => {
    add.click();
    del.click();
  });
  assert.ok(perCycle < MAX_BYTES_PER_CYCLE, `사이클당 ${perCycle.toFixed(1)}B 늘었다`);
});

test("@if를 토글하기를 반복해도 힙이 늘지 않는다", async () => {
  const inst = compile(qubb.single_if)(0)({ cond: true, a: "A", b: "B" });
  mount(inst);
  let on = true;
  const perCycle = await bytesPerCycle(() => {
    on = !on;
    inst.store.set(0, on);
  });
  assert.ok(perCycle < MAX_BYTES_PER_CYCLE, `사이클당 ${perCycle.toFixed(1)}B 늘었다`);
});

// ADD가 "x"를 items에 push하고 DEL이 맨 앞 요소를 removeAt한다. 회차마다 자식 컴포넌트가 @with를 연다.
const itemsHandlers: THandlers = {
  ADD: (_data, ctx) => {
    const push = ctx.push as (arrayLeafIndex: number, elem: unknown) => void;
    push((ctx.props as Record<string, number>).items, "x");
  },
  DEL: (_data, ctx) => {
    const removeAt = ctx.removeAt as (arrayLeafIndex: number, index: number) => void;
    removeAt((ctx.props as Record<string, number>).items, 0);
  },
};

test("@for 회차 안의 @with 컨텍스트도 회차를 추가하고 제거하기를 반복해도 힙이 늘지 않는다", async () => {
  const inst = compile(qubb.for_with_context)(0)({ items: ["a", "b"] }, itemsHandlers);
  const host = mount(inst);
  const add = host.querySelector(".add") as HTMLButtonElement;
  const del = host.querySelector(".del") as HTMLButtonElement;
  const perCycle = await bytesPerCycle(() => {
    add.click();
    del.click();
  });
  assert.ok(perCycle < MAX_BYTES_PER_CYCLE, `사이클당 ${perCycle.toFixed(1)}B 늘었다`);
});

test("removeAt으로 제거한 회차의 DOM과 branch는 거둬진다", async () => {
  const inst = compile(qubb.for_array_edit)(0)({ tags: ["a", "b", "c"] }, handlers);
  const host = mount(inst);
  const del = host.querySelector(".del") as HTMLButtonElement;
  const list = host.querySelector("ul") as HTMLElement;

  // 지울 회차(맨 앞 li)의 노드와 지금 쓰는 모든 branch 객체를 약한 참조로 둔다. 노드 목록은 이 안에서만 쥔다.
  const watch = () => {
    const li = Array.from(list.childNodes).find((node) => node.nodeName === "LI") as Node;
    return {
      li: new WeakRef(li),
      branches: inst.branchPool.entries.map((branch) => new WeakRef(branch)),
    };
  };
  const { li, branches } = watch();
  const aliveBefore = branches.filter((ref) => ref.deref() !== undefined).length;

  del.click();
  await setImmediate();
  gc();
  await setImmediate();
  gc();

  assert.equal(li.deref(), undefined, "제거한 회차의 li가 거둬진다");
  const aliveAfter = branches.filter((ref) => ref.deref() !== undefined).length;
  assert.ok(aliveAfter < aliveBefore, `branch ${aliveBefore}개 중 ${aliveAfter}개가 남았다`);
});
