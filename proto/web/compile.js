// Quble 클라이언트 컴파일/인스턴스화 (실험). reactive.js를 대체할 후보.
//
// reactive.js는 build(즉시 DOM 생성)였다. 여기서는 두 단계로 나눈다:
//   compile(bytes)        → blueprintOf(compId) => Blueprint  — def를 청사진으로. registry 캐시(lazy).
//   Blueprint(ctx, paths) → Instance                          — 청사진 호출 = 인스턴스화. DOM·구독 생성.
//
// Blueprint는 호출 시 def 코드를 훑어 DOM·구독을 만든다. (미리-파싱 방식도 시도했으나, 인스턴스화
// 병목이 DOM API라 파싱 방식 차이는 측정 노이즈 수준 — 단순한 "호출 시 훑기"를 택했다.)
//
// Instance = { nodes, regions }  — nodes는 루트 노드들(부착·추적용). regions는 이 인스턴스의
// 모든 Region(@if swap 경계). 구독은 가지(Branch)에 모이고 activateBranch가 켤 때 건다 — 그래서
// 안 보이는 가지는 구독 0이다. region 구조·동작은 region.js 참고. (1단계: 단일 컴포넌트 안의 if만.
// RENDER 자식 컴포넌트의 region 병합은 다음 단계.)
//
// 인덱스 세 축은 reactive.js와 동일 (REACTIVITY.md §1~§3):
//   offset(컴포넌트 로컬) → path(store 경로, paths가 매핑) → leafIndex(평탄, ctx.resolve가 lazy 발급).

import {
  THEN_INDEX,
  ELSE_INDEX,
  createRegion,
  createBranch,
  activateBranch,
} from "./region.js";

const TAGS = ["div", "span", "p", "h1", "h2", "h3", "a", "ul", "li", "button", "article", "img"];
const ATTRS = ["class", "id", "src", "alt", "href", "type", "name", "value", "title", "style", "placeholder"];

const OP = {
  HALT: 0x00,
  ELEM_OPEN: 0x01,
  ATTR_G: 0x02,
  ELEM_CLOSE_OPEN: 0x03,
  TEXT: 0x04,
  ELEM_END: 0x05,
  RENDER: 0x06,
  ATTR_L: 0x07,
  TEXT_VAR: 0x08,
  ATTR_G_VAR: 0x09,
  ATTR_L_VAR: 0x0a,
  PUSH_ARG: 0x0b,
  IF: 0x0c,
  ELSE: 0x0d,
  IF_END: 0x0e,
};

// ── store 컨텍스트 (pub/sub) ──────────────────────────────────────────
export const createStore = (defaultValue) => {
  const leaves = [];
  const subscribers = []; // leafIndex → Set<(v)=>void>. Set이라 unsubscribe가 O(1).
  const pathCache = new Map(); // path → leafIndex

  const set = (leafIndex, value) => {
    leaves[leafIndex] = value;
    const subs = subscribers[leafIndex];
    if (subs) {
      // 스냅샷 순회 — 콜백(cond)이 activateBranch로 구독을 해제할 수 있어 원본 순회는 깨진다.
      for (const fn of [...subs]) {
        fn(value);
      }
    }
  };

  const subscribe = (leafIndex, fn) => {
    (subscribers[leafIndex] ??= new Set()).add(fn);
  };

  const unsubscribe = (leafIndex, fn) => {
    subscribers[leafIndex]?.delete(fn);
  };

  const resolve = (path) => {
    let leafIndex = pathCache.get(path);
    if (leafIndex !== undefined) {
      return leafIndex;
    }
    leafIndex = leaves.length;
    leaves[leafIndex] = readPath(defaultValue, path);
    pathCache.set(path, leafIndex);
    return leafIndex;
  };

  return { leaves, set, subscribe, unsubscribe, resolve };
};

const readPath = (defaultValue, path) => {
  let cur = defaultValue;
  for (const key of path.split(".")) {
    cur = cur[key];
  }
  return cur;
};

// ── 디코드 (reactive.js와 동일 포맷) ──────────────────────────────────
class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  take(n) {
    const s = this.b.subarray(this.pos, this.pos + n);
    if (s.length !== n) {
      throw new Error("unexpected eof");
    }
    this.pos += n;
    return s;
  }
  u16() {
    const s = this.take(2);
    return s[0] | (s[1] << 8);
  }
  u32() {
    const s = this.take(4);
    return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0;
  }
  str() {
    const len = this.u16();
    return new TextDecoder().decode(this.take(len));
  }
}

const decode = (bytes) => {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (!(magic[0] === 0x51 && magic[1] === 0x42 && magic[2] === 0x4c && magic[3] === 0x00)) {
    throw new Error("bad magic"); // "QBL\0"
  }
  const version = r.u16();
  if (version !== 0) {
    throw new Error("bad version " + version);
  }

  const poolCount = r.u16();
  const pool = [];
  for (let i = 0; i < poolCount; i++) {
    pool.push(r.str());
  }

  const defCount = r.u16();
  const defs = [];
  for (let i = 0; i < defCount; i++) {
    defs.push({ nameIdx: r.u16(), codeOff: r.u32(), codeLen: r.u32() });
  }

  const codeLen = r.u32();
  const code = r.take(codeLen);
  return { pool, defs, code };
};

// ── Registry: compId → Blueprint (lazy) ──────────────────────────────
// build(compId)가 실제로 쓰는 컴포넌트만 등록된다. 모듈을 한 번 디코드하고, 도달하는 def만
// 청사진으로 컴파일해 캐시한다(재사용).
const makeRegistry = (module) => {
  const cache = new Map(); // compId → Blueprint
  const blueprintOf = (compId) => {
    let blueprint = cache.get(compId);
    if (blueprint) {
      return blueprint;
    }
    // blueprintOf를 넘겨 RENDER가 자식 청사진을 lazy 조회한다.
    blueprint = compileDef(module, compId, blueprintOf);
    cache.set(compId, blueprint);
    return blueprint;
  };
  return blueprintOf;
};

// ── 한 def를 Blueprint로 컴파일 ──────────────────────────────────────
// Blueprint는 호출 시 def 코드를 훑어 DOM·구독을 만든다. 자식 RENDER는 registry(blueprintOf)에서
// 청사진을 꺼내 호출한다. Blueprint(ctx, paths) → Instance { nodes }
const compileDef = (module, compId, blueprintOf) => {
  const def = module.defs[compId];
  if (!def) {
    throw new Error("bad component " + compId);
  }
  const code = module.code.subarray(def.codeOff, def.codeOff + def.codeLen);

  return (ctx, paths) => {
    const fragment = document.createDocumentFragment();
    const nodeStack = [fragment]; // 노드 스택 — DOM 부모 추적
    let pending = null;
    let args = [];
    let pc = 0;

    // region 스택 — 구독 소속 가지 추적(노드 스택과 직교). region-build 실험에서 확정.
    const rootRegion = createRegion(-1, null); // 루트 = swap 없는 껍데기
    rootRegion.branches[THEN_INDEX] = createBranch();
    const regions = [rootRegion];
    const regionStack = [0]; // top = 현재 Region 인덱스
    let currentBranchIndex = THEN_INDEX; // 빌드타임 임시. IF=then, ELSE=else.
    const branchStack = []; // IF_END에서 currentBranchIndex 복원용

    const u16at = () => {
      const v = code[pc] | (code[pc + 1] << 8);
      pc += 2;
      return v;
    };
    const nodeTop = () => nodeStack[nodeStack.length - 1];
    const currentBranch = () => regions[regionStack[regionStack.length - 1]].branches[currentBranchIndex];

    // offset → leafIndex로 해석(지연)하고 초기값을 돌려준다. 구독은 즉시 걸지 않고 현재 가지에
    // 모은다 — activateBranch가 그 가지를 켤 때 건다(안 보이는 가지는 구독 0).
    const bindVar = (offset, update) => {
      const path = paths[offset];
      if (path === undefined) {
        throw new Error("no path for offset " + offset);
      }
      const leafIndex = ctx.resolve(path);
      const initial = ctx.leaves[leafIndex] ?? "";
      const branch = currentBranch();
      branch.leafIndices.push(leafIndex);
      branch.updateFns.push(update);
      return initial;
    };

    while (pc < code.length) {
      const op = code[pc++];
      switch (op) {
        case OP.HALT: {
          pc = code.length;
          break;
        }
        case OP.ELEM_OPEN: {
          pending = document.createElement(TAGS[u16at()]);
          break;
        }
        case OP.ATTR_G: {
          const name = ATTRS[u16at()];
          pending.setAttribute(name, module.pool[u16at()]);
          break;
        }
        case OP.ATTR_L: {
          const name = module.pool[u16at()];
          pending.setAttribute(name, module.pool[u16at()]);
          break;
        }
        case OP.ATTR_G_VAR: {
          const name = ATTRS[u16at()];
          const el = pending;
          const v = bindVar(u16at(), (v) => el.setAttribute(name, v));
          el.setAttribute(name, v);
          break;
        }
        case OP.ATTR_L_VAR: {
          const name = module.pool[u16at()];
          const el = pending;
          const v = bindVar(u16at(), (v) => el.setAttribute(name, v));
          el.setAttribute(name, v);
          break;
        }
        case OP.ELEM_CLOSE_OPEN: {
          nodeTop().appendChild(pending);
          nodeStack.push(pending);
          pending = null;
          break;
        }
        case OP.TEXT: {
          nodeTop().appendChild(document.createTextNode(module.pool[u16at()]));
          break;
        }
        case OP.TEXT_VAR: {
          const node = document.createTextNode("");
          node.textContent = bindVar(u16at(), (v) => (node.textContent = v));
          nodeTop().appendChild(node);
          break;
        }
        case OP.ELEM_END: {
          nodeStack.pop();
          break;
        }
        case OP.PUSH_ARG: {
          const parentOffset = u16at();
          const path = paths[parentOffset];
          if (path === undefined) {
            throw new Error("no path for offset " + parentOffset);
          }
          args.push(path);
          break;
        }
        case OP.RENDER: {
          const childCompId = u16at();
          const childPaths = args;
          args = [];
          // 자식 청사진을 registry에서 꺼내(없으면 등록) 인스턴스화. 같은 ctx 공유 → path 공유 성립.
          const childInstance = blueprintOf(childCompId)(ctx, childPaths);
          for (const n of childInstance.nodes) {
            nodeTop().appendChild(n);
          }
          break;
        }
        case OP.IF: {
          const condOffset = u16at();
          const condLeafIndex = ctx.resolve(paths[condOffset]);
          const region = createRegion(condLeafIndex, null);
          const regionIndex = regions.length;
          regions.push(region);
          currentBranch().childRegionIndices.push(regionIndex); // 부모 가지에 자식 등록
          region.branches[THEN_INDEX] = createBranch();
          region.branches[ELSE_INDEX] = createBranch();
          // anchor: if 자리 고정용 주석 노드. 활성 가지 노드는 이 뒤에 붙는다.
          region.anchor = document.createComment("qb:region#" + regionIndex);
          nodeTop().appendChild(region.anchor);
          regionStack.push(regionIndex);
          branchStack.push(currentBranchIndex);
          currentBranchIndex = THEN_INDEX;
          // 가지 노드를 격리할 fragment를 노드 스택에 — 나중에 Branch.nodes로 거둔다.
          nodeStack.push(document.createDocumentFragment());
          break;
        }
        case OP.ELSE: {
          // then 가지 노드를 거두고, else용 fragment로 교체.
          currentBranch().nodes = Array.from(nodeStack.pop().childNodes);
          currentBranchIndex = ELSE_INDEX;
          nodeStack.push(document.createDocumentFragment());
          break;
        }
        case OP.IF_END: {
          currentBranch().nodes = Array.from(nodeStack.pop().childNodes);
          const regionIndex = regionStack[regionStack.length - 1];
          const region = regions[regionIndex];
          // cond 변경 시 해당 가지를 활성화(swap).
          ctx.subscribe(region.condLeafIndex, (condValue) => {
            activateBranch(ctx, regions, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
          });
          // 초기 활성 가지 켜기 — 활성 가지 노드가 anchor 뒤(제자리)에 붙는다.
          const initialBranchIndex = ctx.leaves[region.condLeafIndex] ? THEN_INDEX : ELSE_INDEX;
          activateBranch(ctx, regions, regionIndex, initialBranchIndex);
          regionStack.pop();
          currentBranchIndex = branchStack.pop();
          break;
        }
        default: {
          throw new Error("bad opcode 0x" + op.toString(16));
        }
      }
    }

    // fragment의 자식들이 이 인스턴스의 루트 노드들. fragment는 append 시 비워지므로 미리 배열로.
    const nodes = Array.from(fragment.childNodes);
    return { nodes, regions };
  };
};

// ── 공개 API ─────────────────────────────────────────────────────────
// compile(bytes) → blueprintOf(compId) => Blueprint. compId의 청사진을 lazy로 돌려준다.
// 사용: const blueprintOf = compile(bytes); const inst = blueprintOf(0)(ctx, paths); root.append(...inst.nodes);
export const compile = (bytes) => {
  const module = decode(bytes);
  return makeRegistry(module);
};
