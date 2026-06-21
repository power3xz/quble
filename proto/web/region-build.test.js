// 스킵 없는 실험: IF를 만나면 then·else 양쪽을 다 build(노드·구조만, 구독은 안 검)하고,
// IF_END에서 cond를 구독해 활성 가지만 activateBranch로 켠다. cond가 바뀌면 swap.
// 목적은 "한 루프 + region 스택 + var 소속 + cond swap"의 뼈대 확인. lazy/skip은 다음 단계.
//
// build와 켜기를 분리: build는 노드/leafIndices/updateFns/childRegionIndices만 채운다(구독 X).
// 켜기는 activateBranch로 일원화 — 초기 활성화도, 이후 swap도 같은 함수.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEN_INDEX,
  ELSE_INDEX,
  createRegion,
  createBranch,
  activateBranch,
} from "./region.js";

const OP = {
  TEXT_VAR: 0x08,
  IF: 0x0c,
  ELSE: 0x0d,
  IF_END: 0x0e,
};

// ── 가짜 store ───────────────────────────────────────────────────────
const fakeCtx = (initial) => {
  const leaves = [...initial];
  const subscribers = new Map();
  return {
    leaves,
    subscribe: (leafIndex, fn) => {
      let set = subscribers.get(leafIndex);
      if (set === undefined) {
        set = new Set();
        subscribers.set(leafIndex, set);
      }
      set.add(fn);
    },
    unsubscribe: (leafIndex, fn) => subscribers.get(leafIndex)?.delete(fn),
    set: (leafIndex, value) => {
      leaves[leafIndex] = value;
      const set = subscribers.get(leafIndex);
      if (set !== undefined) {
        for (const fn of [...set]) {
          fn(value);
        }
      }
    },
    subCount: (leafIndex) => subscribers.get(leafIndex)?.size ?? 0,
  };
};

// ── 가짜 노드 ────────────────────────────────────────────────────────
const fakeNode = () => {
  const node = { attached: true };
  node.remove = () => {
    node.attached = false;
  };
  return node;
};
const fakeAnchor = () => ({
  after: (...nodes) => {
    for (const node of nodes) {
      node.attached = true;
    }
  },
});

// ── 인스턴스화: 한 루프 + region 스택. build는 구독 안 검, IF_END에서 activateBranch ──
const instantiate = (code, ctx) => {
  const regions = [createRegion(-1, null)]; // 0번 = 루트 Region(껍데기)
  regions[0].branches[THEN_INDEX] = createBranch();
  const regionStack = [0];
  let currentBranchIndex = THEN_INDEX;
  const branchStack = [];

  const currentRegion = () => regions[regionStack[regionStack.length - 1]];
  const currentBranch = () => currentRegion().branches[currentBranchIndex];

  let pc = 0;
  const u16 = () => {
    const value = code[pc] | (code[pc + 1] << 8);
    pc += 2;
    return value;
  };

  while (pc < code.length) {
    const op = code[pc++];
    switch (op) {
      case OP.TEXT_VAR: {
        const leafIndex = u16(); // 실험에선 offset=leafIndex로 단순화
        const branch = currentBranch();
        const node = fakeNode();
        const updateFn = (value) => {
          node.lastSeenValue = value; // 실제론 textContent
        };
        branch.nodes.push(node);
        branch.leafIndices.push(leafIndex);
        branch.updateFns.push(updateFn);
        break; // 구독은 안 건다 — activateBranch가 켤 때 건다.
      }
      case OP.IF: {
        const condLeafIndex = u16();
        const region = createRegion(condLeafIndex, fakeAnchor());
        const regionIndex = regions.length;
        regions.push(region);
        currentBranch().childRegionIndices.push(regionIndex);
        region.branches[THEN_INDEX] = createBranch();
        region.branches[ELSE_INDEX] = createBranch();
        regionStack.push(regionIndex);
        branchStack.push(currentBranchIndex);
        currentBranchIndex = THEN_INDEX;
        break;
      }
      case OP.ELSE: {
        currentBranchIndex = ELSE_INDEX;
        break;
      }
      case OP.IF_END: {
        const region = currentRegion();
        const regionIndex = regionStack[regionStack.length - 1];
        // cond 변경 시 해당 가지를 활성화(swap).
        ctx.subscribe(region.condLeafIndex, (condValue) => {
          activateBranch(ctx, regions, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
        });
        // 초기 활성 가지 켜기.
        const initialBranch = ctx.leaves[region.condLeafIndex] ? THEN_INDEX : ELSE_INDEX;
        activateBranch(ctx, regions, regionIndex, initialBranch);
        regionStack.pop();
        currentBranchIndex = branchStack.pop();
        break;
      }
      default: {
        throw new Error("bad op 0x" + op.toString(16));
      }
    }
  }
  return regions;
};

// ── 테스트 ───────────────────────────────────────────────────────────
// 코드: VAR0  IF(cond=2){ VAR1 } ELSE { VAR3 } IF_END
const code = new Uint8Array([
  OP.TEXT_VAR, 0, 0,
  OP.IF, 2, 0,
  OP.TEXT_VAR, 1, 0,
  OP.ELSE,
  OP.TEXT_VAR, 3, 0,
  OP.IF_END,
]);

const childOf = (regions) => regions[regions[0].branches[THEN_INDEX].childRegionIndices[0]];

test("var가 자기 가지에 소속된다", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  assert.deepEqual(regions[0].branches[THEN_INDEX].leafIndices, [0], "VAR0은 루트 가지");
  const child = childOf(regions);
  assert.deepEqual(child.branches[THEN_INDEX].leafIndices, [1], "VAR1은 then 가지");
  assert.deepEqual(child.branches[ELSE_INDEX].leafIndices, [3], "VAR3은 else 가지");
});

test("cond=true 초기: then 활성, else 가지 구독 0", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  assert.equal(childOf(regions).shownIndex, THEN_INDEX, "then 활성");
  assert.equal(ctx.subCount(1), 1, "then 가지(leaf1) 구독");
  assert.equal(ctx.subCount(3), 0, "else 가지(leaf3) 구독 0");
});

test("cond=false 초기: else 활성, then 가지 구독 0", () => {
  const ctx = fakeCtx(["a", "b", false, "d"]);
  const regions = instantiate(code, ctx);
  assert.equal(childOf(regions).shownIndex, ELSE_INDEX, "else 활성");
  assert.equal(ctx.subCount(1), 0, "then 가지 구독 0");
  assert.equal(ctx.subCount(3), 1, "else 가지 구독");
});

test("cond 변경으로 swap: then→else", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);
  assert.equal(child.shownIndex, THEN_INDEX);

  ctx.set(2, false); // cond 변경 → swap
  assert.equal(child.shownIndex, ELSE_INDEX, "else로 swap됨");
  assert.equal(ctx.subCount(1), 0, "then 가지 구독 해제");
  assert.equal(ctx.subCount(3), 1, "else 가지 구독 활성");

  // then 노드는 detach, else 노드는 attach
  assert.equal(child.branches[THEN_INDEX].nodes[0].attached, false, "then 노드 detach");
  assert.equal(child.branches[ELSE_INDEX].nodes[0].attached, true, "else 노드 attach");
});

test("swap 후 비활성 가지 set은 무시된다", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);

  ctx.set(2, false); // else로 swap → then(leaf1) 구독 해제됨
  ctx.set(1, "ignored"); // 비활성 then 가지 leaf
  assert.notEqual(child.branches[THEN_INDEX].nodes[0].lastSeenValue, "ignored", "비활성 update 안 됨");
});

test("재활성 시 놓친 값 따라잡기", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);

  ctx.set(2, false); // then 비활성
  ctx.set(1, "changed"); // 비활성 동안 then 가지 leaf 변경(구독 없어 반영 안 됨)
  ctx.set(2, true); // then 재활성 → 현재값으로 갱신돼야
  assert.equal(child.branches[THEN_INDEX].nodes[0].lastSeenValue, "changed", "재활성 시 최신값");
});
