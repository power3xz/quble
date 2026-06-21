// lazy build 실험: IF를 만나면 활성 가지만 build하고(노드·구조만, 구독은 activateBranch가 켤 때),
// 비활성 가지엔 lazyBuild 클로저만 심는다. cond가 바뀌어 처음 켜질 때 그 가지를 비로소 build한다.
// 목적은 "한 루프 + region 스택 + var 소속 + lazy build + cond swap"의 뼈대 확인.
//
// build와 켜기를 분리: lazyBuild는 노드/leafIndices/updateFns/childRegionIndices만 채운다(구독 X).
// 켜기는 activateBranch로 일원화 — 초기 활성화도, 이후 swap도 같은 함수. 첫 활성화면 lazyBuild 호출.
// 한 가지를 build하는 fakeNode/updateFn 생성은 then/else가 공유한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEN_INDEX,
  ELSE_INDEX,
  createRegion,
  createBranch,
  activateBranch,
} from "./region.js";
import { skipBranch } from "./compile.js";

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

// ── 인스턴스화: 재진입 interpret + region 스택. 활성 가지만 즉시 build, 비활성엔 lazyBuild만 심음 ──
// compile.js와 동형(同型) — 검증 대상은 lazy build + activateBranch 흐름이다. 가짜 노드를 쓴다.
const instantiate = (code, ctx) => {
  const regions = [createRegion(-1, null)]; // 0번 = 루트 Region(껍데기)
  regions[0].branches[THEN_INDEX] = createBranch();
  regions[0].branches[THEN_INDEX].built = true;

  // 한 가지(startPc~endPc)를 build해 fragment 노드들을 모은다. 재진입 — 활성 가지마다 호출된다.
  const interpret = (startPc, endPc, startRegionIndex, startBranchIndex) => {
    const nodes = [];
    // 한 호출 = 한 가지라 불변. 중첩 if는 재귀 호출이 자식 가지를 새 컨텍스트로 받는다.
    const branch = regions[startRegionIndex].branches[startBranchIndex];

    let pc = startPc;
    const u16 = () => {
      const value = code[pc] | (code[pc + 1] << 8);
      pc += 2;
      return value;
    };

    while (pc < endPc) {
      const op = code[pc++];
      switch (op) {
        case OP.TEXT_VAR: {
          const leafIndex = u16(); // 실험에선 offset=leafIndex로 단순화
          const node = fakeNode();
          const updateFn = (value) => {
            node.lastSeenValue = value; // 실제론 textContent
          };
          nodes.push(node);
          branch.nodes.push(node);
          branch.leafIndices.push(leafIndex);
          branch.updateFns.push(updateFn); // 구독 X — activateBranch가 켤 때 건다.
          break;
        }
        case OP.IF: {
          const condLeafIndex = u16();
          const regionIndex = regions.length;
          const region = createRegion(condLeafIndex, fakeAnchor());
          regions.push(region);
          branch.childRegionIndices.push(regionIndex);
          const thenBranch = createBranch();
          const elseBranch = createBranch();
          region.branches[THEN_INDEX] = thenBranch;
          region.branches[ELSE_INDEX] = elseBranch;

          const thenStart = pc;
          const elseMarkerPc = skipBranch(code, thenStart);
          const elseStart = elseMarkerPc + 1; // 테스트 코드엔 항상 ELSE가 있다
          const ifEndPc = skipBranch(code, elseStart);

          thenBranch.lazyBuild = () => {
            thenBranch.nodes = interpret(thenStart, elseMarkerPc, regionIndex, THEN_INDEX);
          };
          elseBranch.lazyBuild = () => {
            elseBranch.nodes = interpret(elseStart, ifEndPc, regionIndex, ELSE_INDEX);
          };

          ctx.subscribe(condLeafIndex, (condValue) => {
            activateBranch(ctx, regions, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
          });
          // 초기 활성 가지 켜기 — activateBranch가 lazyBuild(첫 build)·구독·부착 일괄. 비활성은 노드 0.
          const initialBranchIndex = ctx.leaves[condLeafIndex] ? THEN_INDEX : ELSE_INDEX;
          activateBranch(ctx, regions, regionIndex, initialBranchIndex);

          pc = ifEndPc + 1;
          break;
        }
        default: {
          throw new Error("bad op 0x" + op.toString(16));
        }
      }
    }
    return nodes;
  };

  interpret(0, code.length, 0, THEN_INDEX);
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

test("활성 가지만 build된다 — var가 자기 가지에 소속", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  assert.deepEqual(regions[0].branches[THEN_INDEX].leafIndices, [0], "VAR0은 루트 가지");
  const child = childOf(regions);
  assert.deepEqual(child.branches[THEN_INDEX].leafIndices, [1], "VAR1은 then 가지(활성, build됨)");
  assert.deepEqual(child.branches[ELSE_INDEX].leafIndices, [], "else는 비활성 — 아직 build 안 됨");
});

test("lazy: 초기 비활성 가지는 노드 0·구독 0·built false", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);
  assert.equal(child.branches[ELSE_INDEX].built, false, "else 미build");
  assert.equal(child.branches[ELSE_INDEX].nodes.length, 0, "else 노드 0");
  assert.equal(ctx.subCount(3), 0, "else 가지(leaf3) 구독 0");
});

test("cond=true 초기: then 활성, else 가지 구독 0", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  assert.equal(childOf(regions).shownIndex, THEN_INDEX, "then 활성");
  assert.equal(ctx.subCount(1), 1, "then 가지(leaf1) 구독");
  assert.equal(ctx.subCount(3), 0, "else 가지(leaf3) 구독 0");
});

test("cond=false 초기: else 활성(build됨), then 가지 미build", () => {
  const ctx = fakeCtx(["a", "b", false, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);
  assert.equal(child.shownIndex, ELSE_INDEX, "else 활성");
  assert.equal(child.branches[THEN_INDEX].built, false, "then 미build");
  assert.equal(ctx.subCount(1), 0, "then 가지 구독 0");
  assert.equal(ctx.subCount(3), 1, "else 가지 구독");
});

test("첫 swap이 비활성 가지를 build한다: then→else", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);
  assert.equal(child.shownIndex, THEN_INDEX);
  assert.equal(child.branches[ELSE_INDEX].built, false, "swap 전 else 미build");

  ctx.set(2, false); // cond 변경 → swap (else 첫 활성화 = 첫 build)
  assert.equal(child.shownIndex, ELSE_INDEX, "else로 swap됨");
  assert.equal(child.branches[ELSE_INDEX].built, true, "swap 시 else build됨");
  assert.deepEqual(child.branches[ELSE_INDEX].leafIndices, [3], "build로 VAR3 소속");
  assert.equal(ctx.subCount(1), 0, "then 가지 구독 해제");
  assert.equal(ctx.subCount(3), 1, "else 가지 구독 활성");

  // then 노드는 detach, else 노드는 attach
  assert.equal(child.branches[THEN_INDEX].nodes[0].attached, false, "then 노드 detach");
  assert.equal(child.branches[ELSE_INDEX].nodes[0].attached, true, "else 노드 attach");
});

test("두 번째 swap은 재build 없이 재attach만", () => {
  const ctx = fakeCtx(["a", "b", true, "d"]);
  const regions = instantiate(code, ctx);
  const child = childOf(regions);

  ctx.set(2, false); // else 첫 build
  const elseNodeAfterBuild = child.branches[ELSE_INDEX].nodes[0];
  ctx.set(2, true); // then으로 (then은 이미 built — 재attach)
  ctx.set(2, false); // 다시 else — 재build 없이 같은 노드여야
  assert.equal(child.branches[ELSE_INDEX].nodes[0], elseNodeAfterBuild, "else 노드 동일(재build 안 함)");
  assert.equal(child.branches[ELSE_INDEX].nodes.length, 1, "노드 중복 생성 없음");
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

  ctx.set(2, false); // then 비활성(then은 초기 build됨, 이후 detach + 구독 해제)
  ctx.set(1, "changed"); // 비활성 동안 then 가지 leaf 변경(구독 없어 반영 안 됨)
  ctx.set(2, true); // then 재활성 → 현재값으로 갱신돼야(이미 built — 재attach + 따라잡기)
  assert.equal(child.branches[THEN_INDEX].nodes[0].lastSeenValue, "changed", "재활성 시 최신값");
});
