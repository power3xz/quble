// Quble 클라이언트 런타임 본체 — .qubb를 두 단계로 인스턴스화한다.
//
//   compile(bytes)        → blueprintOf(compId) => Blueprint  (def를 청사진으로)
//   Blueprint(ctx, paths) → Instance                          (청사진 호출 = 인스턴스화. DOM·구독 생성)
//
// Blueprint는 호출 시 def 코드를 훑어 DOM·구독을 만든다. (미리-파싱 방식도 시도했으나, 인스턴스화
// 병목이 DOM API라 파싱 방식 차이는 측정 노이즈 수준 — 단순한 "호출 시 훑기"를 택했다.)
//
// Instance = { nodes, regions }. nodes는 루트 노드들(부착·추적용), regions는 이 인스턴스의 모든
// Region(@if swap 경계). 구독은 가지(Branch)에 모이고 activateBranch가 켤 때 건다 — 안 보이는
// 가지는 구독 0이다(region 구조·동작은 region.js). RENDER는 자식 def를 같은 interpret으로 인라인
// 재진입해, 자식 if가 부모와 같은 regions·가지에 합류한다(별도 인스턴스 없음).
//
// 인덱스 세 축 (REACTIVITY.md §1~§3):
//   offset(컴포넌트 로컬) → path(store 경로, paths가 매핑) → leafIndex(평탄, ctx.resolve가 lazy 발급).

import {
  THEN_INDEX,
  ELSE_INDEX,
  appendRegion,
  activateBranch,
  attachBranch,
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
  LOAD_RES: 0x0f,
};

// ── store 컨텍스트 (pub/sub) ──────────────────────────────────────────
// 반응 상태 저장소를 만든다 — leafIndex로 값을 읽고/쓰고/구독한다.
//
// 값은 leaves(평탄 배열)에 leafIndex로 담기고, set은 그 leaf의 구독자에게 새 값을 통지한다.
// path는 resolve가 leafIndex로 lazy 발급(pathCache)한다.
//
// @param defaultValue 경로 해석의 뿌리 객체(resolve가 path를 이 객체에서 읽어 초기값 발급)
// @returns            { leaves, set, subscribe, unsubscribe, resolve }
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

// opcode의 operand 바이트 수를 돌려준다.
//
// skipBranch가 op 경계를 짚어 마커(IF/ELSE/IF_END)를 operand 값과 혼동하지 않게 한다.
// (SSR renderer operand_len과 동일.)
//
// @param op opcode 바이트
// @returns  operand 바이트 수(0·2·4)
const operandLen = (op) => {
  switch (op) {
    case OP.HALT:
    case OP.ELEM_CLOSE_OPEN:
    case OP.ELEM_END:
    case OP.ELSE:
    case OP.IF_END:
      return 0;
    case OP.ELEM_OPEN:
    case OP.TEXT:
    case OP.TEXT_VAR:
    case OP.RENDER:
    case OP.PUSH_ARG:
    case OP.IF:
    case OP.LOAD_RES:
      return 2;
    case OP.ATTR_G:
    case OP.ATTR_L:
    case OP.ATTR_G_VAR:
    case OP.ATTR_L_VAR:
      return 4;
    default:
      throw new Error("bad opcode 0x" + op.toString(16));
  }
};

// 현재 가지를 통째로 스킵하고 끝 마커(ELSE/IF_END)의 pc를 돌려준다.
//
// op 경계를 따라 전진하며 중첩 if 깊이를 센다. 같은 깊이(0)에서 만난 ELSE/IF_END가 이 가지의
// 끝이다. build 안 하는 비활성 가지의 경계 위치만 얻을 때 쓴다. (SSR skip_branch의 JS 포팅.)
//
// @param code    def 바이트코드
// @param startPc 스킵 시작 위치(가지 첫 op)
// @returns       끝 마커(ELSE/IF_END)의 pc — 호출자가 그 마커를 소비
const skipBranch = (code, startPc) => {
  let pc = startPc;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    if (op === OP.IF) {
      depth += 1;
      pc += operandLen(OP.IF);
    } else if (op === OP.IF_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else if (op === OP.ELSE && depth === 0) {
      return markerPc;
    } else {
      pc += operandLen(op);
    }
  }
  throw new Error("unbalanced branch — no matching ELSE/IF_END");
};

// IF 블록의 then/else 코드 경계를 구한다(순수 — code와 then 시작 pc만 본다).
//
// then = thenStart~thenEnd, else = elseStart~ifEndPc. else 없으면 elseStart = -1이고
// thenEnd === ifEndPc === IF_END 위치. 마커는 skipBranch로 찾고 호출자가 소비한다.
//
// @param code      def 바이트코드
// @param thenStart then 가지 시작 pc(IF operand 직후)
// @returns         { thenEnd, elseStart, ifEndPc }
const ifBranchRanges = (code, thenStart) => {
  const thenEnd = skipBranch(code, thenStart); // ELSE 또는 IF_END
  if (code[thenEnd] === OP.ELSE) {
    const elseStart = thenEnd + 1;
    return { thenEnd, elseStart, ifEndPc: skipBranch(code, elseStart) };
  }
  return { thenEnd, elseStart: -1, ifEndPc: thenEnd }; // else 없는 if
};

// 점 표기 경로로 객체를 파고들어 값을 읽는다("a.b.c" → obj.a.b.c).
//
// @param defaultValue 뿌리 객체
// @param path         점으로 구분된 경로 문자열
// @returns            경로가 가리키는 값
const readPath = (defaultValue, path) => {
  let cur = defaultValue;
  for (const key of path.split(".")) {
    cur = cur[key];
  }
  return cur;
};

// ── 디코드 (proto/BYTECODE.md 포맷) ───────────────────────────────────
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

// qubb 바이트를 모듈로 디코드한다(상수풀·def 테이블·코드).
//
// @param bytes qubb 바이트 (proto/BYTECODE.md 포맷)
// @returns     { pool, defs, code }
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

// ── 한 def를 Blueprint로 컴파일 ──────────────────────────────────────
// 한 컴포넌트 def를 Blueprint(인스턴스화 함수)로 만든다.
//
// Blueprint는 호출 시 def 코드를 훑어 DOM·구독을 만든다. 자식 RENDER는 interpret을 자식 def
// 구간으로 재진입해 인라인 합성한다(별도 청사진 호출 없음).
//
// @param module 디코드된 모듈
// @param compId 컴포넌트 def 인덱스
// @returns      Blueprint: (ctx, rootPaths) => Instance { nodes, regions }
const compileDef = (module, compId, resmap = []) => {
  const def = module.defs[compId];
  if (!def) {
    throw new Error("bad component " + compId);
  }
  const code = module.code.subarray(def.codeOff, def.codeOff + def.codeLen);

  return (ctx, rootPaths) => {
    // 인스턴스 불변 상태 — 모든 build(최초·lazy)가 공유한다.
    // 루트도 region(균일성): swap 없는 단일 가지지만, anchor·branch.nodes를 자식과 똑같이 갖춰
    // attachBranch가 분기 없이 처리한다. 루트 anchor 주석은 인스턴스 노드의 맨 앞에 선다.
    const regions = []; // append만, 인덱스 영구 안정. appendRegion이 새 region을 더한다.
    const rootRegion = regions[appendRegion(regions, -1)]; // 루트도 region(인덱스 0)
    rootRegion.branches[THEN_INDEX].built = true; // 루트 then은 즉시 build됨(아래 interpret)
    rootRegion.shownIndex = THEN_INDEX;

    // 한 가지(startPc~endPc)를 build한다 — 노드는 fragment로 반환, 구독은 해당 가지에 쌓는다.
    //
    // 재진입 가능: 최초 인스턴스화는 루트 전체를, lazy build는 swap으로 처음 켜지는 가지 범위만
    // 해석한다. 자식 IF는 활성 가지를 재귀로 즉시 build하고 비활성 가지엔 lazyBuild만 심는다.
    // RENDER는 자식 def 구간을 자식 paths로 이 함수에 재진입해 인라인 합성한다(별도 인스턴스/
    // 루트 region 없이 부모 가지 안에 합류).
    //
    // @param code             해석할 바이트코드(자식은 자식 def 구간)
    // @param paths            offset → store 경로 매핑(자식은 자식 paths)
    // @param startPc, endPc   해석 범위(endPc는 IF_END 직전)
    // @param startRegionIndex 구독을 쌓을 region
    // @param startBranchIndex 구독을 쌓을 가지(THEN/ELSE)
    // @returns                직속 노드를 담은 DocumentFragment
    const interpret = (code, paths, startPc, endPc, startRegionIndex, startBranchIndex) => {
      const fragment = document.createDocumentFragment();
      const nodeStack = [fragment]; // 노드 스택 — DOM 부모 추적
      let pending = null;
      let args = [];
      let pc = startPc;

      // 이 interpret이 채우는 가지. 한 호출 = 한 가지라 불변(중첩 if는 재귀 호출이 자식 가지를
      // 새 컨텍스트로 받는다 — JS 호출 스택이 옛 region/branch 스택 역할을 대신한다).
      const branch = regions[startRegionIndex].branches[startBranchIndex];

      const u16at = () => {
        const v = code[pc] | (code[pc + 1] << 8);
        pc += 2;
        return v;
      };
      const nodeTop = () => nodeStack[nodeStack.length - 1];

      // offset을 leafIndex로 해석(지연)하고 초기값을 돌려준다.
      //
      // 구독은 즉시 걸지 않고 현재 가지에 모은다 — activateBranch가 그 가지를 켤 때 건다
      // (안 보이는 가지는 구독 0).
      //
      // @param offset 컴포넌트 로컬 offset(paths로 store 경로 해석)
      // @param update 값 변경 시 호출될 콜백(가지 활성화 후 구독으로 연결)
      // @returns      현재 leaf 값(없으면 "")
      const bindVar = (offset, update) => {
        const path = paths[offset];
        if (path === undefined) {
          throw new Error("no path for offset " + offset);
        }
        const leafIndex = ctx.resolve(path);
        const initial = ctx.leaves[leafIndex] ?? "";
        branch.leafIndices.push(leafIndex);
        branch.updateFns.push(update);
        return initial;
      };

      while (pc < endPc) {
        const op = code[pc++];
        switch (op) {
          case OP.HALT: {
            pc = endPc;
            break;
          }
          case OP.LOAD_RES: {
            // 리소스 로드 — resId의 URL로 <link>를 document.head에 삽입. 이미 같은 href가
            // 있으면 스킵(여러 컴포넌트·재마운트가 같은 리소스를 써도 한 번만).
            const url = resmap[u16at()];
            if (url && !document.head.querySelector(`link[href="${url}"]`)) {
              const link = document.createElement("link");
              link.rel = "stylesheet";
              link.href = url;
              document.head.appendChild(link);
            }
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
            // 합성 = 인라인 재진입. 자식 def의 code 구간을 자식 paths로 같은 interpret에 돌린다.
            // 시작 가지 = 지금 이 가지(startRegionIndex/startBranchIndex) → 자식 IF는 이 가지의
            // childRegionIndices에 합류하고 같은 regions 배열에 append된다(인덱스 전역 유일).
            // 자식 루트 region 없음 — 자식 직속 노드는 fragment로 모여 RENDER 위치에 붙는다.
            const childDef = module.defs[childCompId];
            const childCode = module.code.subarray(childDef.codeOff, childDef.codeOff + childDef.codeLen);
            const childFragment = interpret(
              childCode,
              childPaths,
              0,
              childCode.length,
              startRegionIndex,
              startBranchIndex,
            );
            for (const node of childFragment.childNodes) {
              nodeTop().appendChild(node);
            }
            break;
          }
          case OP.IF: {
            const condOffset = u16at();
            const condLeafIndex = ctx.resolve(paths[condOffset]);
            const regionIndex = appendRegion(regions, condLeafIndex);
            const region = regions[regionIndex];
            branch.childRegionIndices.push(regionIndex); // 부모(이 interpret의) 가지에 자식 등록
            const thenBranch = region.branches[THEN_INDEX];
            const elseBranch = region.branches[ELSE_INDEX];
            // anchor(if 자리 고정용 주석)는 appendRegion이 만들었다. 여기서 DOM 트리에 붙인다.
            nodeTop().appendChild(region.anchor);

            // then/else 코드 경계. thenStart = IF operand 직후(현재 pc).
            const thenStart = pc;
            const { thenEnd, elseStart, ifEndPc } = ifBranchRanges(code, thenStart);

            // 각 가지를 build하는 클로저. 활성 가지는 지금 호출하고, 비활성 가지는 심어만 둔다.
            const buildThen = () => {
              const f = interpret(code, paths, thenStart, thenEnd, regionIndex, THEN_INDEX);
              thenBranch.nodes = Array.from(f.childNodes);
            };
            const buildElse = () => {
              const f = elseStart === -1
                ? document.createDocumentFragment() // else 없는 if — 빈 가지
                : interpret(code, paths, elseStart, ifEndPc, regionIndex, ELSE_INDEX);
              elseBranch.nodes = Array.from(f.childNodes);
            };
            thenBranch.lazyBuild = buildThen;
            elseBranch.lazyBuild = buildElse;

            // cond 변경 시 해당 가지를 활성화(swap). 첫 활성화면 activateBranch가 lazyBuild 호출.
            ctx.subscribe(condLeafIndex, (condValue) => {
              activateBranch(ctx, regions, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
            });
            // build는 "생성만" 한다 — 활성 가지를 lazyBuild로 만들어 자식 branch.nodes에 담고
            // shownIndex만 설정한다. DOM 부착·구독 등록은 하지 않는다(attachBranch가 일괄).
            // 그래야 부모 fragment엔 anchor만 남아, 부모 branch.nodes가 자손까지 머금지 않는다.
            // (anchor는 평평한 형제라, 여기서 자식 노드를 붙이면 부모 nodes에 섞여 detach가 깨진다.)
            const initialBranchIndex = ctx.leaves[condLeafIndex] ? THEN_INDEX : ELSE_INDEX;
            const initialBranch = region.branches[initialBranchIndex];
            initialBranch.lazyBuild();
            initialBranch.built = true;
            region.shownIndex = initialBranchIndex;

            pc = ifEndPc + 1; // IF_END 마커 소비 — if 블록 다음으로.
            break;
          }
          default: {
            throw new Error("bad opcode 0x" + op.toString(16));
          }
        }
      }
      return fragment;
    };

    // build: 트리(regions·branch.nodes·shownIndex)만 만든다. 루트 직속 노드는 fragment에 모여
    // 루트 가지에 담긴다(자식 region 노드는 아직 안 붙음 — 부모 nodes 오염 방지). 그 뒤
    // attachBranch가 루트부터 재귀로 노드를 anchor 뒤에 끼우고 구독을 건다.
    const fragment = interpret(code, rootPaths, 0, code.length, 0, THEN_INDEX);
    rootRegion.branches[THEN_INDEX].nodes = Array.from(fragment.childNodes);
    fragment.prepend(rootRegion.anchor); // anchor를 루트 노드 앞에 — attach가 anchor.after로 채운다
    attachBranch(ctx, regions, rootRegion);
    // fragment 자식 전체(anchor + 붙은 트리)가 이 인스턴스의 루트 노드들(append 시 비워지므로 배열로).
    const nodes = Array.from(fragment.childNodes);
    return { nodes, regions };
  };
};

// ── 공개 API ─────────────────────────────────────────────────────────
// qubb 바이트를 디코드해 blueprintOf(compId)를 돌려준다.
//
// 사용: const blueprintOf = compile(bytes);
//       const inst = blueprintOf(0)(ctx, paths);
//       root.append(...inst.nodes);
//
// @param bytes  qubb 바이트
// @param resmap resId -> URL 매핑(LOAD_RES가 <link>로 삽입). 없으면 리소스 로드 생략.
// @returns      blueprintOf: (compId) => Blueprint
export const compile = (bytes, resmap = []) => {
  const module = decode(bytes);
  return (compId) => compileDef(module, compId, resmap);
};
