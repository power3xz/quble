// destroy의 메모리 반환 - 호출자가 인스턴스를 계속 들고 있어도 destroy가 떼어낸 노드와 region/branch 객체를
// 놓아 GC가 거둘 수 있어야 한다. 같은 인스턴스에서 destroy 전후로 gc를 돌려 WeakRef로 가리킨 객체가 몇 개
// 살아 있는지 견준다. 인스턴스는 끝까지 강한 참조로 쥔다. WeakRef의 대상은 만든 턴이 끝날 때까지 살아
// 있으므로 gc 전에 한 턴 쉰다.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { compile } from "./runtime.ts";
import { buildFixture } from "./test-helpers/build.ts";
import { mount } from "./test-helpers/dom.ts";

// --expose-gc 없이 gc()를 얻는다.
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

let qubb: Uint8Array;
before(() => {
  qubb = buildFixture("for_if_count");
});

// 한 턴 쉬어 WeakRef 대상의 임시 보호를 풀고 gc를 돌린다. 한 번으로는 덜 거둬질 수 있어 두 번 돈다.
const collect = async () => {
  await setImmediate();
  gc();
  await setImmediate();
  gc();
};

// 자손 노드를 childNodes로 직접 순회해 모은다. querySelectorAll은 jsdom의 선택자 엔진이 결과를 캐시해 떼어진
// 노드를 붙들므로 쓰지 않는다.
const descendants = (root: Node): Node[] => {
  const nodes: Node[] = [];
  for (const child of root.childNodes) {
    nodes.push(child, ...descendants(child));
  }
  return nodes;
};

// 인스턴스를 만들고, 그 DOM 노드와 region/branch 객체를 약한 참조로 모아 돌려준다. 노드 목록은 이 함수 안에서만
// 쥐므로 반환 뒤에는 DOM과 인스턴스만 그 객체들을 붙든다.
const build = () => {
  const inst = compile(qubb)(0)({ n: 3, flag: true });
  const host = mount(inst);
  const targets: object[] = [
    ...descendants(host),
    ...inst.nodes,
    ...inst.regionPool.entries,
    ...inst.branchPool.entries,
  ];
  const refs = targets.map((target) => new WeakRef(target));
  return { inst, host, refs };
};

const aliveCount = (refs: WeakRef<object>[]) => refs.filter((ref) => ref.deref() !== undefined).length;

test("destroy 전에는 노드와 region/branch가 살아 있고, 후에는 인스턴스를 들고 있어도 거둬진다", async () => {
  const { inst, host, refs } = build();

  await collect();
  const before = aliveCount(refs);
  assert.equal(before, refs.length, "destroy 전에는 모두 살아 있다");

  inst.destroy();
  host.remove();
  await collect();
  const after = aliveCount(refs);
  assert.equal(after, 0, `destroy 후 ${before}개 중 ${after}개가 남았다`);
  assert.equal(inst.nodes.length, 0);
});

// 힙 전체로 견준다 - WeakRef로 지정한 객체 밖의 것(리스너, 클로저, 캐시)이 새는 것도 잡는다. 인스턴스를 많이
// 만들었다 버리고 gc한 뒤, 시작 전 힙과의 차이를 인스턴스당 바이트로 본다. 이벤트가 있는 컴포넌트는 안 해체하면
// document 위임 리스너가 VM을 붙들어 인스턴스마다 쌓이므로, 해체하지 않은 쪽을 대조로 두고 해체한 쪽이 그보다
// 훨씬 작은지 본다. 절대값은 실행 환경에 따라 달라 기준으로 삼지 않는다.
const COUNT = 1000;

const heapUsed = async () => {
  for (let i = 0; i < 4; i++) {
    await setImmediate();
    gc();
  }
  return process.memoryUsage().heapUsed;
};

// 인스턴스를 COUNT개 만들고 버린 뒤 힙이 인스턴스당 몇 바이트 늘었는지 돌려준다. 앞의 20개는 예열이다.
const retainedPerInstance = async (shouldDestroy: boolean) => {
  const blueprint = compile(buildFixture("event_toggle"))(0);
  const once = () => {
    const inst = blueprint({ label: "t", on: "on" });
    mount(inst);
    if (shouldDestroy) {
      inst.destroy();
    }
  };
  for (let i = 0; i < 20; i++) {
    once();
  }
  document.body.replaceChildren();
  const before = await heapUsed();
  for (let i = 0; i < COUNT; i++) {
    once();
  }
  document.body.replaceChildren();
  return ((await heapUsed()) - before) / COUNT;
};

test("인스턴스를 버린 뒤 힙은 destroy한 쪽이 안 한 쪽보다 훨씬 적게 남는다", async () => {
  const kept = await retainedPerInstance(false);
  const destroyed = await retainedPerInstance(true);
  assert.ok(kept > 10_000, `대조(destroy 안 함)가 누수를 보여야 한다: ${Math.round(kept)}B/인스턴스`);
  assert.ok(
    destroyed < kept / 5,
    `destroy한 쪽 ${Math.round(destroyed)}B/인스턴스, 안 한 쪽 ${Math.round(kept)}B/인스턴스`,
  );
});

// 인스턴스를 해체한 뒤에도 호출자가 쥐고 있으면 destroy 클로저가 VM을 붙들어 VM의 필드(화살표 함수 수십
// 개)가 인스턴스마다 남는다. 해체한 인스턴스는 쥐고 있어도 VM을 놓아야 한다.
const heldAfterDestroyPerInstance = async () => {
  const blueprint = compile(buildFixture("event_toggle"))(0);
  const make = () => {
    const inst = blueprint({ label: "t", on: "on" });
    mount(inst);
    inst.destroy();
    return inst;
  };
  for (let i = 0; i < 20; i++) {
    make();
  }
  document.body.replaceChildren();
  const before = await heapUsed();
  const held = [];
  for (let i = 0; i < COUNT; i++) {
    held.push(make());
  }
  document.body.replaceChildren();
  const perInstance = ((await heapUsed()) - before) / COUNT;
  assert.equal(held.length, COUNT);
  return perInstance;
};

test("destroy한 인스턴스를 쥐고 있어도 VM을 붙들지 않는다", async () => {
  const perInstance = await heldAfterDestroyPerInstance();
  assert.ok(perInstance < 5_000, `쥐고 있는 해체된 인스턴스가 ${Math.round(perInstance)}B/인스턴스 남긴다`);
});
