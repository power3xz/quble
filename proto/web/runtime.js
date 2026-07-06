// Quble 클라이언트 런타임 본체 - .qubb를 두 단계로 인스턴스화한다.
//
//   compile(bytes)        → blueprintOf(compId) => Blueprint  (def를 청사진으로)
//   Blueprint(store, paths) → Instance                          (청사진 호출 = 인스턴스화. DOM·구독 생성)
//
// Blueprint는 호출 시 def 코드를 훑어 DOM·구독을 만든다. (미리-파싱 방식도 시도했으나, 인스턴스화
// 병목이 DOM API라 파싱 방식 차이는 측정 노이즈 수준 - 단순한 "호출 시 훑기"를 택했다.)
//
// Instance = { nodes, regions }. nodes는 루트 노드들(부착·추적용), regions는 이 인스턴스의 모든
// Region(@if swap 경계). 구독은 가지(Branch)에 모이고 activateBranch가 켤 때 건다 - 안 보이는
// 가지는 구독 0이다(region 구조·동작은 region.js). RENDER는 자식 def를 같은 interpret으로 인라인
// 재진입해, 자식 if가 부모와 같은 regions·가지에 합류한다(별도 인스턴스 없음).
//
// 인덱스 세 축 (REACTIVITY.md §1~§3):
//   offset(컴포넌트 로컬) → path(store 경로, paths가 매핑) → leafIndex(평탄, store.leafOf가 lazy 발급).

import {
  THEN_INDEX,
  ELSE_INDEX,
  appendRegion,
  activateBranch,
  attachBranch,
} from "./region.js";

// 상태 저장소(store)는 leaf-store.js가 정의한다. blueprint가 받는 store가 이것 - 편의상 여기서 재공개한다.
export { createLeafStoreSubject } from "./leaf-store.js";

const TAGS = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "a",
  "ul",
  "li",
  "button",
  "article",
  "img",
  "section",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "label",
  "input",
];
const ATTRS = [
  "class",
  "id",
  "src",
  "alt",
  "href",
  "type",
  "name",
  "value",
  "title",
  "style",
  "placeholder",
];
// 전역 DOM 이벤트 테이블(BYTECODE.md §2). BIND_EVENT의 event_type. Rust dom_events.rs와 동일 순서.
const DOM_EVENTS = [
  "click",
  "input",
  "change",
  "submit",
  "focus",
  "blur",
  "keydown",
  "keyup",
  "mousedown",
  "mouseup",
  "mouseenter",
  "mouseleave",
  "scroll",
];

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
  BIND_EVENT: 0x10,
  PUSH_ARG_LIT: 0x11,
  PUSH_PATH_SEGMENT: 0x12,
  ENTER_CONTEXT: 0x13,
  EXIT_CONTEXT: 0x14,
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
    case OP.EXIT_CONTEXT:
      return 0;
    case OP.ELEM_OPEN:
    case OP.TEXT:
    case OP.TEXT_VAR:
    case OP.RENDER:
    case OP.PUSH_ARG:
    case OP.PUSH_ARG_LIT:
    case OP.PUSH_PATH_SEGMENT:
    case OP.IF:
    case OP.LOAD_RES:
    case OP.ENTER_CONTEXT:
      return 2;
    case OP.ATTR_G:
    case OP.ATTR_L:
    case OP.ATTR_G_VAR:
    case OP.ATTR_L_VAR:
    case OP.BIND_EVENT:
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
// @returns       끝 마커(ELSE/IF_END)의 pc - 호출자가 그 마커를 소비
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
  throw new Error("unbalanced branch - no matching ELSE/IF_END");
};

// IF 블록의 then/else 코드 경계를 구한다(순수 - code와 then 시작 pc만 본다).
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
  u8() {
    return this.take(1)[0];
  }
  u16() {
    const s = this.take(2);
    return s[0] | (s[1] << 8);
  }
  u32() {
    const s = this.take(4);
    return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0;
  }
  f64() {
    const s = this.take(8);
    return new DataView(s.buffer, s.byteOffset, 8).getFloat64(0, true);
  }
  str() {
    const len = this.u16();
    return new TextDecoder().decode(this.take(len));
  }
  // 상수풀 엔트리: 태그 1바이트로 타입을 정해 payload를 읽는다(Rust put_const의 역).
  // 런타임 값이 그대로 JS 값(string/number/boolean)이라 소비 지점은 타입을 다시 안 본다.
  constant() {
    const tag = this.u8();
    if (tag === 0) {
      return this.str();
    }
    if (tag === 1) {
      return this.f64();
    }
    if (tag === 2) {
      return this.u8() !== 0;
    }
    throw new Error("bad const tag " + tag);
  }
}

// 슬롯 해석방법. paths는 (해석방법, 참조) 쌍을 인터리브로 담는다 - 슬롯 offset은
// paths[2*offset](해석방법) / paths[2*offset+1](참조)로 읽는다. STORE는 참조가 store
// 경로(반응값, 구독), CONST는 참조가 상수풀 인덱스(불변, 구독 스킵). (STACK는 @for 때 추가.)
const STORE = 0;
const CONST = 1;

// leaf 값의 const 표지 비트(MSB). Rust Leaf::encode와 대칭 - 이 비트와 마스킹은
// readFields 한 곳에만 둔다(소비부는 isConst/index만 본다).
const FIELD_CONST_BIT = 0x8000;

// 타입 테이블 엔트리 태그(BYTECODE.md §4). Rust read_type 대칭.
const TYPE_SCALAR = 0;
const TYPE_OBJECT = 1;

// 타입 테이블 엔트리 하나를 읽는다. Scalar는 payload 없음, Object는 field_count +
// [(nameConstIndex, typeRef)]. typeRef로 자식을 가리켜 중첩·공유(Rust put_type 대칭).
//
// @param r Reader
// @returns { tag: "scalar" } | { tag: "object", fields: [[nameConstIndex, typeRef]] }
const readType = (r) => {
  const tag = r.u8();
  if (tag === TYPE_SCALAR) {
    return { tag: "scalar" };
  }
  if (tag === TYPE_OBJECT) {
    const count = r.u16();
    const fields = [];
    for (let f = 0; f < count; f++) {
      fields.push([r.u16(), r.u16()]);
    }
    return { tag: "object", fields };
  }
  throw new Error("bad type tag " + tag);
};

// 필드 목록을 읽는다 - field_count, [(nameConstIndex, typeRef, leaf_count, [leaf])]. leaf는
// MSB=const 여부, 하위 15비트=index. 이벤트 payload와 컨텍스트가 같은 인코딩(Rust read_fields 대칭).
//
// @param r Reader
// @returns [{ nameConstIndex, typeRef, leaves: [{ isConst, index }] }]
const readFields = (r) => {
  const count = r.u16();
  const fields = [];
  for (let f = 0; f < count; f++) {
    const nameConstIndex = r.u16();
    const typeRef = r.u16();
    const leafCount = r.u16();
    const leaves = [];
    for (let l = 0; l < leafCount; l++) {
      const raw = r.u16();
      leaves.push({
        isConst: (raw & FIELD_CONST_BIT) !== 0,
        index: raw & ~FIELD_CONST_BIT,
      });
    }
    fields.push({ nameConstIndex, typeRef, leaves });
  }
  return fields;
};

// field의 leaves를 flat 값-소스 열 [kind, ref, kind, ref, …]로 푼다(바인딩 때 1회). 소스는
// 슬롯과 같은 (해석방법, 참조) 쌍: STORE는 ref가 미리 푼 leafIndex(store.get용), CONST는
// ref가 상수풀 인덱스(module.pool용). assemble이 발생 때 kind 보고 갈라 읽는다.
//
// leaf가 값을 얻는 두 길이 CONST로 합류한다: leaf 자체가 리터럴(isConst, payload에 직접
// 박힘)이거나, Scope가 가리킨 슬롯이 CONST(부모가 리터럴로 준 prop)거나.
//
// @param leaves field.leaves - [{ isConst, index }]
// @param paths  flat 슬롯 배열
// @returns      [kind, ref, …] flat 소스 열
const leavesToSources = (leaves, paths, store) => {
  const sources = [];
  for (const leaf of leaves) {
    if (leaf.isConst) {
      sources.push(CONST, leaf.index);
    } else if (paths[2 * leaf.index] === CONST) {
      sources.push(CONST, paths[2 * leaf.index + 1]);
    } else {
      sources.push(STORE, store.leafOf(paths[2 * leaf.index + 1]));
    }
  }
  return sources;
};

// 조립 step - 런타임 내부 미니 명령(바이트코드 opcode와 다른 층). type_ref 구조를 평탄한 step
// 열로 컴파일해두고, assemble이 그 열을 반복 실행해 중첩 객체를 짓는다(재귀·트리순회 없음).
//   STEP_ENTER key : 새 객체를 만들어 부모[key]에 걸고 내려간다
//   STEP_LEAF  key : 부모[key] = 다음 leaf 값
//   STEP_EXIT      : 부모로 돌아온다
const STEP_ENTER = 0;
const STEP_LEAF = 1;
const STEP_EXIT = 2;

// type_ref 구조를 조립 step 열로 컴파일한다(type_ref별 1회, dedup되니 공유 가능). 명시적 스택
// 반복이라 깊은 타입에도 콜스택 안전. leaf 자리엔 인덱스를 안 박고 STEP_LEAF로 "다음 leaf 소비"만
// 표시 - 실제 leaf는 assemble이 leafIndices를 커서로 소비한다(구조=step, 인스턴스=leafIndices).
//
// @param types   타입 테이블
// @param typeRef 시작 타입
// @param pool    상수풀(필드명 해석)
// @returns       [[STEP_*, key]] 평탄 열. 루트 key=null.
const compileType = (types, typeRef, pool) => {
  const steps = [];
  // 한 노드로 내려간다: 스칼라면 LEAF 하나로 끝, 객체면 ENTER를 내고 남은 자식 큐를 돌려준다.
  // 프레임은 "열어둔 객체의 아직 처리 안 한 자식들" - 이 큐만 상태로 든다(플래그 없음).
  const enter = (ref, key) => {
    const t = types[ref];
    if (t.tag === "scalar") {
      steps.push([STEP_LEAF, key]);
      return null;
    }
    steps.push([STEP_ENTER, key]);
    return t.fields.map(([nameConst, childRef]) => [pool[nameConst], childRef]);
  };

  const rootRemaining = enter(typeRef, null);
  if (rootRemaining === null) {
    return steps; // 루트가 스칼라면 STEP_LEAF 하나뿐
  }
  const stack = [rootRemaining];
  while (stack.length) {
    const remaining = stack[stack.length - 1];
    if (remaining.length === 0) {
      steps.push([STEP_EXIT, null]); // 자식 다 처리 → 이 객체 닫음
      stack.pop();
      continue;
    }
    // 다음 자식으로 내려간다(깊이우선). 객체면 즉시 top이 되어 걔부터 파고든다 - 순서 안 밀림.
    const [key, childRef] = remaining.shift();
    const childRemaining = enter(childRef, key);
    if (childRemaining !== null) {
      stack.push(childRemaining);
    }
  }
  return steps;
};

// 조립 step 열을 실행해 값을 만든다(발생 시점). sources를 (kind, ref) 쌍 커서로 소비하며
// STEP_LEAF에서 STORE면 store.get, CONST면 pool 직접. 루트가 스칼라(step이 STEP_LEAF 하나)면
// 객체로 감싸지 않고 값을 그대로 반환한다.
//
// @param steps   compileType 결과
// @param sources 이 field의 flat 값-소스 [kind, ref, …](깊이우선, step의 LEAF 순서와 일치)
const assemble = (steps, sources, store, module) => {
  let cursor = 0;
  const root = {};
  const stack = [root];
  for (const [step, key] of steps) {
    const top = stack[stack.length - 1];
    if (step === STEP_LEAF) {
      const kind = sources[cursor++];
      const ref = sources[cursor++];
      const value = kind === CONST ? module.pool[ref] : store.get(ref);
      if (key === null) {
        return value; // 루트가 스칼라 - 객체로 안 감싼다
      }
      top[key] = value;
    } else if (step === STEP_ENTER) {
      if (key === null) {
        continue; // 루트 객체는 root 그대로 - 새로 만들지 않는다
      }
      const obj = {};
      top[key] = obj;
      stack.push(obj);
    } else if (stack.length > 1) {
      stack.pop();
    }
  }
  return root;
};

// type_ref의 조립 step 열을 돌려준다. 처음 참조면 컴파일해 캐시(발생 시점 lazy). 같은 type_ref는
// 한 번만 컴파일 - dedup된 타입 테이블의 이점이 실행 표현까지 이어진다.
const compiledStepsOf = (module, typeRef) => {
  if (module.compiledSteps[typeRef] === undefined) {
    module.compiledSteps[typeRef] = compileType(
      module.types,
      typeRef,
      module.pool,
    );
  }
  return module.compiledSteps[typeRef];
};

// qubb 바이트를 모듈로 디코드한다(상수풀·def 테이블·코드).
//
// @param bytes qubb 바이트 (proto/BYTECODE.md 포맷)
// @returns     { pool, defs, code }
const decode = (bytes) => {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (
    !(
      magic[0] === 0x51 &&
      magic[1] === 0x42 &&
      magic[2] === 0x4c &&
      magic[3] === 0x00
    )
  ) {
    throw new Error("bad magic"); // "QBL\0"
  }
  const version = r.u16();
  if (version !== 0) {
    throw new Error("bad version " + version);
  }

  const poolCount = r.u16();
  const pool = [];
  for (let i = 0; i < poolCount; i++) {
    pool.push(r.constant());
  }

  // 타입 테이블(모듈 전역) - type_count, [ (tag, payload) ]. Rust read_type 대칭.
  const typeCount = r.u16();
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    types.push(readType(r));
  }

  const defCount = r.u16();
  const defs = [];
  for (let i = 0; i < defCount; i++) {
    const nameConstIndex = r.u16();
    const codeOff = r.u32();
    const codeLen = r.u32();
    // 이벤트 테이블 (BYTECODE.md §4) - event_count, [(nameConstIndex, fields)]
    const eventCount = r.u16();
    const events = [];
    for (let e = 0; e < eventCount; e++) {
      events.push({ nameConstIndex: r.u16(), fields: readFields(r) });
    }
    // 컨텍스트 테이블 - context_count, [(nameConstIndex, fields)]. fields는 이벤트와 같은 인코딩.
    const contextCount = r.u16();
    const contexts = [];
    for (let c = 0; c < contextCount; c++) {
      contexts.push({ nameConstIndex: r.u16(), fields: readFields(r) });
    }
    defs.push({ nameConstIndex, codeOff, codeLen, events, contexts });
  }

  const codeLen = r.u32();
  const code = r.take(codeLen);
  // compiledSteps: type_ref -> 조립 step 열 캐시. 발생 시점에 lazy로 채운다(안 터지는 이벤트의
  // 타입은 컴파일 안 함 - lazy build 결). 같은 type_ref는 한 번만 컴파일(dedup 이점 유지).
  return { pool, types, defs, code, compiledSteps: [] };
};

// ── 한 def를 Blueprint로 컴파일 ──────────────────────────────────────
// 한 컴포넌트 def를 Blueprint(인스턴스화 함수)로 만든다.
//
// Blueprint는 호출 시 def 코드를 훑어 DOM·구독을 만든다. 자식 RENDER는 interpret을 자식 def
// 구간으로 재진입해 인라인 합성한다(별도 청사진 호출 없음).
//
// @param module 디코드된 모듈
// @param compId 컴포넌트 def 인덱스
// @returns      Blueprint: (store, rootPaths) => Instance { nodes, regions }
const compileDef = (
  module,
  compId,
  resources = [],
  loadedHrefs = new Set(),
) => {
  const def = module.defs[compId];
  if (!def) {
    throw new Error("bad component " + compId);
  }
  // code는 전체 module.code를 그대로 쓰고 pc는 절대 오프셋으로 다룬다 - def·자식 구간마다
  // subarray 뷰를 새로 할당하지 않는다(자식 RENDER가 많으면 그 할당이 누적된다).

  return (store, rootPaths, handlers = {}) => {
    // 인스턴스 불변 상태 - 모든 build(최초·lazy)가 공유한다.
    // 루트도 region(균일성): swap 없는 단일 가지지만, anchor·branch.nodes를 자식과 똑같이 갖춰
    // attachBranch가 분기 없이 처리한다. 루트 anchor 주석은 인스턴스 노드의 맨 앞에 선다.
    const regions = []; // append만, 인덱스 영구 안정. appendRegion이 새 region을 더한다.
    // 만들어진 컨텍스트 저장소. EnterContext마다 { name, fields }를 append하고 그 인덱스를
    // activeContexts에 싣는다. fields는 그 시점 paths로 푼 leafIndex라 인스턴스마다 달라 공유
    // 안 됨. 지금은 append만(회수는 @for+leafIndex 회수 때 - ISSUES).
    const createdContexts = [];
    const rootRegion = regions[appendRegion(regions, -1)]; // 루트도 region(인덱스 0)
    rootRegion.branches[THEN_INDEX].built = true; // 루트 then은 즉시 build됨(아래 interpret)
    rootRegion.shownIndex = THEN_INDEX;

    // 한 가지(startPc~endPc)를 build한다 - 노드는 fragment로 반환, 구독은 해당 가지에 쌓는다.
    //
    // 재진입 가능: 최초 인스턴스화는 루트 전체를, lazy build는 swap으로 처음 켜지는 가지 범위만
    // 해석한다. 자식 IF는 활성 가지를 재귀로 즉시 build하고 비활성 가지엔 lazyBuild만 심는다.
    // RENDER는 자식 def 구간을 자식 paths로 이 함수에 재진입해 인라인 합성한다(별도 인스턴스/
    // 루트 region 없이 부모 가지 안에 합류).
    //
    // @param code             해석할 바이트코드(자식은 자식 def 구간)
    // @param paths            offset → store 경로 매핑(자식은 자식 paths)
    // @param events           현재 def의 이벤트 테이블(BIND_EVENT가 event_idx로 참조. 자식은 자식 def의 것)
    // @param contexts         현재 def의 컨텍스트 테이블(ENTER_CONTEXT가 context_index로 참조. 자식은 자식 def의 것)
    // @param activeContexts   지금 감싼 @with 컨텍스트 누적([{ name, fields }]). RENDER가 자식에 물려준다.
    // @param startPc, endPc   해석 범위(endPc는 IF_END 직전)
    // @param startRegionIndex 구독을 쌓을 region
    // @param startBranchIndex 구독을 쌓을 가지(THEN/ELSE)
    // @param pathPrefix       이벤트 fullname의 누적 경로(루트 ""). RENDER가 자식 type-name을 잇는다.
    // @returns                직속 노드를 담은 DocumentFragment
    const interpret = (
      code,
      paths,
      events,
      contexts,
      activeContexts,
      startPc,
      endPc,
      startRegionIndex,
      startBranchIndex,
      pathPrefix,
    ) => {
      const fragment = document.createDocumentFragment();
      const nodeStack = [fragment]; // 노드 스택 - DOM 부모 추적
      let pending = null;
      let args = [];
      let segment = null; // 다음 RENDER가 소비할 경로 세그먼트(PUSH_PATH_SEGMENT가 적재)
      let pc = startPc;

      // 이 interpret이 채우는 가지. 한 호출 = 한 가지라 불변(중첩 if는 재귀 호출이 자식 가지를
      // 새 컨텍스트로 받는다 - JS 호출 스택이 옛 region/branch 스택 역할을 대신한다).
      const branch = regions[startRegionIndex].branches[startBranchIndex];

      const u16at = () => {
        const v = code[pc] | (code[pc + 1] << 8);
        pc += 2;
        return v;
      };
      const nodeTop = () => nodeStack[nodeStack.length - 1];

      // offset을 leafIndex로 해석(지연)하고 초기값을 돌려준다.
      //
      // 구독은 즉시 걸지 않고 현재 가지에 모은다 - activateBranch가 그 가지를 켤 때 건다
      // (안 보이는 가지는 구독 0).
      //
      // @param offset 컴포넌트 로컬 offset(flat 슬롯 paths[2*offset]/[2*offset+1]로 해석)
      // @param update 값 변경 시 호출될 콜백(가지 활성화 후 구독으로 연결)
      // @returns      현재 값(없으면 "")
      const bindVar = (offset, update) => {
        const ref = paths[2 * offset + 1];
        if (paths[2 * offset] === CONST) {
          // 상수: 상수풀 직접 참조. 안 변하니 구독은 죽은 구독 - 스킵한다.
          return module.pool[ref] ?? "";
        }
        const leafIndex = store.leafOf(ref);
        const initial = store.get(leafIndex) ?? "";
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
            // 리소스 로드 - resId의 URL로 <link>를 document.head에 삽입. 이미 삽입한 href는
            // 스킵(한 compile의 여러 컴포넌트·인스턴스가 같은 리소스를 써도 한 번만). 삽입한 href를
            // loadedHrefs(compile 단위)로 기억해 매번 head를 querySelector로 훑지 않는다
            // (인스턴스가 많으면 그 비용이 지배적). dedup 범위가 compile이라 새 렌더 세션은 깨끗하다.
            const url = resources[u16at()];
            if (url && !loadedHrefs.has(url)) {
              loadedHrefs.add(url);
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
          case OP.BIND_EVENT: {
            // 지금 여는 요소(pending)에 리스너를 단다. event_type=DOM 이벤트, event_idx=이 def의 이벤트.
            const domEvent = DOM_EVENTS[u16at()];
            const event = events[u16at()];
            const eventName = module.pool[event.nameConstIndex];
            // fullname = 합성 경로 + 로컬 이벤트명(누가 쐈나). 바인딩 시점에 불변이라 콜백 밖에서
            // 한 번 짓는다(루트는 prefix가 비어 로컬명 그대로 - 기존 동작과 호환).
            const fullName = pathPrefix
              ? pathPrefix + "." + eventName
              : eventName;
            // fields의 leaf를 flat 값-소스로 미리 푼다(바인딩 때 1회, paths 불변). steps(조립
            // 구조)는 발생 때 lazy 컴파일. 스칼라 field는 leaf 하나, 객체는 leaf 여럿(깊이우선).
            const payload = event.fields.map((field) => ({
              name: module.pool[field.nameConstIndex],
              typeRef: field.typeRef,
              sources: leavesToSources(field.leaves, paths, store),
            }));
            // props: 핸들러의 set/get 대상(필드명 -> leafIndex). 스칼라 field 중 STORE만 - 상수
            // 슬롯은 불변이라 set 대상이 못 된다. 객체의 set 의미는 미정(ISSUES). data(읽기)는
            // 객체까지 조립된다.
            const props = {};
            for (const p of payload) {
              if (
                module.types[p.typeRef].tag === "scalar" &&
                p.sources[0] === STORE
              ) {
                props[p.name] = p.sources[1];
              }
            }
            // 지금 활성인 컨텍스트들을 context명 -> (필드명 -> leafIndex)로 묶는다(바인딩 시점 고정).
            // 같은 이름은 뒤(안쪽)가 덮는다 - activeContexts 순서대로 돌아 안쪽이 마지막에 쓰인다.
            const contextLeaves = {};
            for (const i of activeContexts) {
              const created = createdContexts[i];
              contextLeaves[created.name] = created.fields;
            }
            const el = pending;
            el.addEventListener(domEvent, (domEventObject) => {
              // 위임 리스너는 자기 선에서 버블을 끊는다(디폴트). fullname은 박힌 위치 하나로
              // 디스패치되며, 조상 요소의 같은 DOM 이벤트 위임으로 새지 않는다. 끄는 옵션은 미정.
              domEventObject.stopPropagation();
              // data: 발생 시점 조립값. 스칼라면 값, 객체면 중첩 객체(steps는 여기서 lazy 컴파일).
              const data = {};
              for (const p of payload) {
                data[p.name] = assemble(
                  compiledStepsOf(module, p.typeRef),
                  p.sources,
                  store,
                  module,
                );
              }
              // context: 발생 시점 조립값. context.<이름>.<필드> = 조립값(스칼라/객체). payload와 동형.
              const context = {};
              for (const ctxName in contextLeaves) {
                const values = {};
                for (const p of contextLeaves[ctxName]) {
                  values[p.name] = assemble(
                    compiledStepsOf(module, p.typeRef),
                    p.sources,
                    store,
                    module,
                  );
                }
                context[ctxName] = values;
              }
              handlers[fullName]?.(data, {
                event: domEventObject,
                set: store.set,
                get: store.get,
                props,
                context,
              });
            });
            break;
          }
          case OP.ELEM_CLOSE_OPEN: {
            nodeTop().appendChild(pending);
            nodeStack.push(pending);
            pending = null;
            break;
          }
          case OP.TEXT: {
            nodeTop().appendChild(
              document.createTextNode(module.pool[u16at()]),
            );
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
            // 부모 슬롯 하나를 자식에게 넘긴다. 부모 슬롯의 (해석방법, 참조)를 그대로 전파해
            // kind를 보존한다 - 부모가 또 그 위에서 리터럴로 받은 CONST 슬롯도 그대로 아래로 흐른다.
            const parentOffset = u16at();
            if (paths[2 * parentOffset] === undefined) {
              throw new Error("no path for offset " + parentOffset);
            }
            args.push(paths[2 * parentOffset], paths[2 * parentOffset + 1]);
            break;
          }
          case OP.PUSH_ARG_LIT: {
            // 리터럴 인자(불변): 상수풀 인덱스를 CONST 슬롯으로 자식에 넘긴다. store에 심지
            // 않는다 - 소비 지점(bindVar)이 CONST를 보고 pool을 직접 읽고 구독을 스킵한다.
            args.push(CONST, u16at());
            break;
          }
          case OP.PUSH_PATH_SEGMENT: {
            // 다음 RENDER가 자식 경로 prefix에 이을 세그먼트(자식 type-name). 합성당 하나라
            // 단일 변수로 적재 - args(여럿 누적)와 달리 RENDER가 하나만 소비한다.
            segment = module.pool[u16at()];
            break;
          }
          case OP.ENTER_CONTEXT: {
            // @with 진입: 컨텍스트 def의 fields를 지금 paths로 leafIndex로 풀어 createdContexts에
            // 싣고, 그 인덱스를 activeContexts에 push. 발생 시점 BIND_EVENT가 이걸로 context를 짓는다.
            const contextDef = contexts[u16at()];
            const name = module.pool[contextDef.nameConstIndex];
            // payload와 같은 조립 준비 - leaf만 미리 풀고 steps는 조회 시 lazy. 발생 시 context 조립.
            const fields = contextDef.fields.map((field) => ({
              name: module.pool[field.nameConstIndex],
              typeRef: field.typeRef,
              sources: leavesToSources(field.leaves, paths, store),
            }));
            // 맥락은 같은 이름이 중복으로 쌓이지 않는 게 맞다(ISSUES). 일어나면 알리고, 가장
            // 안쪽이 이기도록 그냥 쌓는다(context 조립이 뒤(=안쪽) 것으로 덮는다).
            if (activeContexts.some((i) => createdContexts[i].name === name)) {
              console.warn(
                "quble: 컨텍스트 '" +
                  name +
                  "'가 중복 활성화됐습니다(안쪽이 우선).",
              );
            }
            activeContexts.push(createdContexts.length);
            createdContexts.push({ name, fields });
            break;
          }
          case OP.EXIT_CONTEXT: {
            // @with 블록 끝. 활성 스택에서만 빼고 createdContexts는 둔다(회수는 @for 때 - ISSUES).
            activeContexts.pop();
            break;
          }
          case OP.RENDER: {
            const childCompId = u16at();
            const childPaths = args;
            args = [];
            // 자식 경로 prefix = 부모 prefix + 세그먼트. 이벤트 fullname의 path 축을 누적한다.
            const childPrefix = pathPrefix
              ? pathPrefix + "." + segment
              : segment;
            segment = null;
            // 합성 = 인라인 재진입. 자식 def의 code 구간을 자식 paths로 같은 interpret에 돌린다.
            // 시작 가지 = 지금 이 가지(startRegionIndex/startBranchIndex) → 자식 IF는 이 가지의
            // childRegionIndices에 합류하고 같은 regions 배열에 append된다(인덱스 전역 유일).
            // 자식 루트 region 없음 - 자식 직속 노드는 fragment로 모여 RENDER 위치에 붙는다.
            const childDef = module.defs[childCompId];
            const childFragment = interpret(
              module.code,
              childPaths,
              childDef.events, // 자식 BIND_EVENT는 자식 def의 이벤트 테이블을 본다
              childDef.contexts, // 자식 ENTER_CONTEXT는 자식 def의 컨텍스트 테이블을 본다
              [...activeContexts], // 부모 활성 컨텍스트를 물려준다(자식이 부모 배열을 안 건드리게 복사)
              childDef.codeOff,
              childDef.codeOff + childDef.codeLen,
              startRegionIndex,
              startBranchIndex,
              childPrefix,
            );
            for (const node of childFragment.childNodes) {
              nodeTop().appendChild(node);
            }
            break;
          }
          case OP.IF: {
            const condOffset = u16at();
            // 조건 슬롯도 STORE/CONST 위임 처리. CONST(부모가 리터럴로 준 prop)는 값이 안
            // 변하니 leafIndex도 구독도 없다 - condLeafIndex=-1(region이 이 값을 읽지 않는다).
            const condIsConst = paths[2 * condOffset] === CONST;
            const condRef = paths[2 * condOffset + 1];
            const condLeafIndex = condIsConst ? -1 : store.leafOf(condRef);
            const regionIndex = appendRegion(regions, condLeafIndex);
            const region = regions[regionIndex];
            branch.childRegionIndices.push(regionIndex); // 부모(이 interpret의) 가지에 자식 등록
            const thenBranch = region.branches[THEN_INDEX];
            const elseBranch = region.branches[ELSE_INDEX];
            // anchor(if 자리 고정용 주석)는 appendRegion이 만들었다. 여기서 DOM 트리에 붙인다.
            nodeTop().appendChild(region.anchor);

            // then/else 코드 경계. thenStart = IF operand 직후(현재 pc).
            const thenStart = pc;
            const { thenEnd, elseStart, ifEndPc } = ifBranchRanges(
              code,
              thenStart,
            );

            // 각 가지를 build하는 클로저. 활성 가지는 지금 호출하고, 비활성 가지는 심어만 둔다.
            const buildThen = () => {
              const f = interpret(
                code,
                paths,
                events,
                contexts,
                activeContexts, // 가지는 같은 컨텍스트 범위 - 그대로 물려받는다
                thenStart,
                thenEnd,
                regionIndex,
                THEN_INDEX,
                pathPrefix, // 가지 안의 합성도 부모 경로를 물려받는다
              );
              thenBranch.nodes = Array.from(f.childNodes);
            };
            const buildElse = () => {
              const f =
                elseStart === -1
                  ? document.createDocumentFragment() // else 없는 if - 빈 가지
                  : interpret(
                      code,
                      paths,
                      events,
                      contexts,
                      activeContexts, // 가지는 같은 컨텍스트 범위 - 그대로 물려받는다
                      elseStart,
                      ifEndPc,
                      regionIndex,
                      ELSE_INDEX,
                      pathPrefix, // 가지 안의 합성도 부모 경로를 물려받는다
                    );
              elseBranch.nodes = Array.from(f.childNodes);
            };
            thenBranch.lazyBuild = buildThen;
            elseBranch.lazyBuild = buildElse;

            // cond 변경 시 해당 가지를 활성화(swap). 첫 활성화면 activateBranch가 lazyBuild 호출.
            // CONST 조건은 안 변하니 구독을 걸지 않는다(초기 가지로 고정).
            if (!condIsConst) {
              store.subscribe(condLeafIndex, (condValue) => {
                activateBranch(
                  store,
                  regions,
                  regionIndex,
                  condValue ? THEN_INDEX : ELSE_INDEX,
                );
              });
            }
            // build는 "생성만" 한다 - 활성 가지를 lazyBuild로 만들어 자식 branch.nodes에 담고
            // shownIndex만 설정한다. DOM 부착·구독 등록은 하지 않는다(attachBranch가 일괄).
            // 그래야 부모 fragment엔 anchor만 남아, 부모 branch.nodes가 자손까지 머금지 않는다.
            // (anchor는 평평한 형제라, 여기서 자식 노드를 붙이면 부모 nodes에 섞여 detach가 깨진다.)
            const condInitial = condIsConst
              ? module.pool[condRef]
              : store.get(condLeafIndex);
            const initialBranchIndex = condInitial ? THEN_INDEX : ELSE_INDEX;
            const initialBranch = region.branches[initialBranchIndex];
            initialBranch.lazyBuild();
            initialBranch.built = true;
            region.shownIndex = initialBranchIndex;

            pc = ifEndPc + 1; // IF_END 마커 소비 - if 블록 다음으로.
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
    // 루트 가지에 담긴다(자식 region 노드는 아직 안 붙음 - 부모 nodes 오염 방지). 그 뒤
    // attachBranch가 루트부터 재귀로 노드를 anchor 뒤에 끼우고 구독을 건다.
    // rootPaths는 외부 계약이라 path 문자열 배열(['label', …])로 받는다 - 루트 슬롯은
    // 정의상 전부 반응값(외부 데이터 바인딩)이라 kind가 늘 STORE다. flat은 런타임 내부
    // 표현이므로 이 경계에서 한 번 [STORE, path, STORE, path, …]로 감싼다.
    const rootFlat = [];
    for (const path of rootPaths) {
      rootFlat.push(STORE, path);
    }
    const fragment = interpret(
      module.code,
      rootFlat,
      def.events, // 루트 def의 이벤트 테이블
      def.contexts, // 루트 def의 컨텍스트 테이블
      [], // 루트는 활성 컨텍스트 없음
      def.codeOff,
      def.codeOff + def.codeLen,
      0,
      THEN_INDEX,
      "", // 루트 경로 prefix 비어 있음
    );
    rootRegion.branches[THEN_INDEX].nodes = Array.from(fragment.childNodes);
    fragment.prepend(rootRegion.anchor); // anchor를 루트 노드 앞에 - attach가 anchor.after로 채운다
    attachBranch(store, regions, rootRegion);
    // fragment 자식 전체(anchor + 붙은 트리)가 이 인스턴스의 루트 노드들(append 시 비워지므로 배열로).
    const nodes = Array.from(fragment.childNodes);
    return { nodes, regions };
  };
};

// ── 공개 API ─────────────────────────────────────────────────────────
// qubb 바이트를 디코드해 blueprintOf(compId)를 돌려준다.
//
// 사용: const blueprintOf = compile(bytes);
//       const inst = blueprintOf(0)(store, paths);
//       root.append(...inst.nodes);
//
// @param bytes  qubb 바이트
// @param resources resId -> URL 매핑(LOAD_RES가 <link>로 삽입). manifest.resources. 없으면 로드 생략.
// @returns      blueprintOf: (compId) => Blueprint
export const compile = (bytes, resources = []) => {
  const module = decode(bytes);
  // LOAD_RES dedup 집합은 compile 단위 - 이 compile에서 나온 모든 blueprint·인스턴스가 공유하되,
  // 다른 compile(다른 렌더 세션)은 깨끗한 Set으로 시작한다.
  const loadedHrefs = new Set();
  return (compId) => compileDef(module, compId, resources, loadedHrefs);
};
