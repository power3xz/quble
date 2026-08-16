// Quble 클라이언트 런타임 본체 - .qubb를 두 단계로 인스턴스화한다.
//
//   compile(bytes)  -> blueprintOf(compId) => Blueprint  (def를 청사진으로)
//   Blueprint(store, argumentSourcePairs) -> Instance     (청사진 호출 = 인스턴스화. DOM/구독 생성)
//
// Blueprint는 호출 시 def 코드를 훑어 DOM/구독을 만든다. (미리-파싱 방식도 시도했으나, 인스턴스화
// 병목이 DOM API라 파싱 방식 차이는 측정 노이즈 수준 - 단순한 "호출 시 훑기"를 택했다.)
//
// Instance = { nodes, regionPool }. nodes는 루트 노드들(부착/추적용), regionPool는 이 인스턴스의 모든
// Region(@if swap / @for 회차 경계). 구독은 가지(Branch)에 모이고 attach가 켤 때 건다 - 안 보이는
// 가지는 구독 0이다(region 구조/동작은 region.ts). RENDER는 자식 def를 같은 interpret으로 인라인
// 재진입해, 자식 if가 부모와 같은 regionPool/가지에 합류한다(별도 인스턴스 없음).
//
// 값 소비 경로 (REACTIVITY.md #1~#3):
//   offset(컴포넌트 로컬) -> argumentSourcePairs 슬롯 [kind, ref] -> kind가 STORE면 ref가 leafIndex라
//   store.get, CONST면 module.constpool[ref] 직접.

type TDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

// 숫자 한 자리 이상 (재귀)
type TDigitString = `${TDigit}` | `${TDigit}${TDigit}`;

type TIndexSymbol = `$${TDigitString}`;

import { createLeafStoreSubject, type LeafStoreSubject as TLeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import {
  activateIf,
  appendArrayInfo,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  attachForIteration,
  ELSE_INDEX,
  freeArrayInfo,
  removeBranchAt,
  type TArrayInfo,
  type TBranch,
  THEN_INDEX,
  type TRegion,
  truncateFor,
} from "./region.ts";

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
  "em",
  "b",
  "strong",
  "i",
  "small",
  "code",
  "pre",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "ol",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "form",
  "textarea",
  "select",
  "option",
  "figure",
  "figcaption",
  "time",
  "blockquote",
  "video",
  "audio",
  "canvas",
] as const;
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
  "for",
  "disabled",
  "checked",
  "readonly",
  "required",
  "rel",
  "target",
  "width",
  "height",
  "colspan",
  "rowspan",
  "role",
  "tabindex",
  "datetime",
  "controls",
] as const;
// 전역 DOM 이벤트 테이블(BYTECODE.md #2). BIND_EVENT의 event_type. Rust dom_events.rs와 동일 순서.
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
] as const;

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
  PUSH_THROUGH: 0x0b,
  IF: 0x0c,
  ELSE: 0x0d,
  IF_END: 0x0e,
  LOAD_RES: 0x0f,
  BIND_EVENT: 0x10,
  PUSH_ARG_LIT: 0x11,
  PUSH_PATH_SEGMENT: 0x12,
  ENTER_CONTEXT: 0x13,
  EXIT_CONTEXT: 0x14,
  FOR_RAW: 0x15,
  FOR_COUNT_VAR: 0x16,
  FOR_END: 0x17,
  PUSH_PATH_INDEX_SEGMENT: 0x18,
  PUSH_FIELD: 0x19,
  FOR_ARRAY_VAR: 0x1a,
  PUSH_SLOT_PLACEHOLDER_CONTENT: 0x1b,
  SLOT_PLACEHOLDER_CONTENT_END: 0x1c,
  FILL_SLOT_PLACEHOLDER: 0x1d,
} as const;

// opcode의 operand 바이트 수를 돌려준다.
//
// skipBranch가 op 경계를 짚어 마커(IF/ELSE/IF_END)를 operand 값과 혼동하지 않게 한다.
// (SSR renderer operand_len과 동일.)
//
// @param op opcode 바이트
// @returns  operand 바이트 수(0/2/4)
const operandLen = (op: number) => {
  switch (op) {
    case OP.HALT:
    case OP.ELEM_CLOSE_OPEN:
    case OP.ELEM_END:
    case OP.ELSE:
    case OP.IF_END:
    case OP.EXIT_CONTEXT:
    case OP.FOR_END:
    case OP.SLOT_PLACEHOLDER_CONTENT_END:
      return 0;
    case OP.PUSH_THROUGH: // scope_index: u8
      return 1;
    case OP.ELEM_OPEN:
    case OP.TEXT:
    case OP.TEXT_VAR: // scope_index: u8, offset: u8
    case OP.RENDER:
    case OP.PUSH_FIELD: // scope_index: u8, offset: u8
    case OP.PUSH_ARG_LIT:
    case OP.PUSH_PATH_SEGMENT:
    case OP.IF: // scope_index: u8, offset: u8
    case OP.LOAD_RES:
    case OP.ENTER_CONTEXT:
    case OP.FOR_RAW:
    case OP.FOR_COUNT_VAR: // scope_index: u8, offset: u8
    case OP.FOR_ARRAY_VAR: // scope_index: u8, offset: u8
    case OP.PUSH_PATH_INDEX_SEGMENT:
    case OP.PUSH_SLOT_PLACEHOLDER_CONTENT:
    case OP.FILL_SLOT_PLACEHOLDER:
      return 2;
    case OP.ATTR_G:
    case OP.ATTR_L:
    case OP.ATTR_G_VAR: // name: u16, scope_index: u8, offset: u8
    case OP.ATTR_L_VAR: // name: u16, scope_index: u8, offset: u8
    case OP.BIND_EVENT:
      return 4;
    default:
      throw new Error(`bad opcode 0x${op.toString(16)}`);
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
const skipBranch = (code: Uint8Array, startPc: number) => {
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

// @for 몸체 끝(FOR_END)의 pc를 찾는다.
//
//   FOR op | operand | 몸체 ......... | FOR_END
//                    ^bodyStart      ^반환 pc(호출자가 마커 소비)
//
// bodyStart부터 op 경계를 전진하며 중첩 @for 깊이를 센다(같은 깊이 0의 FOR_END가 이 몸체 끝).
// IF는 몸체 안에 섞여도 무시 - @for 여는 opcode와 FOR_END만 깊이에 관여한다.
const forBodyEnd = (code: Uint8Array, bodyStart: number) => {
  let pc = bodyStart;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    if (op === OP.FOR_RAW || op === OP.FOR_COUNT_VAR || op === OP.FOR_ARRAY_VAR) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP.FOR_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else {
      pc += operandLen(op);
    }
  }
  throw new Error("unbalanced @for - no matching FOR_END");
};

// 슬롯 콘텐츠 구간 끝(SLOT_PLACEHOLDER_CONTENT_END)의 pc를 찾는다.
//
//   PUSH_SLOT_PLACEHOLDER_CONTENT | idx | 콘텐츠 ........ | SLOT_PLACEHOLDER_CONTENT_END
//                                       ^contentStart    ^반환 pc(호출자가 마커 소비)
//
// 콘텐츠 안에서 또 합성하며 슬롯을 채울 수 있어 깊이를 센다. IF/@for는 자기 마커로 닫히므로
// 여기 깊이에 관여하지 않는다.
const slotPlaceholderContentEnd = (code: Uint8Array, contentStart: number) => {
  let pc = contentStart;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    if (op === OP.PUSH_SLOT_PLACEHOLDER_CONTENT) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP.SLOT_PLACEHOLDER_CONTENT_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else {
      pc += operandLen(op);
    }
  }
  throw new Error("unbalanced slot content - no matching SLOT_PLACEHOLDER_CONTENT_END");
};

// IF 블록의 if/else 몸체 코드 경계를 구한다(순수 - code와 if 몸체 시작 pc만 본다).
//
//   IF operand | if 몸체 ... | ELSE | else 몸체 ... | IF_END
//              ^ifBodyStart  ^ifBodyEnd             ^ifEndPc
//                                   ^elseBodyStart
//
// else 없으면 elseBodyStart = -1이고 ifBodyEnd === ifEndPc === IF_END 위치.
// 마커는 skipBranch로 찾고 호출자가 소비한다.
const ifBranchRanges = (code: Uint8Array, ifBodyStart: number) => {
  const ifBodyEnd = skipBranch(code, ifBodyStart); // ELSE 또는 IF_END
  if (code[ifBodyEnd] === OP.ELSE) {
    const elseBodyStart = ifBodyEnd + 1;
    return { ifBodyEnd, elseBodyStart, ifEndPc: skipBranch(code, elseBodyStart) };
  }
  return { ifBodyEnd, elseBodyStart: -1, ifEndPc: ifBodyEnd }; // else 없는 if
};

// ── 디코드 (core/BYTECODE.md 포맷) ───────────────────────────────────
class Reader {
  bytes: Uint8Array;
  pos: number;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.pos = 0;
  }
  take(n: number) {
    const subarray = this.bytes.subarray(this.pos, this.pos + n);
    if (subarray.length !== n) {
      throw new Error("unexpected eof");
    }
    this.pos += n;
    return subarray;
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
    throw new Error(`bad const tag ${tag}`);
  }
}

// 슬롯 해석방법. argumentSourcePairs는 (해석방법, 참조) 쌍을 인터리브로 담는다 - 슬롯 offset은
// argumentSourcePairs[2*offset](해석방법) / argumentSourcePairs[2*offset+1](참조)로 읽는다. STORE는 참조가 store
// leafIndex(반응값, 구독), CONST는 참조가 상수풀 인덱스(불변, 구독 스킵), RAW는 참조가 값 자체
// (count @for의 회차 인덱스 - store에 안 앉는 회차 상수, 구독 스킵).
const STORE = 0;
const CONST = 1;
const RAW = 2;

// 스코프 - (kind, ref) 쌍을 인터리브로 담은 평탄 배열.
//
//   [ kind0, ref0 | kind1, ref1 | ... ]      슬롯 o -> [2o]=kind, [2o+1]=ref
//     +-- 슬롯 0 --+  +-- 슬롯 1 --+
type TScope = number[];

const slotKind = (scope: TScope, o: number): number => scope[2 * o];
const slotRef = (scope: TScope, o: number): number => scope[2 * o + 1];

// 바이트코드를 훑어(walk) 내려가며 누적되는 가변 스택 묶음 - interpret 재진입마다 함께 흐른다.
// @for 회차/RENDER 재진입은 같은 walkStacks를 이어 쓰고(push/pop 공유), 지연 실행(@if lazyBuild/@for grow)만
// build 시점 상태를 snapshotStacks로 딥카피해 캡처한다 - 지연 시점엔 원본 스택이 이미 pop돼 있어,
// 카피 없이는 회차 인덱스($n)/컨텍스트를 잃는다.
// (pathPrefix/loopIndexBase는 불변 값이라 여기 안 담고 파라미터로 흐른다 - 클로저가 값을 캡처.
//  argumentSourcePairs도 가변(같은 push/pop 성질)이라 지연 실행은 pairs까지 딥카피한다 - 단
//  RENDER마다 새 배열로 교체되는 다른 생애라 여기 안 묶고 나란히 흐른다.)
//   loopIndexStack: @for 회차 인덱스 소스 누적(인터리브 kind,ref). buildIteration이 push/pop.
//   activeContexts: @with 컨텍스트 누적(createdContexts 인덱스). ENTER/EXIT_CONTEXT가 push/pop.
type TWalkStacks = {
  loopIndexStack: number[];
  activeContexts: number[];
};

// 사용쪽이 RENDER 앞에 깔아둔 슬롯 콘텐츠 한 덩이. 코드 구간은 부모 def 안에 있고 해석
// 컨텍스트도 부모 것을 그대로 들고 간다 - 실행은 자식의 FILL_SLOT_PLACEHOLDER 자리에서 하지만
// 보간/이벤트 경로는 콘텐츠를 쓴 곳(부모) 기준이다(SYNTAX #3.3).
// argumentSourcePairs/walkStacks는 카피 - 이 구조체가 담는 건 "이 자리에서 본 부모 컨텍스트"라
// 값이어야 한다. 가변 배열을 참조로 들면 부모가 이후 push/pop한 상태가 비쳐 들어와, 담은 것이
// 그 시점의 컨텍스트가 아니게 된다. 지금은 실행이 pop 전(즉시)이거나 이미 카피본 위(@if
// lazyBuild)라 참조로도 값이 같지만, 그건 호출 경로가 우연히 그런 것이고 이 값의 계약이 아니다.
type TSlotPlaceholderContent = {
  startPc: number;
  endPc: number;
  argumentSourcePairs: TScope;
  compId: number;
  pathPrefix: string;
  loopIndexBase: number;
  walkStacks: TWalkStacks;
  branchIndex: number; // 구독이 쌓일 가지 = 콘텐츠를 쓴 부모 가지
};

// lazyBuild(@if 비활성 가지)에 넘길 스냅샷 - 가변 스택을 딥카피해 build 후 원본이 pop돼도
// 지연 실행이 build 시점 상태를 본다.
const snapshotStacks = (walkStacks: TWalkStacks): TWalkStacks => ({
  loopIndexStack: [...walkStacks.loopIndexStack],
  activeContexts: [...walkStacks.activeContexts],
});

// FieldValue ref 출처 태그(Rust serialize <REF>와 대칭). ref마다 태그 1바이트 + payload.
// 슬롯 해석방법(STORE/CONST)과 다른 층이다 - Scope 슬롯의 실제 kind는 argumentSourcePairs가 정한다.
const FV_SCOPE = 0;
const FV_CONST = 1;
const FV_RAW = 2;

// 타입 테이블 엔트리 태그(BYTECODE.md #4). Rust read_type 대칭.
const TYPE_SCALAR = 0;
const TYPE_OBJECT = 1;
const TYPE_ARRAY = 2;

// 타입 테이블 엔트리 하나를 읽는다. Scalar는 payload 없음, Object는 field_count +
// [(nameConstIndex, typeRef)], Array는 elem_type_ref. typeRef로 자식을 가리켜 중첩/공유(Rust put_type 대칭).
//
// @param r Reader
// @returns { tag: "scalar" } | { tag: "object", fields } | { tag: "array", elemTypeRef }
type TType = { tag: "scalar" } | { tag: "object"; fields: TField[] } | { tag: "array"; elemTypeRef: number };
type TField = [number, number];
const readType = (reader: Reader): TType => {
  const tag = reader.u8();
  if (tag === TYPE_SCALAR) {
    return { tag: "scalar" };
  }
  if (tag === TYPE_OBJECT) {
    const count = reader.u16();
    const fields: TField[] = [];
    for (let i = 0; i < count; i++) {
      fields.push([reader.u16(), reader.u16()]);
    }
    return { tag: "object", fields };
  }
  if (tag === TYPE_ARRAY) {
    return { tag: "array", elemTypeRef: reader.u16() };
  }
  throw new Error(`bad type tag ${tag}`);
};

// field ref 하나를 읽는다 - 태그 1바이트 + payload(Rust read_ref 대칭). Scope는 부모 슬롯
// 위치(scopeIndex, offset), Const/Raw는 값 하나(u16). offset은 Scope만 의미 있어 나머진 0.
//
// @param r Reader
// @returns { kind, ref, offset } - ref: Scope=scopeIndex/Const=상수풀 인덱스/Raw=값
const readRef = (reader: Reader): TRef => {
  const tag = reader.u8();
  if (tag === FV_SCOPE) {
    return { kind: FV_SCOPE, ref: reader.u8(), offset: reader.u8() };
  }
  if (tag === FV_CONST) {
    return { kind: FV_CONST, ref: reader.u16(), offset: 0 };
  }
  if (tag === FV_RAW) {
    return { kind: FV_RAW, ref: reader.u16(), offset: 0 };
  }
  throw new Error(`bad ref tag ${tag}`);
};

// 필드 목록을 읽는다 - field_count, [(nameConstIndex, typeRef, ref)]. 이벤트 payload와
// 컨텍스트가 같은 인코딩(Rust read_fields 대칭). 슬롯을 안 펼쳐 field당 ref 하나.
//
// @param r Reader
// @returns [{ nameConstIndex, typeRef, ref }]
const readFields = (reader: Reader): TFieldEntry[] => {
  const count = reader.u16();
  const fields: TFieldEntry[] = [];
  for (let i = 0; i < count; i++) {
    const nameConstIndex = reader.u16();
    const typeRef = reader.u16();
    const ref = readRef(reader);
    fields.push({ nameConstIndex, typeRef, ref });
  }
  return fields;
};

// field ref 하나를 assemble이 커서로 소비할 [kind, ref, ...] 열로 푼다(바인딩 때 1회). 한 field는
// 단일 출처다 - 리터럴이면 CONST 쌍 하나, 변수면 그 슬롯의 kind. 객체 변수는 store에 연속으로
// 깔려(base부터 재귀적으로 이어짐) base+offset부터 leaf 개수만큼 STORE 쌍으로 펼친다. leaf
// 개수 = steps의 STEP_LEAF 수. assemble이 이 열을 steps 따라 소비해 (중첩) 객체를 조립한다.
//
// @param ref       field.ref
// @param leafCount  field.typeRef의 leaf 칸 수(객체를 몇 칸 펼칠지)
// @param argumentSourcePairs flat 슬롯 배열
// @returns          [kind, ref, ...] 열
type TRef = { kind: number; ref: number; offset: number };
const refToSourcePairs = (ref: TRef, leafCount: number, scope: TScope): number[] => {
  if (ref.kind === FV_CONST) {
    return [CONST, ref.ref];
  }
  if (ref.kind === FV_RAW) {
    throw new Error("FV_RAW는 아직 미구현(@for)");
  }
  // FV_SCOPE - 슬롯의 kind를 물려받는다. CONST 슬롯(부모가 리터럴로 준 prop)은 상수 하나.
  const kind = slotKind(scope, ref.ref);
  const slotBase = slotRef(scope, ref.ref);
  if (kind === CONST) {
    return [CONST, slotBase];
  }
  // STORE 슬롯 - base(slotRef+offset)부터 leaf 개수만큼 연속 칸을 STORE 쌍으로 펼친다.
  const base = slotBase + ref.offset;
  const pairs: number[] = [];
  for (let i = 0; i < leafCount; i++) {
    pairs.push(STORE, base + i);
  }
  return pairs;
};

// 조립 step - 런타임 내부 미니 명령(바이트코드 opcode와 다른 층). type_ref 구조를 평탄한 step
// 열로 컴파일해두고, assemble이 그 열을 반복 실행해 중첩 객체를 짓는다(재귀/트리순회 없음).
//   STEP_ENTER key : 새 객체를 만들어 부모[key]에 걸고 내려간다
//   STEP_LEAF  key : 부모[key] = 다음 leaf 값
//   STEP_EXIT      : 부모로 돌아온다
//   STEP_ARRAY key : 부모[key] = 배열. source 한 쌍(arrayInfoIndex 슬롯)을 소비해 요소 위치를
//                    얻고, 요소 타입 step을 요소마다 그 base에서 재적용한다(요소 수는 런타임 동적).
const STEP_ENTER = 0;
const STEP_LEAF = 1;
const STEP_EXIT = 2;
const STEP_ARRAY = 3;

// type_ref 구조를 조립 step 열로 컴파일한다(type_ref별 1회, dedup되니 공유 가능). 명시적 스택
// 반복이라 깊은 타입에도 콜스택 안전. leaf 자리엔 인덱스를 안 박고 STEP_LEAF로 "다음 leaf 소비"만
// 표시 - 실제 leaf는 assemble이 leafIndices를 커서로 소비한다(구조=step, 인스턴스=leafIndices).
//
// @param types   타입 테이블
// @param typeRef 시작 타입
// @param constpool 상수풀(필드명 해석)
// @returns       [[STEP_*, key, elemSteps?]] 평탄 열. 루트 key=null. STEP_ARRAY만 elemSteps(요소
//                타입 step 열)를 셋째로 싣는다 - 요소는 store 끝 별도 base에 살아 인라인이 안 되므로.
type TStep = [number, string | null, TStep[]?];
const compileType = (types: TType[], typeRef: number, constpool: (string | number | boolean)[]): TStep[] => {
  const steps: TStep[] = [];
  // 한 노드로 내려간다: 스칼라면 LEAF 하나로 끝, 객체면 ENTER를 내고 남은 자식 큐를 돌려준다.
  // 프레임은 "열어둔 객체의 아직 처리 안 한 자식들" - 이 큐만 상태로 든다(플래그 없음).
  const enter = (ref: number, key: string | null) => {
    const t = types[ref];
    if (t.tag === "scalar") {
      steps.push([STEP_LEAF, key]);
      return null;
    }
    if (t.tag === "array") {
      // 배열 칸은 source 한 쌍(arrayInfoIndex 슬롯)뿐 - 요소 수는 런타임에만 안다. 요소 타입 step을
      // 셋째에 실어(요소 1벌 구조) assemble이 요소마다 그 base에서 재적용한다. leaf처럼 소비 끝(null).
      steps.push([STEP_ARRAY, key, compileType(types, t.elemTypeRef, constpool)]);
      return null;
    }
    steps.push([STEP_ENTER, key]);
    return t.fields.map(([nameConst, childRef]: TField): [string, number] => [
      constpool[nameConst] as string,
      childRef,
    ]);
  };

  const rootRemaining = enter(typeRef, null);
  if (rootRemaining === null) {
    return steps; // 루트가 스칼라면 STEP_LEAF 하나뿐
  }
  const stack = [rootRemaining];
  while (stack.length) {
    const remaining = stack[stack.length - 1];
    if (remaining.length === 0) {
      steps.push([STEP_EXIT, null]); // 자식 다 처리 -> 이 객체 닫음
      stack.pop();
      continue;
    }
    // 다음 자식으로 내려간다(깊이우선). 객체면 즉시 top이 되어 걔부터 파고든다 - 순서 안 밀림.
    // biome-ignore lint/style/noNonNullAssertion: length===0은 위에서 continue - 여기 도달하면 remaining은 비어있지 않음
    const [key, childRef] = remaining.shift()!;
    const childRemaining = enter(childRef, key);
    if (childRemaining !== null) {
      stack.push(childRemaining);
    }
  }
  return steps;
};

// 조립 step 열을 실행해 값을 만든다(발생 시점). sources를 (kind, ref) 쌍 커서로 소비하며
// STEP_LEAF에서 STORE면 store.get, CONST면 constpool 직접. 루트가 스칼라(step이 STEP_LEAF 하나)면
// 객체로 감싸지 않고 값을 그대로 반환한다.
//
// @param steps   compileType 결과
// @param fieldSourcePairs 이 field의 flat 값-소스 [kind, ref, ...](깊이우선, step의 LEAF 순서와 일치)

const assemble = (
  steps: TStep[],
  fieldSourcePairs: number[],
  store: TLeafStoreSubject,
  module: TModule,
  arrayPool: Pool<TArrayInfo>,
): unknown => {
  let cursor = 0;
  const root: Record<string, unknown> = {};
  const stack: Record<string, unknown>[] = [root];
  for (const [step, key, elemSteps] of steps) {
    const top = stack[stack.length - 1];
    if (step === STEP_LEAF) {
      const kind = fieldSourcePairs[cursor++];
      const ref = fieldSourcePairs[cursor++];
      const value = kind === CONST ? module.constpool[ref] : store.get(ref);
      if (key === null) {
        return value; // 루트가 스칼라 - 객체로 안 감싼다
      }
      top[key] = value;
    } else if (step === STEP_ARRAY) {
      // source 한 쌍(arrayInfoIndex 슬롯)을 소비. 배열은 컴파일러가 Scope(STORE)로만 싣는다.
      cursor++; // kind(STORE) 건너뜀
      const arrayInfoIndex = store.get(fieldSourcePairs[cursor++]) as number;
      const info = arrayPool.entries[arrayInfoIndex];
      // 요소마다 base(elemStartLeafIndices[i])부터 elemSize칸 연속을 STORE 쌍으로 펴 재조립한다.
      const arr: unknown[] = info.elemStartLeafIndices.map((base) => {
        const elemPairs: number[] = [];
        for (let i = 0; i < info.elemSize; i++) {
          elemPairs.push(STORE, base + i);
        }
        // biome-ignore lint/style/noNonNullAssertion: STEP_ARRAY는 compileType에서 항상 elemSteps를 싣는다
        return assemble(elemSteps!, elemPairs, store, module, arrayPool);
      });
      if (key === null) {
        return arr; // 루트가 배열 - 객체로 안 감싼다
      }
      top[key] = arr;
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
const compiledStepsOf = (module: TModule, typeRef: number) => {
  if (module.compiledSteps[typeRef] === undefined) {
    module.compiledSteps[typeRef] = compileType(module.types, typeRef, module.constpool);
  }
  return module.compiledSteps[typeRef];
};

// type_ref가 store에서 차지하는 leaf 칸 수(스칼라 1, 객체 필드 합). Rust store_size의 JS판.
// 재귀가 leafCountOf를 다시 부르므로 만난 하위 type_ref도 같이 캐시된다(dedup 이점을 count까지).
const leafCountOf = (module: TModule, typeRef: number): number => {
  const cached = module.leafCounts[typeRef];
  if (cached !== undefined) {
    return cached;
  }
  const t = module.types[typeRef];
  let count = 1; // 스칼라, 배열(칸 하나에 arrayInfoIndex - 요소는 arrayPool/store 끝에 별도로 산다)
  if (t.tag === "object") {
    count = 0;
    for (const [, childTypeRef] of t.fields) {
      count += leafCountOf(module, childTypeRef);
    }
  }
  module.leafCounts[typeRef] = count;
  return count;
};

// 노드가 자기 위치를 들고 다니는 키(시작 칸, 그 칸부터의 타입) - setObject가 덮어쓸 고정 블록을
// 이 둘로 안다. 배열 노드는 NODE_BASE에 배열 칸 leafIndex를 싣는다(그 칸 값이 arrayInfoIndex라
// push/removeAt/setArray가 거기서 요소 목록에 닿는다). 심볼이라 값 키와 안 섞이고, Symbol.for라
// 런타임이 여러 벌 로드돼도 같은 키다.
const NODE_BASE = Symbol.for("quble.node.base");
const NODE_TYPE = Symbol.for("quble.node.typeRef");

// leafTree가 만든 객체 노드 - 필드는 잎(leafIndex)이거나 또 노드고, 자기 자리가 심볼로 얹혀 있다.
// d.ts가 핸들러에게 내는 TLeafObject<T>가 이것이다(그쪽은 브랜드만, 자리는 런타임 몫).
type TLeafObject = {
  [NODE_BASE]: number;
  [NODE_TYPE]: number;
  [field: string | symbol]: unknown;
};

// props 중첩 객체를 감싼다 - 없는 prop명을 문자열로 접근하면 즉시 throw. 핸들러는 우리 통제 밖의
// 자유 코드라(d.ts는 힌트일 뿐 강제 못 함), 오타/리터럴 바인딩(STORE 아님) prop을 만지면 조용히
// undefined로 새지 않고 여기서 잡는다. 심볼 키(Symbol.toPrimitive 등 JS 내부)와 존재 키는 통과.
// leafTree가 중첩 객체마다 감싸므로 props.item.typo도 안쪽 객체가 잡는다.
const propsGuard = <T extends Record<string | symbol, unknown>>(obj: T): T =>
  new Proxy(obj, {
    get(target, key) {
      if (typeof key === "symbol" || key in target) {
        return target[key];
      }
      throw new Error(`prop '${key}' 없음 - 오타이거나 리터럴 바인딩 prop(STORE만 접근 가능)`);
    },
  });

// 지연 심기 항목 - 만난 배열 하나(요소 심기는 고정부 뒤로 미룸 - plantRoot 레이아웃 참고). value는 원본 배열.
type TDeferredArray = { arrayInfoIndex: number; value: unknown; elemTypeRef: number };

// value를 typeRef의 "고정 칸"만 leaves에 연속 push하고, 만난 배열들을 반환한다 - 스칼라=값 한 칸,
// 배열=arrayInfoIndex 한 칸(요소는 안 심고 반환에 담아 나중에), 객체=필드 선언 순서 재귀. push 순서
// = leafIndex 순서라 이 값의 고정부가 끊김 없이 연속으로 앉아 base+offset이 성립한다. 반환된 배열들의
// 요소 심기는 호출자가 이 고정부 뒤에서 처리한다(plantRoot의 레벨 루프).
const plantFixed = (
  value: unknown,
  typeRef: number,
  module: TModule,
  leaves: unknown[],
  arrayPool: Pool<TArrayInfo>,
): TDeferredArray[] => {
  const t = module.types[typeRef];
  if (t.tag === "scalar") {
    leaves.push(value);
    return [];
  }
  if (t.tag === "array") {
    // 배열 칸 = arrayInfoIndex 하나. 요소 심기는 미룬다(고정부 연속 유지).
    const elemSize = leafCountOf(module, t.elemTypeRef);
    const arrayInfoIndex = appendArrayInfo(arrayPool, elemSize, t.elemTypeRef);
    leaves.push(arrayInfoIndex);
    return [{ arrayInfoIndex, value, elemTypeRef: t.elemTypeRef }];
  }
  const obj = value as Record<string, unknown> | undefined;
  const deferred: TDeferredArray[] = [];
  for (const [nameConstIndex, childTypeRef] of t.fields) {
    const key = module.constpool[nameConstIndex] as string;
    deferred.push(...plantFixed(obj?.[key], childTypeRef, module, leaves, arrayPool));
  }
  return deferred;
};

// 루트 props 타입(반드시 object)의 각 1뎁스 prop을 슬롯 하나로 보고, rootValue를 leaves에 펴며
// 각 prop의 base leafIndex를 모은다. 반환 leaves/arrayPool로 store/인스턴스를 채우고,
// rootFlat([STORE, base, ...])을 진입점 argumentSourcePairs로 쓴다. 루트 슬롯은 정의상 전부
// 외부 데이터 바인딩이라 kind가 늘 STORE.
//
// store 레이아웃 - 고정부 연속, 배열 요소는 뒤로(레벨 순):
//
//   [ 루트 고정부(prop들, 배열 칸=arrayInfoIndex) | 레벨0 배열들 요소 | 레벨1 ... ]
//     ^rootFlat의 base들이 여기를 가리킨다          ^elemStartLeafIndices가 가리킨다
//
// 요소 leaf가 고정 칸 사이에 끼면 뒤 필드 offset이 밀리므로, 고정부를 다 심은 뒤 요소를 끝에
// 레벨별로 몰아 심는다(중간 삽입 금지).
const plantRoot = (module: TModule, rootValue: unknown, arrayPool: Pool<TArrayInfo>) => {
  const rootType = module.types[module.defs[0].propsTypeRef];
  const leaves: unknown[] = [];
  const rootFlat: number[] = [];
  const obj = rootValue as Record<string, unknown> | undefined;

  // 루트 고정부를 먼저 심어(base가 고정 칸을 가리켜야 한다) 레벨 0 배열들을 얻는다.
  let pending: TDeferredArray[] = [];
  for (const [nameConstIndex, childTypeRef] of (rootType as { fields: TField[] }).fields) {
    rootFlat.push(STORE, leaves.length); // 이 prop 첫 고정 칸이 base
    const key = module.constpool[nameConstIndex] as string;
    pending.push(...plantFixed(obj?.[key], childTypeRef, module, leaves, arrayPool));
  }

  // 레벨별로 배열 요소를 store 끝에 심는다. 한 레벨의 형제 배열들 요소를 다 심어(연속) 그 안에서
  // 만난 다음 레벨 배열들을 next에 모으고, 빌 때까지 반복. for 경계가 다 고정이라 자라는 큐가 없다.
  while (pending.length) {
    const next: TDeferredArray[] = [];
    for (const { arrayInfoIndex, value, elemTypeRef } of pending) {
      const info = arrayPool.entries[arrayInfoIndex];
      const elems = Array.isArray(value) ? value : [];
      for (const elem of elems) {
        info.elemStartLeafIndices.push(leaves.length); // 이 요소 첫 leaf
        next.push(...plantFixed(elem, elemTypeRef, module, leaves, arrayPool));
      }
    }
    pending = next;
  }
  return { leaves, rootFlat };
};

// qubb 바이트를 TModule로 디코드한다(core/BYTECODE.md 포맷).
const decode = (bytes: Uint8Array) => {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (!(magic[0] === 0x51 && magic[1] === 0x42 && magic[2] === 0x4c && magic[3] === 0x00)) {
    throw new Error("bad magic"); // "QBL\0"
  }
  const version = r.u16();
  if (version !== 0) {
    throw new Error(`bad version ${version}`);
  }

  const poolCount = r.u16();
  const constpool = [];
  for (let i = 0; i < poolCount; i++) {
    constpool.push(r.constant());
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
    // 이 comp props를 묶은 Object 타입(types 인덱스). defs[0]이 진입점 풀필 구조.
    const propsTypeRef = r.u16();
    const codeOff = r.u32();
    const codeLen = r.u32();
    // 이벤트 테이블 (BYTECODE.md #4) - event_count, [(nameConstIndex, fields)]
    const eventCount = r.u16();
    const events = [];
    for (let i = 0; i < eventCount; i++) {
      events.push({ nameConstIndex: r.u16(), fields: readFields(r) });
    }
    // 컨텍스트 테이블 - context_count, [(nameConstIndex, fields)]. fields는 이벤트와 같은 인코딩.
    const contextCount = r.u16();
    const contexts = [];
    for (let i = 0; i < contextCount; i++) {
      contexts.push({ nameConstIndex: r.u16(), fields: readFields(r) });
    }
    // 표현식 테이블 - expr_count:u8, [(len:u8, code)]. IF_EXPR의 expr_index가 이 배열의 인덱스.
    const exprCount = r.u8();
    const exprs = [];
    for (let i = 0; i < exprCount; i++) {
      exprs.push(r.take(r.u8()));
    }
    defs.push({ nameConstIndex, propsTypeRef, codeOff, codeLen, events, contexts, exprs });
  }

  const codeLen = r.u32();
  const code = r.take(codeLen);
  // compiledSteps: type_ref -> 조립 step 열 캐시. 발생 시점에 lazy로 채운다(안 터지는 이벤트의
  // 타입은 컴파일 안 함 - lazy build 결). 같은 type_ref는 한 번만 컴파일(dedup 이점 유지).
  // leafCounts: type_ref -> leaf 칸 수 캐시(refToSourcePairs가 객체를 몇 칸 펼칠지).
  return { constpool, types, defs, code, compiledSteps: [], leafCounts: [] };
};
type TFieldEntry = { nameConstIndex: number; typeRef: number; ref: TRef };
type TEventEntry = { nameConstIndex: number; fields: TFieldEntry[] };
type TDef = {
  nameConstIndex: number;
  propsTypeRef: number;
  codeOff: number;
  codeLen: number;
  events: TEventEntry[];
  contexts: TEventEntry[];
  // 이 def가 쓰는 표현식들(후위 표기 바이트). IF_EXPR의 expr_index가 이 배열의 인덱스.
  exprs: Uint8Array[];
};
type TModule = {
  code: Uint8Array;
  constpool: (string | number | boolean)[];
  types: TType[];
  compiledSteps: TStep[][];
  leafCounts: number[];
  defs: TDef[];
};
// 발생 시점에 조립할 준비물(payload/컨텍스트 공용) - field.refs를 바인딩 때 flat sourcePairs로 미리 푼 것.
type TAssembled = { name: string; typeRef: number; fieldSourcePairs: number[] };
// ENTER_CONTEXT가 만든 컨텍스트 인스턴스. createdContexts에 append된다.
type TCreatedContext = { name: string; fields: TAssembled[] };
// 핸들러 맵(fullName -> 핸들러). 핸들러 인자 계약은 dispatchBinding이 조립해 넘긴다.
export type THandlers = Record<
  string,
  ((data: Record<string, unknown>, ctx: Record<string, unknown>) => void) | undefined
>;
// 한 element/DOM이벤트 타입의 발화 맥락. 인터프리터의 eventBindings에 심고, 그 인터프리터의
// 위임 리스너가 dispatch로 발화한다 - 인스턴스 상태(store/pool/handlers)는 소유자(인터프리터)의
// 것이라 여기 안 싣는다.
type TBinding = {
  fullName: string;
  payload: TAssembled[];
  contextLeaves: Record<string, TAssembled[]>;
  props: Record<string, unknown>;
  loopIndices: Partial<{ [key in TIndexSymbol]: { kind: number; ref: number } }>; // 회차 인덱스 소스(kind, ref) - 발화 시 store.get(STORE)/값(RAW)으로 해소
};

// ── 한 인스턴스의 인터프리터 ─────────────────────────────────────────
// 한 Blueprint 호출(인스턴스화)마다 하나. 인스턴스 불변 상태(store/각종 pool/module 등)를
// 필드로 들고, interpret으로 바이트코드를 훑어 DOM/구독을 짓는다. 호출마다 다른 값(code/pc/
// 가지 등)은 파라미터로 남기고, 인스턴스 내내 같은 값만 필드로 올린다.
class Interpreter {
  module: TModule;
  code: Uint8Array;
  handlers: THandlers;
  resources: string[];
  loadedHrefs: Set<unknown>;
  store: TLeafStoreSubject;
  arrayPool: Pool<TArrayInfo>;
  regionPool: Pool<TRegion>;
  branchPool: Pool<TBranch>;
  createdContexts: TCreatedContext[];
  // 진입점 argumentSourcePairs(plantRoot의 rootFlat). store(루트부터의 절대 경로) 접근에 쓴다 -
  // 어느 핸들러든 같은 루트라 인스턴스 전역. props(발화 comp 상대)와 달리 store는 defs[0] 기준.
  rootScope: TScope;

  // ── 이벤트 위임(인터프리터 격리) ──────────────────────────────────
  // element마다 addEventListener를 다는 대신(부하 시 리스너 클로저가 노드 수만큼 쌓인다),
  // element -> 발화 맥락을 eventBindings에 심고 document에 DOM 이벤트 타입별 위임 리스너를 단다.
  // 인터프리터는 서로 격리라 바인딩/리스너 모두 자기 것 - 리스너는 자기 eventBindings만 매칭하고,
  // 남의 element는 그냥 통과한다(그 인터프리터의 리스너가 잡는다). 리스너 수 = 인터프리터 수 x
  // 사용 타입 수 - element 수에 비례하지 않아 위임의 목적은 유지된다.
  eventBindings = new WeakMap<Element, Record<string, TBinding>>();
  // 내가 document에 단 위임 리스너(DOM 이벤트 타입 -> 리스너). 중복 설치 방지 겸, destroy가
  // removeEventListener로 뗄 때 같은 함수 참조가 필요해 리스너 자체를 보관한다.
  installedDelegates = new Map<string, EventListener>();

  // ── 끝 마커 스캔 캐시 ────────────────────────────────────────────
  // code는 인스턴스 내내 불변이라 스캔 결과가 pc마다 고정. @for 회차/@if lazyBuild가 같은
  // IF/FOR 지점을 회차 수만큼 재해석하며 매번 몸체를 재스캔하는 낭비를 없앤다. 키는 시작 pc.
  forEndCache = new Map<number, number>();
  ifRangesCache = new Map<number, { ifBodyEnd: number; elseBodyStart: number; ifEndPc: number }>();
  slotContentEndCache = new Map<number, number>();

  constructor(
    module: TModule,
    handlers: THandlers,
    resources: string[],
    loadedHrefs: Set<unknown>,
    store: TLeafStoreSubject,
    arrayPool: Pool<TArrayInfo>,
    regionPool: Pool<TRegion>,
    branchPool: Pool<TBranch>,
    createdContexts: TCreatedContext[],
    rootScope: TScope,
  ) {
    this.module = module;
    this.code = module.code;
    this.handlers = handlers;
    this.resources = resources;
    this.loadedHrefs = loadedHrefs;
    this.store = store;
    this.arrayPool = arrayPool;
    this.regionPool = regionPool;
    this.branchPool = branchPool;
    this.createdContexts = createdContexts;
    this.rootScope = rootScope;
  }

  // forBodyEnd의 캐시 통과 조회.
  cachedForEnd = (bodyStart: number): number => {
    let end = this.forEndCache.get(bodyStart);
    if (end === undefined) {
      end = forBodyEnd(this.code, bodyStart);
      this.forEndCache.set(bodyStart, end);
    }
    return end;
  };

  // slotPlaceholderContentEnd의 캐시 통과 조회. @for 몸체 안 합성이면 회차마다 같은 pc를
  // 재스캔하므로 forEndCache와 같은 이유로 캐시한다.
  cachedSlotContentEnd = (contentStart: number): number => {
    let end = this.slotContentEndCache.get(contentStart);
    if (end === undefined) {
      end = slotPlaceholderContentEnd(this.code, contentStart);
      this.slotContentEndCache.set(contentStart, end);
    }
    return end;
  };

  // ifBranchRanges의 캐시 통과 조회.
  cachedIfRanges = (ifBodyStart: number): { ifBodyEnd: number; elseBodyStart: number; ifEndPc: number } => {
    let ranges = this.ifRangesCache.get(ifBodyStart);
    if (ranges === undefined) {
      ranges = ifBranchRanges(this.code, ifBodyStart);
      this.ifRangesCache.set(ifBodyStart, ranges);
    }
    return ranges;
  };

  componentEvents = (componentId: number): TEventEntry[] => {
    return this.module.defs[componentId].events;
  };

  componentContexts = (componentId: number): TEventEntry[] => {
    return this.module.defs[componentId].contexts;
  };

  // 발화 comp의 props를 이름->leafIndex 중첩 객체로 편다(BIND_EVENT에서 1회). props는 이 comp가
  // 받은 값의 주소라, scope 슬롯 i(=prop 선언 순서)의 (kind, base)를 argumentSourcePairs에서 읽는다.
  // STORE 슬롯만 담는다 - CONST(리터럴 바인딩)는 주소가 없어(get/set 대상 아님) 제외. 스칼라는
  // base 하나, 객체는 base부터 필드 offset 누적해 하위까지 편다(잎=leafIndex). 배열은 칸 leafIndex
  // 하나(push 대상 - 요소 경로 접근은 언어 전체가 아직 미지원).
  buildProps = (propsTypeRef: number, scope: TScope): Record<string, unknown> => {
    const propsType = this.module.types[propsTypeRef];
    if (propsType.tag !== "object") {
      return propsGuard({});
    }
    const props: Record<string, unknown> = {};
    for (let i = 0; i < propsType.fields.length; i++) {
      const [nameConst, fieldTypeRef] = propsType.fields[i];
      if (slotKind(scope, i) !== STORE) {
        continue; // CONST 슬롯 - 상수라 주소 없음
      }
      const name = this.module.constpool[nameConst] as string;
      props[name] = this.leafTree(fieldTypeRef, slotRef(scope, i));
    }
    return propsGuard(props);
  };

  // base부터 typeRef 구조 따라 잎=leafIndex 중첩값을 만든다. 스칼라는 base 하나, 객체는 필드마다
  // 앞 형제 leaf 수만큼 offset을 밀어 재귀하고(store 레이아웃 = 깊이우선 연속), 배열은 인덱스를
  // 접근 시점에 푸는 노드다.
  leafTree = (typeRef: number, base: number): unknown => {
    const t = this.module.types[typeRef];
    if (t.tag === "array") {
      return this.arrayNode(base, t.elemTypeRef);
    }
    if (t.tag !== "object") {
      return base; // 스칼라(leafIndex)
    }
    // 자리(NODE_BASE/NODE_TYPE)를 함께 싣는다 - setObject가 여기서부터 이 타입대로 덮어쓴다.
    const obj: TLeafObject = { [NODE_BASE]: base, [NODE_TYPE]: typeRef };
    let offset = 0;
    for (const [nameConst, fieldTypeRef] of t.fields) {
      obj[this.module.constpool[nameConst] as string] = this.leafTree(fieldTypeRef, base + offset);
      offset += leafCountOf(this.module, fieldTypeRef);
    }
    return propsGuard(obj);
  };

  // 배열 칸 하나를 노드로 낸다 - `props.items[2].title`처럼 요소로 내려가는 길이다.
  //
  // 요소를 미리 펴지 않고 접근 시점에 푼다(Proxy). 요소 주소는 컴파일타임 offset이 아니라
  // arrayInfo.elemStartLeafIndices가 들고 있고(alloc/free로 자리가 오간다), push/removeAt으로
  // 목록이 계속 바뀌므로 미리 만든 노드는 곧 낡는다. 회차가 많으면 안 쓸 노드를 그만큼 만드는
  // 낭비이기도 하다.
  //
  // NODE_BASE는 배열 칸 leafIndex다 - 그 칸 값이 arrayInfoIndex라 push/removeAt/setArray가
  // 여기서 요소 목록에 닿는다(arrayInfoOf). length는 지금 목록 길이를 그때그때 읽는다.
  arrayNode = (arrayLeafIndex: number, elemTypeRef: number): unknown => {
    const target: TLeafObject = { [NODE_BASE]: arrayLeafIndex, [NODE_TYPE]: elemTypeRef };
    return new Proxy(target, {
      get: (t, key) => {
        if (typeof key === "symbol" || key in t) {
          return t[key];
        }
        const info = this.arrayInfoOf(arrayLeafIndex);
        if (key === "length") {
          return info.elemStartLeafIndices.length;
        }
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i >= info.elemStartLeafIndices.length) {
          throw new Error(`배열 인덱스 '${String(key)}' 없음 - 길이 ${info.elemStartLeafIndices.length}`);
        }
        return this.leafTree(elemTypeRef, info.elemStartLeafIndices[i]);
      },
    });
  };

  // 배열 칸에서 arrayInfo를 얻는다 - 그 칸 값이 arrayInfoIndex다. 핸들러가 넘긴 배열 노드는
  // 호출부가 NODE_BASE로 칸을 꺼내 넘긴다(노드가 그 칸을 싣고 있다).
  arrayInfoOf = (arrayLeafIndex: number): TArrayInfo => this.arrayPool.entries[Number(this.store.get(arrayLeafIndex))];

  // 한 바인딩을 발화한다 - data/context 조립 + 핸들러 호출. 인스턴스 상태는 this에서 꺼낸다.
  dispatch = (binding: TBinding, domEventObject: Event) => {
    const data: Record<string, unknown> = {};
    for (const p of binding.payload) {
      data[p.name] = assemble(
        compiledStepsOf(this.module, p.typeRef),
        p.fieldSourcePairs,
        this.store,
        this.module,
        this.arrayPool,
      );
    }
    const context: Record<string, Record<string, unknown>> = {};
    for (const ctxName in binding.contextLeaves) {
      const values: Record<string, unknown> = {};
      for (const p of binding.contextLeaves[ctxName]) {
        values[p.name] = assemble(
          compiledStepsOf(this.module, p.typeRef),
          p.fieldSourcePairs,
          this.store,
          this.module,
          this.arrayPool,
        );
      }
      context[ctxName] = values;
    }
    // 회차 인덱스를 발화 시점에 읽는다 - STORE면 store.get(ref)(array-for: 중간 제거로 당겨진 현재 인덱스),
    // RAW면 ref 값 자체(count-for: 상수). 이제서야 읽어야 array-for $n이 정합한다(바인딩 시점 값은 낡을 수 있다).
    const currentIndices: Record<string, number> = {};
    for (const key in binding.loopIndices) {
      const src = binding.loopIndices[key as TIndexSymbol];
      if (src) {
        currentIndices[key] = src.kind === STORE ? (this.store.get(src.ref) as number) : src.ref;
      }
    }
    this.handlers[binding.fullName]?.(data, {
      event: domEventObject,
      set: this.store.set,
      get: this.store.get,
      setObject: this.setObject,
      setArray: this.setArrayElements,
      push: this.pushArrayElement,
      removeAt: this.removeArrayElementAt,
      swapAt: this.swapArrayElementsAt,
      props: binding.props,
      store: this.rootStore(),
      context,
      ...currentIndices,
    });
  };

  // store = 루트부터의 절대 경로(props와 같은 leafIndex 중첩 객체, 단 발화 comp가 아닌 defs[0] 기준).
  // 인스턴스 불변이라 1회 만들어 캐시한다. 어느 핸들러든 같은 루트 상태 트리를 본다.
  storeTree: Record<string, unknown> | null = null;
  rootStore = (): Record<string, unknown> => {
    this.storeTree ??= this.buildProps(this.module.defs[0].propsTypeRef, this.rootScope);
    return this.storeTree;
  };

  // 배열 요소 추가 - props의 배열 필드(arrayLeafIndex) 칸 값이 arrayInfoIndex다. 요소를 타입대로 store에 심고
  // (plantFixed로 로컬에 펴 store.alloc으로 삽입, 요소 안 중첩 배열은 plantRoot처럼 레벨별로 마저 심음),
  // 그 시작 leaf를 elemStartLeafIndices에 잇고 길이 칸(sizeLeafIndex)을 set해 @for grow를 깨운다. sizeLeafIndex가
  // null이면 이 배열은 아직 @for에 안 쓰여 grow 대상이 없다(목록만 갱신).
  pushArrayElement = (array: TLeafObject, elem: unknown): void => {
    const info = this.arrayInfoOf(array[NODE_BASE]);
    this.plantArrayElement(elem, info);
    // 인덱스 leaf도 동기로 하나 잇는다 - 단 이 배열이 @for로 순회 중일 때만(forRegionIndices). 순회 전이면
    // reactiveArrayFor의 lazy 채움에 맡긴다. "@for 순회 중"의 신호는 forRegionIndices지 indexLeafIndices.length가
    // 아니다 - 요소가 전부 제거돼 빈 배열(length 0)이어도 순회는 진행 중이라, length로 판단하면 이 채움을
    // 건너뛰어 인덱스 없는 요소가 쌓이고 region과 어긋난다. 새 요소는 꼬리라 인덱스 = 마지막 자리.
    const tail = info.elemStartLeafIndices.length - 1;
    if (info.forRegionIndices.length > 0) {
      info.indexLeafIndices[tail] = this.store.alloc([tail]);
    }
    if (info.sizeLeafIndex !== null) {
      this.store.set(info.sizeLeafIndex, info.elemStartLeafIndices.length); // @for grow 발화
    }
  };

  // 한 요소를 arrayInfo에 심는다: 고정부를 local에 펴(plantFixed) store.alloc으로 삽입하고 그 base를
  // elemStartLeafIndices에 잇는다. 요소 안 중첩 배열은 plantFixed가 deferred로 돌려주니, 그 배열들의 요소도
  // 같은 방식으로 재귀해 마저 심는다(plantRoot의 레벨 심기와 같되 store.alloc 삽입).
  plantArrayElement = (value: unknown, target: TArrayInfo): void => {
    const local: unknown[] = [];
    const deferred = plantFixed(value, target.elemTypeRef, this.module, local, this.arrayPool);
    target.elemStartLeafIndices.push(this.store.alloc(local));
    for (const d of deferred) {
      for (const child of d.value as unknown[]) {
        this.plantArrayElement(child, this.arrayPool.entries[d.arrayInfoIndex]);
      }
    }
  };

  // 요소 하나(start, typeRef)를 회수한다 - 고정부를 타입대로 걸어 배열 칸(offset)을 만나면 그 자식 배열의 요소를
  // 재귀 회수하고 arrayInfo/길이 칸을 반납한다. 걷기가 끝나면 이 요소 고정 블록을 store.free. 제거된 요소의
  // 서브트리는 어디서도 참조되지 않으므로 안쪽까지 전부 반납해야 한다(누수 방지). 배열 칸 값이 arrayInfoIndex.
  freeArrayElement = (start: number, typeRef: number): void => {
    let cursor = start;
    const walk = (ref: number): void => {
      const t = this.module.types[ref];
      if (t.tag === "object") {
        for (const [, childTypeRef] of t.fields) {
          walk(childTypeRef);
        }
        return;
      }
      if (t.tag === "array") {
        const child = this.arrayPool.entries[Number(this.store.get(cursor))];
        for (const elemStart of child.elemStartLeafIndices) {
          this.freeArrayElement(elemStart, child.elemTypeRef);
        }
        if (child.sizeLeafIndex !== null) {
          this.store.free(child.sizeLeafIndex, 1); // @for에 쓰였으면 길이 칸도 회수(region은 removeBranchAt 재귀가 뗌)
        }
        freeArrayInfo(this.arrayPool, Number(this.store.get(cursor)));
      }
      cursor += 1; // 스칼라/배열 칸 하나 소비
    };
    walk(typeRef);
    this.store.free(start, leafCountOf(this.module, typeRef));
  };

  // 배열 요소 제거 - i번째 요소를 재귀 회수(freeElem)하고 목록(elemStartLeafIndices)에서 뺀다. 이 배열을
  // 순회하는 @for마다(forRegionIndices) 그 region의 i번째 회차 DOM만 뗀다 - 나머지 회차는 자기 요소 leaf를 그대로 보므로 무손상
  // (재빌드/재바인딩 없음). 중간 제거라 뒤 목록이 당겨지지만 store의 요소 leaf는 안 움직인다. 길이 칸
  // (sizeLeafIndex)을 새 개수로 set해 둔다 - DOM과 목록을 이미 손수 줄여 놨으니 그 발화(onSize)는 next===cur라
  // no-op이고(이중 제거 없음), 목적은 값을 진실과 맞춰 다음 push의 grow 발화가 동등성에 안 막히게 하는 것이다.
  removeArrayElementAt = (array: TLeafObject, i: number): void => {
    const info = this.arrayInfoOf(array[NODE_BASE]);
    for (const forRegionIndex of info.forRegionIndices) {
      removeBranchAt(this.store, this.regionPool, this.branchPool, forRegionIndex, i);
    }
    this.freeArrayElement(info.elemStartLeafIndices[i], info.elemTypeRef);
    info.elemStartLeafIndices.splice(i, 1);
    // 인덱스 leaf 처리(@for로 순회 중일 때만 - push와 같은 forRegionIndices 기준) - i번째 인덱스 칸을 회수하고
    // 목록에서 뺀 뒤, 뒤로 당겨진 요소들의 인덱스 leaf를 새 자리 번호로 set한다. 이 leaf를 몸체 {i}가 구독하고
    // $n이 발화 시 읽으므로, 중간 제거로 뒤가 당겨져도 표시/이벤트 인덱스가 자동 정합한다(값 고정/위치 이동 설계).
    // 칸은 배열이 소유한다 - 자리 번호라 순회하는 @for가 여럿이어도 값이 같아, 회차들이 같은 칸을 함께 구독한다.
    if (info.forRegionIndices.length > 0) {
      this.store.free(info.indexLeafIndices[i], 1);
      info.indexLeafIndices.splice(i, 1);
      for (let k = i; k < info.indexLeafIndices.length; k++) {
        this.store.set(info.indexLeafIndices[k], k); // 뒤 인덱스 당김 발화
      }
    }
    if (info.sizeLeafIndex !== null) {
      this.store.set(info.sizeLeafIndex, info.elemStartLeafIndices.length);
    }
  };

  // 배열 요소 자리 맞바꾸기 - i번째와 j번째 요소의 고정 블록 값을 칸마다 서로 set한다. 노드를 옮기지
  // 않는 것이 요점이다(DECISIONS.md _배열 항목 식별자(key) - 도입 안 함_의 재정렬 절) - 회차 DOM과
  // 구독은 자리에 그대로 있고, 각 회차가 보던 leaf의 값이 바뀌어 구독 발화로 화면이 따라온다.
  //
  // 그래서 안 건드리는 것들: elemStartLeafIndices(요소 자리는 그대로), indexLeafIndices(자리 번호라
  // [i]의 값은 늘 i), forRegionIndices(순회하는 region은 자리에 그대로), sizeLeafIndex(길이 불변).
  // removeAt과 정반대다 - 그쪽은 목록을 당기고 값을 안 옮긴다.
  //
  // 요소가 중첩 배열을 품으면 그 두 배열끼리 다시 이 규칙을 적용한다(swapArrayContents).
  swapArrayElementsAt = (array: TLeafObject, i: number, j: number): void => {
    const info = this.arrayInfoOf(array[NODE_BASE]);
    this.swapFixedBlocks(info.elemStartLeafIndices[i], info.elemStartLeafIndices[j], info.elemTypeRef);
  };

  // 같은 타입인 두 고정 블록(a, b)의 값을 칸마다 서로 맞바꾼다. freeArrayElement의 walk를 본뜬다 -
  // 고정부를 타입대로 훑어 칸을 하나씩 소비한다(cursor는 블록 시작 기준 offset이라 둘에 그대로 쓴다).
  //
  // 배열 칸은 값이 arrayInfoIndex인데 그 번호를 맞바꾸지 않는다 - reactiveArrayFor가 build 때 읽은
  // arrayInfo를 클로저로 붙들어 칸을 다시 안 읽어, 바꿔도 안쪽 @for가 따라오지 않는다. 대신 두
  // arrayInfo의 내용끼리 맞바꾼다(배열 실물마다 arrayInfo가 하나씩이라 둘은 다른 객체다).
  swapFixedBlocks = (a: number, b: number, typeRef: number): void => {
    let cursor = 0;
    const walk = (ref: number): void => {
      const t = this.module.types[ref];
      if (t.tag === "object") {
        for (const [, childTypeRef] of t.fields) {
          walk(childTypeRef);
        }
        return;
      }
      if (t.tag === "array") {
        this.swapArrayContents(
          this.arrayPool.entries[Number(this.store.get(a + cursor))],
          this.arrayPool.entries[Number(this.store.get(b + cursor))],
        );
      } else {
        const av = this.store.get(a + cursor);
        this.store.set(a + cursor, this.store.get(b + cursor));
        this.store.set(b + cursor, av);
      }
      cursor += 1; // 스칼라/배열 칸 하나 소비
    };
    walk(typeRef);
  };

  // 두 배열의 내용을 통째로 맞바꾼다. arrayInfo 객체 자체는 제자리에 둔다 - 칸 값(arrayInfoIndex)도,
  // 목록(elemStartLeafIndices)도 통째로는 바꾸지 않는다. 둘 다 이미 지어진 회차에 안 닿기 때문이다:
  // 회차는 build 때 실은 요소 leaf 주소를 계속 보고, reactiveArrayFor는 그때 읽은 arrayInfo를 붙든다.
  //
  // 그래서 바깥 요소와 같은 방식이다 - 겹치는 앞자리는 요소 값을 서로 맞바꾸고, 길이 차이가 나는
  // 꼬리만 긴 쪽에서 짧은 쪽으로 실제로 옮긴다. 자리를 유지하니 겹치는 구간의 회차 DOM은 그대로 두고
  // 바뀐 값만 구독 발화로 움직인다(setArrayInto의 자리 유지 전략과 같다).
  swapArrayContents = (x: TArrayInfo, y: TArrayInfo): void => {
    const kept = Math.min(x.elemStartLeafIndices.length, y.elemStartLeafIndices.length);
    for (let i = 0; i < kept; i++) {
      this.swapFixedBlocks(x.elemStartLeafIndices[i], y.elemStartLeafIndices[i], x.elemTypeRef);
    }
    if (x.elemStartLeafIndices.length === y.elemStartLeafIndices.length) {
      return; // 길이가 같아 옮길 꼬리가 없다
    }
    const [longer, shorter] = x.elemStartLeafIndices.length > kept ? [x, y] : [y, x];

    // 긴 쪽의 꼬리를 짧은 쪽으로 넘긴다 - 요소 leaf는 store에서 안 움직이고 목록만 옮겨 탄다.
    shorter.elemStartLeafIndices.push(...longer.elemStartLeafIndices.splice(kept));

    // 인덱스 칸을 먼저 맞춘다 - 아래 길이 칸 set이 내는 grow 발화가 addIterationBranch(i)를 부르고
    // 그게 indexLeafIndices[i]를 읽는다(reactiveArrayFor). 순서가 뒤집히면 없는 칸을 읽는다.
    // 자리 번호라 옮기지 않고 각자 자기 길이에 맞춰 늘리고 줄인다. 순회 중일 때만 다룬다
    // (forRegionIndices 기준) - push/removeAt과 같은 규칙.
    if (shorter.forRegionIndices.length > 0) {
      for (let k = kept; k < shorter.elemStartLeafIndices.length; k++) {
        shorter.indexLeafIndices[k] = this.store.alloc([k]);
      }
    }
    if (longer.forRegionIndices.length > 0) {
      for (const indexLeafIndex of longer.indexLeafIndices.splice(kept)) {
        this.store.free(indexLeafIndex, 1);
      }
    }

    // 길이 칸을 진실과 맞춘다 - 이 발화가 각 @for의 꼬리 회차를 늘리고 줄인다.
    if (longer.sizeLeafIndex !== null) {
      this.store.set(longer.sizeLeafIndex, longer.elemStartLeafIndices.length);
    }
    if (shorter.sizeLeafIndex !== null) {
      this.store.set(shorter.sizeLeafIndex, shorter.elemStartLeafIndices.length);
    }
  };

  // 배열 내용을 통째로 새 값들로 바꾼다 - 겹치는 앞자리는 값만 덮어쓰고(overwriteFixedBlock) 꼬리만
  // 늘리거나 줄인다. 요소를 전부 회수하고 다시 심으면 회차 DOM도 전부 다시 지어야 하는데, 목록 대부분이
  // 그대로인 교체(편집기 한 줄 수정 등)에서는 그 재구축이 통째로 낭비다. 자리를 유지하면 회차 DOM은
  // 그대로 두고 바뀐 텍스트/속성만 구독 발화로 움직인다.
  //
  // 자리를 유지한다는 건 i번째 요소 leaf가 다른 값을 갖게 된다는 뜻이다 - push/removeAt의 "값 고정,
  // 위치 이동"과 반대 방향이지만, 전량 교체는 이전 요소와의 대응 자체가 없으므로 이쪽이 맞다.
  setArrayElements = (array: TLeafObject, elems: unknown[]): void => {
    this.setArrayInto(this.arrayInfoOf(array[NODE_BASE]), elems);
  };

  // setArray의 본체 - arrayInfo를 직접 받는다(요소 안 중첩 배열은 칸 값이 arrayInfoIndex라
  // arrayLeafIndex가 없어 여기로 재귀한다).
  setArrayInto = (info: TArrayInfo, elems: unknown[]): void => {
    const kept = Math.min(info.elemStartLeafIndices.length, elems.length);
    for (let i = 0; i < kept; i++) {
      this.overwriteFixedBlock(info.elemStartLeafIndices[i], info.elemTypeRef, elems[i]);
    }

    // 꼬리 제거 - 회차 DOM(truncateFor)을 먼저 떼고 요소 leaf를 회수해야 한다. 반대로 하면 떼는 도중
    // 회차가 이미 반납된 leaf를 읽는다.
    if (elems.length < info.elemStartLeafIndices.length) {
      if (info.forRegionIndices.length > 0) {
        for (const forRegionIndex of info.forRegionIndices) {
          truncateFor(this.store, this.regionPool, this.branchPool, forRegionIndex, kept);
        }
        for (const indexLeafIndex of info.indexLeafIndices.splice(kept)) {
          this.store.free(indexLeafIndex, 1);
        }
      }
      for (const elemStart of info.elemStartLeafIndices.splice(kept)) {
        this.freeArrayElement(elemStart, info.elemTypeRef);
      }
    }

    // 꼬리 추가 - push와 같은 순서(요소를 심고 인덱스 leaf를 잇는다). 인덱스 leaf는 순회 중일 때만
    // 채운다(forRegionIndices 기준) - 순회 전이면 reactiveArrayFor의 lazy 채움에 맡긴다.
    for (let i = kept; i < elems.length; i++) {
      this.plantArrayElement(elems[i], info);
      if (info.forRegionIndices.length > 0) {
        info.indexLeafIndices[i] = this.store.alloc([i]);
      }
    }

    // 길이 칸을 진실과 맞춘다. 개수가 그대로면 no-op인데, 그래도 맞다 - 회차 DOM을 손대지 않았고
    // 값은 덮어쓰기가 이미 발화시켰다.
    if (info.sizeLeafIndex !== null) {
      this.store.set(info.sizeLeafIndex, info.elemStartLeafIndices.length);
    }
  };

  // 객체 노드 하나를 값으로 갈아끼운다 - 안 준 필드는 undefined가 된다(병합이 아니라 교체).
  // 노드가 실어 둔 자리가 요소 하나의 고정 블록과 같은 모양이라 overwriteFixedBlock에 그대로
  // 맡긴다 - 배열 필드도 그 안에서 setArrayInto로 함께 간다.
  setObject = (node: TLeafObject, value: unknown): void => {
    this.overwriteFixedBlock(node[NODE_BASE], node[NODE_TYPE], value);
  };

  // 고정 블록 하나(start부터 typeRef 구조)를 기존 자리에 덮어쓴다 - 배열 요소도 객체 노드도 같은
  // 모양이라 setArray/setObject가 함께 쓴다. 고정 칸은 store.set으로 값만 바꾸고, 배열 칸을 만나면
  // 그 칸 값(arrayInfoIndex)은 그대로 둔 채 그 자식 배열에 대해 setArrayInto로 재귀한다. 배열 칸에
  // set을 하면 arrayInfo 포인터가 깨져 그 배열의 모든 요소 leaf를 잃는다.
  //
  // 커서 진행 순서는 freeArrayElement의 walk와 같아야 한다(객체는 필드 선언 순, 스칼라/배열은 한 칸) -
  // 둘 다 같은 고정부 레이아웃(plantFixed)을 걷는다.
  overwriteFixedBlock = (start: number, typeRef: number, value: unknown): void => {
    let cursor = start;
    const walk = (ref: number, v: unknown): void => {
      const t = this.module.types[ref];
      if (t.tag === "object") {
        for (const [nameConstIndex, childTypeRef] of t.fields) {
          const key = this.module.constpool[nameConstIndex] as string;
          walk(childTypeRef, (v as Record<string, unknown> | undefined)?.[key]);
        }
        return;
      }
      if (t.tag === "array") {
        this.setArrayInto(this.arrayPool.entries[Number(this.store.get(cursor))], Array.isArray(v) ? v : []);
      } else {
        this.store.set(cursor, v);
      }
      cursor += 1; // 스칼라/배열 칸 하나 소비
    };
    walk(typeRef, value);
  };

  // domEvent 타입의 위임 리스너를 document에 (인터프리터당 한 번만) 단다. target -> 조상 순회로
  // 자기 eventBindings의 첫 바인딩을 찾아 발화하고 멈춘다 - 남의 element는 통과한다(격리).
  ensureDelegate = (domEventName: (typeof DOM_EVENTS)[number]) => {
    if (this.installedDelegates.has(domEventName)) {
      return;
    }
    const listener = (domEventObject: Event) => {
      let node = domEventObject.target;
      while (node && node !== document) {
        const bound = this.eventBindings.get(node as Element);
        const binding = bound?.[domEventName];
        if (binding) {
          this.dispatch(binding, domEventObject);
          return; // 첫 매칭에서 멈춤 - 자기 선에서 버블 끊기와 동등
        }
        node = (node as Node).parentNode;
      }
    };
    this.installedDelegates.set(domEventName, listener);
    document.addEventListener(domEventName, listener);
  };

  // 내가 document에 단 위임 리스너를 전부 뗀다. 리스너 클로저가 this를 잡아 인터프리터
  // (store/pool 전체)를 살려두므로, 떼지 않으면 인스턴스가 GC되지 않는다. 인스턴스 해체(destroy)의
  // 리스너 축 - DOM/구독 축은 rootRegion.detach가 맡는다(Blueprint의 destroy가 둘을 묶는다).
  removeDelegates = () => {
    for (const [domEventName, listener] of this.installedDelegates) {
      document.removeEventListener(domEventName, listener);
    }
    this.installedDelegates.clear();
  };

  // @for 회차 i의 몸체(bodyStart~forEndPc)를 해석해 fragment로 낸다. 노드/구독/자식region은
  // target 가지에 쌓인다(인라인이면 지금 가지, 반응이면 회차 branch). 회차 인덱스를 공유
  // 스택에 push -> 재귀 -> pop한다 - 매 회차 [...stack, i] 복사 대신 배열 하나를 재사용한다
  // (10만 회차 x 깊이만큼의 할당 제거). 재귀는 동기라 push된 상태에서 완료되고, 발화 인덱스는
  // BIND_EVENT가 바인딩 시점에 loopIndices로 스냅샷하므로(공유 배열을 잡지 않음) 재사용이 안전하다.
  buildIteration = (
    indexKind: number,
    indexRef: number,
    bodyStart: number,
    forEndPc: number,
    targetBranchIndex: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    walkStacks.loopIndexStack.push(indexKind, indexRef); // 인터리브 (kind, ref) - argumentSourcePairs와 동형. count-for는 (RAW, i), array-for는 (STORE, 인덱스 leaf)
    const f = this.interpret(
      argumentSourcePairs,
      compId,
      bodyStart,
      forEndPc,
      targetBranchIndex,
      pathPrefix,
      loopIndexBase,
      walkStacks,
    ); // walkStacks.loopIndexStack에 방금 push된 회차 인덱스를 물려준다
    walkStacks.loopIndexStack.pop(); // ref
    walkStacks.loopIndexStack.pop(); // kind
    return f;
  };

  // 안 변하는 @for(FOR_RAW/CONST) - 각 회차를 지금 가지(startRegion/Branch)에 fragment로
  // 인라인한다. @for는 컴포넌트 경계가 아니라 같은 가지의 제어 흐름이라 부모 노드에 통째로
  // 붙인다. appendChild(fragment)는 내용 전체를 한 번에 옮기고 fragment를 비운다(노드별 재입양
  // 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는 라이브라 순회 중 인덱스가 밀려 건너뛴다.
  inlineFor = (
    count: number,
    bodyStart: number,
    forEndPc: number,
    parent: Node,
    startBranchIndex: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    for (let i = 0; i < count; i++) {
      argumentSourcePairs.push(RAW, i, RAW, i); // 슬롯 2칸 - item(회차값)/index 모두 [RAW,i](리터럴은 반응성 없어 상수)
      parent.appendChild(
        this.buildIteration(
          RAW,
          i,
          bodyStart,
          forEndPc,
          startBranchIndex,
          argumentSourcePairs,
          compId,
          pathPrefix,
          loopIndexBase,
          walkStacks,
        ),
      );
      argumentSourcePairs.pop(); // index ref
      argumentSourcePairs.pop(); // index kind
      argumentSourcePairs.pop(); // item ref
      argumentSourcePairs.pop(); // item kind
    }
  };

  // 숫자 count 반응 @for(FOR_SCOPE_INDEX+STORE, 값이 숫자) - 전용 region을 만들어 회차마다 branch
  // 하나에 노드/구독/자식region을 격리한다(count 줄 때 그 회차만 통째로 떼기 위함). anchor를 지금
  // 가지에 남기고 회차 노드는 anchor 뒤에 붙는다. 초기엔 branch.nodes만 채운다(부모 attachIf가
  // 루트부터 일괄 attach할 때 이 region도 childRegionIndices 재귀로 붙는다 - @if 자식과 동일).
  // count leaf 구독이 꼬리 회차를 늘리고(build+attach) 줄인다(truncate).
  reactiveCountFor = (
    countLeafIndex: number,
    bodyStart: number,
    forEndPc: number,
    parent: Node,
    branch: TBranch,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    const forRegionIndex = appendForRegion(this.regionPool, countLeafIndex);
    const region = this.regionPool.entries[forRegionIndex];
    branch.childRegionIndices.push(forRegionIndex); // 부모 가지에 자식 등록(detach 재귀 대상)
    parent.appendChild(region.anchor);

    // grow(onCount 발화)는 지연 실행이라 그 시점 공유 pairs/walkStacks는 이 @for 지점을 지나 이미 pop돼
    // 있다(@if lazyBuild와 동형). build 시점 상태를 딥카피해 addIterationBranch가 캡처한다 - 초기
    // 회차도 같은 스냅샷을 쓴다(build 시점이라 값 동일, push/pop도 스냅샷에만 가 원본 무오염).
    const pairs = [...argumentSourcePairs];
    const stacks = snapshotStacks(walkStacks);

    // 회차 branch 하나를 추가하고 build해 담는다(interpret이 fragment로 낸 노드를 detach 때
    // 되찾게 branch.nodes에 보관). 껍데기 push(appendBranchOfForRegion) + build(buildIteration).
    // 새 회차의 전역 branchIndex를 돌려준다.
    // 몸체 `{i}`가 읽을 회차변수(인덱스) 슬롯을 [RAW, i]로 밀고 build 후 되돌린다
    // (array-for와 같은 push/pop 규칙). 슬롯 번호는 그 시점 pairs 길이/2 = props+바깥 회차변수 뒤.
    const addIterationBranch = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(this.regionPool, this.branchPool, forRegionIndex);
      pairs.push(RAW, i, RAW, i); // 슬롯 2칸 - item(회차값)/index 모두 [RAW,i](count-for는 중간 제거 없어 인덱스 상수)
      this.branchPool.entries[newBranchIndex].nodes = Array.from(
        this.buildIteration(
          RAW,
          i,
          bodyStart,
          forEndPc,
          newBranchIndex,
          pairs,
          compId,
          pathPrefix,
          loopIndexBase,
          stacks,
        ).childNodes,
      );
      pairs.pop(); // index ref
      pairs.pop(); // index kind
      pairs.pop(); // item ref
      pairs.pop(); // item kind
      return newBranchIndex;
    };

    const initial = Number(this.store.get(countLeafIndex)) || 0;
    for (let i = 0; i < initial; i++) {
      addIterationBranch(i);
    }

    const onCount = (v: unknown) => {
      const next = Number(v) || 0;
      const cur = region.branchIndices.length;
      for (let i = cur; i < next; i++) {
        attachForIteration(this.store, this.regionPool, this.branchPool, forRegionIndex, addIterationBranch(i)); // 늘어난 꼬리만 build+attach
      }
      if (next < cur) {
        truncateFor(this.store, this.regionPool, this.branchPool, forRegionIndex, next); // 줄어든 꼬리 제거
      }
    };
    // 부모 가지 구독에 실어 생애를 함께 한다 - 부모가 detach/free되면 count 감시도 꺼진다.
    branch.leafIndices.push(countLeafIndex);
    branch.updateFns.push(onCount);
    this.store.subscribe(countLeafIndex, onCount);
  };

  // 배열 반응 @for - reactiveCountFor와 같은 구조(전용 region + 회차 branch + 길이 구독으로 grow/shrink)로,
  // 다른 점은 회차변수 slot이 count처럼 [RAW, i]가 아니라 그 요소 leaf에 [STORE, elemStartLeafIndices[i]]로
  // 붙는다는 것뿐이다(몸체가 요소 필드를 store에서 읽는다). 배열 요소 수는 store 값이 아니라
  // info.elemStartLeafIndices.length가 진실이라, 발화용 길이 칸(sizeLeafIndex)을 여기서 lazy 확보해
  // (이 배열이 @for에 쓰일 때만) 요소 수를 심고 구독한다. push가 요소를 elemStartLeafIndices에 넣고
  // 그 칸을 set하면 이 구독이 깨어 늘어난 꼬리만 build+attach한다.
  reactiveArrayFor = (
    arrayLeafIndex: number,
    bodyStart: number,
    forEndPc: number,
    parent: Node,
    branch: TBranch,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    const info = this.arrayPool.entries[Number(this.store.get(arrayLeafIndex))];
    if (info.sizeLeafIndex === null) {
      info.sizeLeafIndex = this.store.alloc([info.elemStartLeafIndices.length]); // @for에 처음 쓰일 때만 길이 칸 확보
    }
    const sizeLeafIndex = info.sizeLeafIndex;
    // 인덱스 leaf도 @for에 처음 쓰일 때만 lazy 채운다(sizeLeafIndex와 같은 결). elemStartLeafIndices와
    // 나란히 요소 수만큼 확보 - [i]=i번째 요소의 회차 번호. 이후 push/removeAt이 둘을 동기로 유지한다.
    if (info.indexLeafIndices.length === 0) {
      for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
        info.indexLeafIndices[i] = this.store.alloc([i]);
      }
    }

    const forRegionIndex = appendForRegion(this.regionPool, sizeLeafIndex);
    info.forRegionIndices.push(forRegionIndex); // removeAt이 이 region들의 회차 DOM을 뗀다(같은 배열을 여러 @for가 순회할 수 있다)
    const region = this.regionPool.entries[forRegionIndex];
    branch.childRegionIndices.push(forRegionIndex);
    parent.appendChild(region.anchor);

    // grow(onSize 발화)는 지연 실행이라 그 시점 공유 pairs/walkStacks는 이 @for 지점을 지나 이미 pop돼
    // 있다(@if lazyBuild와 동형). build 시점 상태를 딥카피해 addIterationBranch가 캡처한다 - 초기
    // 회차도 같은 스냅샷을 쓴다(build 시점이라 값 동일, push/pop도 스냅샷에만 가 원본 무오염).
    const pairs = [...argumentSourcePairs];
    const stacks = snapshotStacks(walkStacks);

    // array-for는 슬롯 2칸 - [STORE, 요소 base], [STORE, 인덱스 leaf] 순. 요소 슬롯은 몸체가 요소 필드를
    // (count-for의 [RAW,i]와 같은 push/pop 규칙), 인덱스 슬롯은 몸체 {i}가 읽는다. 인덱스 leaf는 발화 시
    // $n으로도 해소되게 loopIndexStack에 (STORE, 인덱스 leaf)로 실어 물려준다. 슬롯 번호 = props + 바깥 슬롯 뒤.
    const addIterationBranch = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(this.regionPool, this.branchPool, forRegionIndex);
      const indexLeaf = info.indexLeafIndices[i];
      pairs.push(STORE, info.elemStartLeafIndices[i], STORE, indexLeaf);
      this.branchPool.entries[newBranchIndex].nodes = Array.from(
        this.buildIteration(
          STORE,
          indexLeaf,
          bodyStart,
          forEndPc,
          newBranchIndex,
          pairs,
          compId,
          pathPrefix,
          loopIndexBase,
          stacks,
        ).childNodes,
      );
      pairs.pop(); // 인덱스 ref
      pairs.pop(); // 인덱스 kind
      pairs.pop(); // 요소 ref
      pairs.pop(); // 요소 kind
      return newBranchIndex;
    };

    for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
      addIterationBranch(i);
    }

    const onSize = () => {
      const next = info.elemStartLeafIndices.length; // store 값이 아니라 요소 목록 길이가 진실
      const cur = region.branchIndices.length;
      for (let i = cur; i < next; i++) {
        attachForIteration(this.store, this.regionPool, this.branchPool, forRegionIndex, addIterationBranch(i)); // 늘어난 꼬리만 build+attach
      }
      if (next < cur) {
        truncateFor(this.store, this.regionPool, this.branchPool, forRegionIndex, next); // 줄어든 꼬리 제거
      }
    };
    branch.leafIndices.push(sizeLeafIndex);
    branch.updateFns.push(onSize);
    this.store.subscribe(sizeLeafIndex, onSize);
  };

  // offset을 leafIndex로 해석(지연)하고 초기값을 돌려준다.
  //
  // 구독은 즉시 걸지 않고 현재 가지에 모은다 - attach가 그 가지를 켤 때 건다
  // (안 보이는 가지는 구독 0).
  //
  // @param scopeIndex 슬롯 번호(argumentSourcePairs[2*scopeIndex]=kind, [2*scopeIndex+1]=ref)
  // @param offset     슬롯이 객체 base일 때 필드까지의 store 칸 거리(leaf/const면 0)
  // @param update     값 변경 시 호출될 콜백(가지 활성화 후 구독으로 연결)
  // @returns          현재 값(없으면 "")
  bindVar = (
    scopeIndex: number,
    offset: number,
    update: (v: unknown) => void,
    argumentSourcePairs: TScope,
    branch: TBranch,
  ) => {
    const ref = slotRef(argumentSourcePairs, scopeIndex);
    const kind = slotKind(argumentSourcePairs, scopeIndex);
    if (kind === CONST) {
      // 상수: 상수풀 직접 참조. 안 변하니 구독은 죽은 구독 - 스킵한다.
      return this.module.constpool[ref] ?? "";
    }
    if (kind === RAW) {
      // 회차 상수(count @for 인덱스): 참조가 값 자체. store에 없어 구독도 없다.
      return ref;
    }
    // STORE 슬롯의 ref는 base leafIndex. 객체 필드면 base+offset이 그 leaf.
    const leafIndex = ref + offset;
    const initial = this.store.get(leafIndex) ?? "";
    branch.leafIndices.push(leafIndex);
    branch.updateFns.push(update);
    return initial;
  };

  // 한 가지(startPc~endPc)를 build한다 - 노드는 fragment로 반환, 구독은 해당 가지에 쌓는다.
  //
  // 재진입 가능: 최초 인스턴스화는 루트 전체를, lazy build는 swap으로 처음 켜지는 가지 범위만
  // 해석한다. 자식 IF는 활성 가지를 재귀로 즉시 build하고 비활성 가지엔 lazyBuild만 심는다.
  // RENDER는 자식 def 구간을 자식 argumentSourcePairs로 이 함수에 재진입해 인라인 합성한다(별도 인스턴스/
  // 루트 region 없이 부모 가지 안에 합류).
  //
  // @param argumentSourcePairs            offset -> store 경로 매핑(자식은 자식 argumentSourcePairs)
  // @param compId           지금 해석 중인 def(자식 RENDER면 자식 def). events/contexts를 이 def에서 참조로 꺼낸다.
  // @param startPc, endPc   해석 범위(endPc는 IF_END 직전)
  // @param startBranchIndex 구독을 쌓을 가지의 전역 branchIndex(branchPool.entries[startBranchIndex])
  // @param pathPrefix       이벤트 fullname의 누적 경로(루트 ""). RENDER가 자식 type-name을 잇는다(불변 값).
  // @param loopIndexBase    자식 @for 세그먼트 인덱스의 base(누적 @for 깊이). RENDER가 늘린다(불변 값).
  // @param walkStacks               가변 walk 스택(loopIndexStack/activeContexts). @for/RENDER는 이어 쓰고, @if 비활성 가지는 카피본을 쓴다.
  // @param slotPlaceholderContents  사용쪽(부모)이 RENDER로 넘긴 슬롯 콘텐츠. 인덱스 = 이 def의 @slot 선언 순서, 미채움 슬롯은 구멍(undefined).
  // @returns                직속 노드를 담은 DocumentFragment
  interpret = (
    argumentSourcePairs: TScope,
    compId: number,
    startPc: number,
    endPc: number,
    startBranchIndex: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    slotPlaceholderContents: (TSlotPlaceholderContent | undefined)[] = [],
  ): DocumentFragment => {
    const fragment = document.createDocumentFragment();
    const nodeStack: Node[] = [fragment]; // 노드 스택 - DOM 부모 추적
    let pending: HTMLElement | null = null;
    let args = [];
    let segment: string | null = null; // 다음 RENDER/BIND_EVENT가 소비할 경로 세그먼트(PUSH_PATH_SEGMENT/INDEX가 적재)
    // 다음 RENDER가 소비할 슬롯 콘텐츠(PUSH_SLOT_PLACEHOLDER_CONTENT가 적재). args와 같은 생애 -
    // RENDER가 자식에 넘기고 비운다. 인덱스 = 자식 def의 @slot 선언 순서라 미채움은 구멍으로 남는다.
    let pendingSlotPlaceholderContents: (TSlotPlaceholderContent | undefined)[] = [];
    let pc = startPc;

    // 이 interpret이 채우는 가지. 한 호출 = 한 가지라 불변(중첩 if는 재귀 호출이 자식 가지를
    // 새 컨텍스트로 받는다 - JS 호출 스택이 옛 region/branch 스택 역할을 대신한다).
    const branch = this.branchPool.entries[startBranchIndex]; // startBranchIndex는 전역 branchIndex

    const u16at = () => {
      const v = this.code[pc] | (this.code[pc + 1] << 8);
      pc += 2;
      return v;
    };
    const u8at = () => this.code[pc++];
    const nodeTop = () => nodeStack[nodeStack.length - 1];

    while (pc < endPc) {
      const op = this.code[pc++];
      switch (op) {
        case OP.HALT: {
          pc = endPc;
          break;
        }
        case OP.LOAD_RES: {
          // 리소스 로드 - resId의 URL로 <link>를 document.head에 삽입. 이미 삽입한 href는
          // 스킵(한 compile의 여러 컴포넌트/인스턴스가 같은 리소스를 써도 한 번만). 삽입한 href를
          // loadedHrefs(compile 단위)로 기억해 매번 head를 querySelector로 훑지 않는다
          // (인스턴스가 많으면 그 비용이 지배적). dedup 범위가 compile이라 새 렌더 세션은 깨끗하다.
          const url = this.resources[u16at()];
          if (url && !this.loadedHrefs.has(url)) {
            this.loadedHrefs.add(url);
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
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(name, this.module.constpool[u16at()] as string);
          break;
        }
        case OP.ATTR_L: {
          const name = this.module.constpool[u16at()] as string;
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(name, this.module.constpool[u16at()] as string);
          break;
        }
        case OP.ATTR_G_VAR: {
          const name = ATTRS[u16at()];
          const scopeIndex = u8at();
          const offset = u8at();
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          const el = pending!;
          const v = this.bindVar(
            scopeIndex,
            offset,
            (v) => el.setAttribute(name, v as string),
            argumentSourcePairs,
            branch,
          );
          el.setAttribute(name, v as string);
          break;
        }
        case OP.ATTR_L_VAR: {
          const name = this.module.constpool[u16at()] as string;
          const scopeIndex = u8at();
          const offset = u8at();
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          const el = pending!;
          const v = this.bindVar(
            scopeIndex,
            offset,
            (v) => el.setAttribute(name, v as string),
            argumentSourcePairs,
            branch,
          );
          el.setAttribute(name, v as string);
          break;
        }
        case OP.BIND_EVENT: {
          // 지금 여는 요소(pending)에 리스너를 단다. event_type=DOM 이벤트, event_idx=이 def의 이벤트.
          const domEvent = DOM_EVENTS[u16at()];
          const event = this.componentEvents(compId)[u16at()];
          const eventName = this.module.constpool[event.nameConstIndex] as string;
          // fullname = 합성 경로 + (@for 직속 element면 익명 인덱스 세그먼트) + 로컬 이벤트명.
          // segment는 PUSH_PATH_INDEX_SEGMENT가 이 element에 깐 [$n](RENDER를 안 거치니 여기서
          // 소비). 이벤트 있는 element마다 새로 깔리므로 소비(비움)해도 형제/중첩이 다시 깐다.
          let eventPrefix = pathPrefix;
          if (segment !== null) {
            eventPrefix = eventPrefix ? `${eventPrefix}.${segment}` : segment;
            segment = null;
          }
          const fullName = eventPrefix ? `${eventPrefix}.${eventName}` : eventName;
          // fields의 leaf를 flat 값-소스로 미리 푼다(바인딩 때 1회, argumentSourcePairs 불변). steps(조립
          // 구조)는 발생 때 lazy 컴파일. 스칼라 field는 leaf 하나, 객체는 leaf 여럿(깊이우선).
          const payload: TAssembled[] = event.fields.map((field) => ({
            name: this.module.constpool[field.nameConstIndex] as string,
            typeRef: field.typeRef,
            fieldSourcePairs: refToSourcePairs(field.ref, leafCountOf(this.module, field.typeRef), argumentSourcePairs),
          }));
          // props: 발화 comp가 선언한 props 전체를 이름->leafIndex 중첩 객체로(payload에 실었는지와
          // 무관 - payload는 data 값, props는 상태 주소). propsTypeRef + 현재 scope로 편다.
          const props = this.buildProps(this.module.defs[compId].propsTypeRef, argumentSourcePairs);
          // 지금 활성인 컨텍스트들을 context명 -> (필드명 -> leafIndex)로 묶는다(바인딩 시점 고정).
          // 같은 이름은 뒤(안쪽)가 덮는다 - activeContexts 순서대로 돌아 안쪽이 마지막에 쓰인다.
          const contextLeaves: Record<string, TAssembled[]> = {};
          for (const i of walkStacks.activeContexts) {
            const created = this.createdContexts[i];
            contextLeaves[created.name] = created.fields;
          }
          // @for 회차 인덱스 소스를 바인딩 시점에 굳힌다($0=바깥, $1=안쪽...). loopIndexStack은 인터리브
          // (kind, ref)라 i번째 $는 [2i]=kind, [2i+1]=ref. 값을 지금 굳히지 않고 (kind, ref)로 들었다가
          // 발화 때 해소하는 이유: array-for(STORE) 인덱스는 그 사이 중간 제거로 뒤 인덱스가 당겨질 수
          // 있어 발화 시점 store.get이라야 정합하다(count-for RAW는 상수라 아무 때나 같다). fullname [$n]과 짝.
          const loopIndices: Partial<{ [key in TIndexSymbol]: { kind: number; ref: number } }> = {};
          for (let i = 0; i * 2 < walkStacks.loopIndexStack.length; i++) {
            loopIndices[`$${i}` as TIndexSymbol] = {
              kind: walkStacks.loopIndexStack[2 * i],
              ref: walkStacks.loopIndexStack[2 * i + 1],
            };
          }
          // element별 리스너 대신 발화 바인딩을 WeakMap에 심고 document 위임을 켠다.
          // 한 element에 DOM 이벤트 타입이 여럿 붙을 수 있어 타입별로 담는다.
          // biome-ignore lint/style/noNonNullAssertion: BIND_EVENT는 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          const el = pending!;
          let bound = this.eventBindings.get(el);
          if (!bound) {
            bound = {};
            this.eventBindings.set(el, bound);
          }
          bound[domEvent] = { fullName, payload, contextLeaves, props, loopIndices };
          this.ensureDelegate(domEvent);
          break;
        }
        case OP.ELEM_CLOSE_OPEN: {
          // biome-ignore lint/style/noNonNullAssertion: CLOSE_OPEN은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          nodeTop().appendChild(pending!);
          // biome-ignore lint/style/noNonNullAssertion: 바로 위와 같은 pending
          nodeStack.push(pending!);
          pending = null;
          break;
        }
        case OP.TEXT: {
          nodeTop().appendChild(document.createTextNode(this.module.constpool[u16at()] as string));
          break;
        }
        case OP.TEXT_VAR: {
          const node = document.createTextNode("");
          const scopeIndex = u8at();
          const offset = u8at();
          node.textContent = this.bindVar(
            scopeIndex,
            offset,
            (v) => (node.textContent = v as string),
            argumentSourcePairs,
            branch,
          ) as string;
          nodeTop().appendChild(node);
          break;
        }
        case OP.ELEM_END: {
          nodeStack.pop();
          break;
        }
        case OP.PUSH_THROUGH: {
          // 경로 없는 참조 - 부모 슬롯 (kind, ref)를 편집 없이 그대로 자식에 넘긴다. kind를
          // 보존해 부모가 리터럴로 받은 CONST 슬롯도 그대로 아래로 흐른다.
          const scopeIndex = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex));
          break;
        }
        case OP.PUSH_FIELD: {
          // 필드 참조 - 부모 슬롯 base에 offset을 더해 자식에 넘긴다. kind는 그대로 전파,
          // 위치만 옮긴다. CONST 슬롯은 필드가 없어(리터럴은 객체 아님) FIELD로 오지 않는다.
          const scopeIndex = u8at();
          const offset = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex) + offset);
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
          segment = this.module.constpool[u16at()] as string;
          break;
        }
        case OP.PUSH_PATH_INDEX_SEGMENT: {
          // @for 인덱스 세그먼트를 정적 fullname에 접미한다. 직전 이름 세그먼트가 있으면
          // Row[$0], 없으면(element 직속) 익명 [$0]. operand는 컴포넌트-로컬 깊이라 use-site에서
          // 물려받은 깊이(loopIndexStack.length)를 base로 더해 누적 표기($1...)로 만든다 - 자식
          // 컴포넌트 코드는 자기 @for를 0부터 세지만 fullname은 바깥까지 누적돼야 한다.
          const token = `[$${loopIndexBase + u16at()}]`;
          segment = (segment ?? "") + token;
          break;
        }
        case OP.ENTER_CONTEXT: {
          // @with 진입: 컨텍스트 def의 fields를 지금 argumentSourcePairs로 leafIndex로 풀어 createdContexts에
          // 싣고, 그 인덱스를 activeContexts에 push. 발생 시점 BIND_EVENT가 이걸로 context를 짓는다.
          const contextDef = this.componentContexts(compId)[u16at()];
          const name = this.module.constpool[contextDef.nameConstIndex as number] as string;
          // payload와 같은 조립 준비 - leaf만 미리 풀고 steps는 조회 시 lazy. 발생 시 context 조립.
          const fields: TAssembled[] = contextDef.fields.map((field) => ({
            name: this.module.constpool[field.nameConstIndex] as string,
            typeRef: field.typeRef,
            fieldSourcePairs: refToSourcePairs(field.ref, leafCountOf(this.module, field.typeRef), argumentSourcePairs),
          }));
          // 맥락은 같은 이름이 중복으로 쌓이지 않는 게 맞다(ISSUES). 일어나면 알리고, 가장
          // 안쪽이 이기도록 그냥 쌓는다(context 조립이 뒤(=안쪽) 것으로 덮는다).
          if (walkStacks.activeContexts.some((i) => this.createdContexts[i].name === name)) {
            console.warn(`quble: 컨텍스트 '${name}'가 중복 활성화됐습니다(안쪽이 우선).`);
          }
          walkStacks.activeContexts.push(this.createdContexts.length);
          this.createdContexts.push({ name, fields });
          break;
        }
        case OP.EXIT_CONTEXT: {
          // @with 블록 끝. 활성 스택에서만 빼고 createdContexts는 둔다(회수는 @for 때 - ISSUES).
          walkStacks.activeContexts.pop();
          break;
        }
        case OP.PUSH_SLOT_PLACEHOLDER_CONTENT: {
          // 콘텐츠 구간을 재서 담아두기만 한다 - 실행은 자식의 FILL_SLOT_PLACEHOLDER 자리에서.
          // 지금 컨텍스트(부모)를 함께 캡처한다: 콘텐츠는 부모 def 안이라 부모 scope/path로 읽힌다.
          const slotPlaceholderIndex = u16at();
          const contentStart = pc;
          const contentEndPc = this.cachedSlotContentEnd(contentStart);
          pendingSlotPlaceholderContents[slotPlaceholderIndex] = {
            startPc: contentStart,
            endPc: contentEndPc,
            argumentSourcePairs: [...argumentSourcePairs],
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks: snapshotStacks(walkStacks),
            branchIndex: startBranchIndex,
          };
          pc = contentEndPc + 1; // SLOT_PLACEHOLDER_CONTENT_END 마커 소비
          break;
        }
        case OP.FILL_SLOT_PLACEHOLDER: {
          // `@slot` 자리(정의쪽). 부모가 안 채웠으면 구멍이라 아무것도 안 넣는다(미채움 허용).
          const content = slotPlaceholderContents[u16at()];
          if (content === undefined) {
            break;
          }
          // 세 축이 갈린다: 해석 컨텍스트/수명(구독 가지)은 부모 것, DOM 부착 위치만 자식 자리.
          // 콘텐츠 안 합성은 자기 슬롯을 스스로 채우므로 여기 재진입엔 넘길 게 없다.
          const slotFragment = this.interpret(
            content.argumentSourcePairs,
            content.compId,
            content.startPc,
            content.endPc,
            content.branchIndex,
            content.pathPrefix,
            content.loopIndexBase,
            content.walkStacks,
          );
          nodeTop().appendChild(slotFragment);
          break;
        }
        case OP.RENDER: {
          const childCompId = u16at();
          const childArgumentSourcePairs = args;
          args = [];
          const childSlotPlaceholderContents = pendingSlotPlaceholderContents;
          pendingSlotPlaceholderContents = [];
          // 자식 경로 prefix = 부모 prefix + 세그먼트. 이벤트 fullname의 path 축을 누적한다.
          const childPrefix = pathPrefix ? `${pathPrefix}.${segment}` : segment;
          segment = null;
          // 합성 = 인라인 재진입. 자식 def의 code 구간을 자식 argumentSourcePairs로 같은 interpret에 돌린다.
          // 시작 가지 = 지금 이 가지(startBranchIndex) -> 자식 IF는 이 가지의
          // childRegionIndices에 합류하고 같은 regionPool 배열에 append된다(인덱스 전역 유일).
          // 자식 루트 region 없음 - 자식 직속 노드는 fragment로 모여 RENDER 위치에 붙는다.
          const childDef = this.module.defs[childCompId];
          const childFragment = this.interpret(
            childArgumentSourcePairs,
            childCompId, // 자식 BIND_EVENT/ENTER_CONTEXT는 자식 def의 이벤트/컨텍스트 테이블을 본다
            childDef.codeOff,
            childDef.codeOff + childDef.codeLen,
            startBranchIndex,
            // biome-ignore lint/style/noNonNullAssertion: RENDER 지점엔 PUSH_PATH_SEGMENT가 깐 segment가 있어 childPrefix는 non-null(바이트코드 순서 보장)
            childPrefix!,
            walkStacks.loopIndexStack.length / 2, // 자식 세그먼트 인덱스의 base = 여기까지 누적된 @for 깊이(스택은 인터리브라 /2)
            walkStacks, // 회차 인덱스/컨텍스트 스택을 공유로 물려준다 - @for/@with 경계가 push/pop으로 원복(복사 없음)
            childSlotPlaceholderContents, // 자식 @slot 자리가 꺼내 쓸 콘텐츠(부모 컨텍스트를 이미 캡처해 둠)
          );
          // fragment를 통째로 붙인다 - appendChild(fragment)는 내용 전체를 한 번에 옮기고
          // fragment를 비운다(노드별 재입양 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는
          // 라이브라 순회 중 인덱스가 밀려 건너뛴다.
          nodeTop().appendChild(childFragment);
          break;
        }
        case OP.IF: {
          pc = this.runIf(pc, argumentSourcePairs, compId, pathPrefix, loopIndexBase, walkStacks, branch, nodeTop());
          break;
        }
        case OP.FOR_RAW: {
          // 소스에 박힌 리터럴 횟수 - 안 변하니 지금 가지(startRegion/Branch)에 count회 인라인.
          const count = Number(u16at()) || 0;
          const bodyStart = pc;
          const forEndPc = this.cachedForEnd(bodyStart);
          this.inlineFor(
            count,
            bodyStart,
            forEndPc,
            nodeTop(),
            startBranchIndex,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
          );
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        case OP.FOR_COUNT_VAR: {
          // 숫자 count slot(@if 조건과 동형). CONST(부모가 리터럴로 준 prop)는 안 변하니 인라인,
          // STORE는 count leaf에 구독을 걸어 값이 바뀌면 꼬리 회차를 늘리고 줄인다. count가
          // 필드(a.count)면 base+offset이 그 leaf.
          const scopeIndex = u8at();
          const offset = u8at();
          const ref = slotRef(argumentSourcePairs, scopeIndex);
          const bodyStart = pc;
          const forEndPc = this.cachedForEnd(bodyStart);
          if (slotKind(argumentSourcePairs, scopeIndex) === CONST) {
            this.inlineFor(
              Number(this.module.constpool[ref]) || 0,
              bodyStart,
              forEndPc,
              nodeTop(),
              startBranchIndex,
              argumentSourcePairs,
              compId,
              pathPrefix,
              loopIndexBase,
              walkStacks,
            );
          } else {
            this.reactiveCountFor(
              ref + offset,
              bodyStart,
              forEndPc,
              nodeTop(),
              branch,
              argumentSourcePairs,
              compId,
              pathPrefix,
              loopIndexBase,
              walkStacks,
            );
          }
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        case OP.FOR_ARRAY_VAR: {
          // 배열 count slot. 배열 칸에 든 arrayInfoIndex로 요소 수/요소 위치를 얻어, 회차마다
          // 회차변수(item) slot을 그 요소 leaf로 바인딩하며 반복한다. item slot은 codegen과 같은
          // 규칙(props 슬롯 수 + 현재 @for 깊이)으로 계산한다. base+offset이 배열 칸의 leaf.
          const scopeIndex = u8at();
          const offset = u8at();
          const arrayLeafIndex = slotRef(argumentSourcePairs, scopeIndex) + offset;
          const bodyStart = pc;
          const forEndPc = this.cachedForEnd(bodyStart);
          this.reactiveArrayFor(
            arrayLeafIndex,
            bodyStart,
            forEndPc,
            nodeTop(),
            branch,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
          );
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        default: {
          throw new Error(`bad opcode 0x${op.toString(16)}`);
        }
      }
    }
    return fragment;
  };

  // @if opcode 처리 - then/else Region을 스폰해 anchor를 parent에 붙이고, 활성 가지만 build한다.
  // 비활성 가지엔 lazyBuild만 심어 첫 활성화 때 만든다. cond가 STORE면 구독을 걸어 swap한다.
  // pc는 IF operand 직후(cond 슬롯)를 가리켜 들어오고, IF_END 다음 pc를 돌려준다.
  runIf = (
    pc: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    parent: Node,
  ): number => {
    const condScopeIndex = this.code[pc++];
    const condOffset = this.code[pc++];
    // 조건 슬롯도 STORE/CONST 위임 처리. CONST(부모가 리터럴로 준 prop)는 값이 안
    // 변하니 leafIndex도 구독도 없다 - condLeafIndex=-1(region이 이 값을 읽지 않는다).
    const condIsConst = slotKind(argumentSourcePairs, condScopeIndex) === CONST;
    const condRef = slotRef(argumentSourcePairs, condScopeIndex);
    const condLeafIndex = condIsConst ? -1 : condRef + condOffset;
    const regionIndex = appendIfRegion(this.regionPool, this.branchPool, condLeafIndex);
    const region = this.regionPool.entries[regionIndex];
    branch.childRegionIndices.push(regionIndex); // 부모(이 interpret의) 가지에 자식 등록
    const thenBranchIndex = region.branchIndices[THEN_INDEX];
    const elseBranchIndex = region.branchIndices[ELSE_INDEX];
    const thenBranch = this.branchPool.entries[thenBranchIndex];
    const elseBranch = this.branchPool.entries[elseBranchIndex];
    // anchor(if 자리 고정용 주석)는 appendIfRegion이 만들었다. 여기서 DOM 트리에 붙인다.
    parent.appendChild(region.anchor);

    // if/else 몸체 코드 경계. ifBodyStart = IF operand 직후(현재 pc).
    const ifBodyStart = pc;
    const { ifBodyEnd, elseBodyStart, ifEndPc } = this.cachedIfRanges(ifBodyStart);

    // 비활성 가지는 lazyBuild로 심어만 뒀다 나중(조건 swap)에 실행된다. 그 지연 시점의 공유
    // pairs/walkStacks는 이 @if를 지나 이미 pop된 상태라, build 시점 상태를 딥카피해 캡처한다 - 카피
    // 없이는 회차변수 슬롯/회차 인덱스($n)/컨텍스트를 잃는다. then/else 중 하나만 실행되니
    // 스냅샷 하나를 공유 캡처한다(reactive @for grow의 addIterationBranch와 같은 관례).
    const pairs = [...argumentSourcePairs];
    const stacks = snapshotStacks(walkStacks);

    // 각 가지를 build하는 클로저. 활성 가지는 지금 호출하고, 비활성 가지는 심어만 둔다.
    const buildThen = () => {
      const f = this.interpret(
        pairs,
        compId,
        ifBodyStart,
        ifBodyEnd,
        thenBranchIndex,
        pathPrefix,
        loopIndexBase,
        stacks,
      );
      thenBranch.nodes = Array.from(f.childNodes);
    };
    const buildElse = () => {
      const f =
        elseBodyStart === -1
          ? document.createDocumentFragment() // else 없는 if - 빈 가지
          : this.interpret(pairs, compId, elseBodyStart, ifEndPc, elseBranchIndex, pathPrefix, loopIndexBase, stacks);
      elseBranch.nodes = Array.from(f.childNodes);
    };
    thenBranch.lazyBuild = buildThen;
    elseBranch.lazyBuild = buildElse;

    // cond 변경 시 해당 가지를 활성화(swap). 첫 활성화면 activateIf가 lazyBuild 호출.
    // CONST 조건은 안 변하니 구독을 걸지 않는다(초기 가지로 고정).
    if (!condIsConst) {
      const onCond = (condValue: unknown) => {
        activateIf(this.store, this.regionPool, this.branchPool, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
      };
      // 부모 가지 구독에 실어 생애를 함께 한다 - 부모가 detach/free되면 조건 감시도 꺼진다.
      branch.leafIndices.push(condLeafIndex);
      branch.updateFns.push(onCond);
      this.store.subscribe(condLeafIndex, onCond);
    }
    // build는 "생성만" 한다 - 활성 가지를 lazyBuild로 만들어 자식 branch.nodes에 담고
    // shownIndex만 설정한다. DOM 부착/구독 등록은 하지 않는다(attachIf가 일괄).
    // 그래야 부모 fragment엔 anchor만 남아, 부모 branch.nodes가 자손까지 머금지 않는다.
    // (anchor는 평평한 형제라, 여기서 자식 노드를 붙이면 부모 nodes에 섞여 detach가 깨진다.)
    const condInitial = condIsConst ? this.module.constpool[condRef] : this.store.get(condLeafIndex);
    const initialShownIndex = condInitial ? THEN_INDEX : ELSE_INDEX;
    const initialBranch = this.branchPool.entries[region.branchIndices[initialShownIndex]];
    // biome-ignore lint/style/noNonNullAssertion: 방금 buildThen/buildElse로 lazyBuild를 심었으니 null 아님
    initialBranch.lazyBuild!();
    initialBranch.built = true;
    region.shownIndex = initialShownIndex;

    return ifEndPc + 1; // IF_END 마커 소비 - if 블록 다음 pc
  };
}

// ── 공개 API ─────────────────────────────────────────────────────────
// qubb 바이트를 디코드해 blueprintOf(compId)를 돌려준다.
//
// 사용: const blueprintOf = compile(bytes);
//       const inst = blueprintOf(0)(rootValue, handlers);
//       root.append(...inst.nodes);
//
// @param bytes  qubb 바이트
// @param resources resId -> URL 매핑(LOAD_RES가 <link>로 삽입). manifest.resources. 없으면 로드 생략.
// @returns      blueprintOf: (compId) => Blueprint
export const compile = (bytes: Uint8Array, resources: string[] = []) => {
  const module = decode(bytes);
  // LOAD_RES dedup 집합은 compile 단위 - 이 compile에서 나온 모든 blueprint/인스턴스가 공유하되,
  // 다른 compile(다른 렌더 세션)은 깨끗한 Set으로 시작한다.
  const loadedHrefs = new Set();
  // code는 전체 module.code를 그대로 쓰고 pc는 절대 오프셋으로 다룬다 - def/자식 구간마다
  // subarray 뷰를 새로 할당하지 않는다(자식 RENDER가 많으면 그 할당이 누적된다).
  return (compId: number) =>
    (rootValue: unknown, handlers: THandlers = {}) => {
      const def = module.defs[compId];
      // 인스턴스 불변 상태 - 모든 build(최초/lazy)가 공유한다.
      // @for가 순회하는 배열마다 요소 leaf 위치(entries). 요소 추가/제거 시 참조. free는 빈 칸 인덱스(freelist).
      const arrayPool: Pool<TArrayInfo> = new Pool();
      // rootValue를 루트 props 타입대로 store에 펴 심고(고정부 연속 + 배열 요소는 뒤로), 각 루트
      // 슬롯의 base leafIndex를 rootFlat([STORE, base, ...])으로 얻는다. 배열 요소는 arrayPool에 등록된다.
      const { leaves, rootFlat } = plantRoot(module, rootValue, arrayPool);
      const store = createLeafStoreSubject(leaves);
      // 루트도 region(균일성): swap 없는 단일 가지지만, anchor/branch.nodes를 자식과 똑같이 갖춰
      // attachIf가 분기 없이 처리한다. 루트 anchor 주석은 인스턴스 노드의 맨 앞에 선다.
      const regionPool: Pool<TRegion> = new Pool(); // 한 인스턴스의 모든 Region. alloc/free(@for 회차 제거 시 자식 region 반납).
      const branchPool: Pool<TBranch> = new Pool(); // 한 인스턴스의 모든 Branch. alloc/free(@for 회차 제거 시 반납).
      // 만들어진 컨텍스트 저장소. EnterContext마다 { name, fields }를 append하고 그 인덱스를
      // activeContexts에 싣는다. fields는 그 시점 argumentSourcePairs로 푼 leafIndex라 인스턴스마다 달라 공유
      // 안 됨. 지금은 append만(회수는 @for+leafIndex 회수 때 - ISSUES).
      const createdContexts: TCreatedContext[] = [];
      const rootRegion = regionPool.entries[appendIfRegion(regionPool, branchPool, -1)]; // 루트도 region(인덱스 0)
      branchPool.entries[rootRegion.branchIndices[THEN_INDEX]].built = true; // 루트 then은 즉시 build됨(아래 interpret)
      rootRegion.shownIndex = THEN_INDEX;

      // build: 트리(regionPool/branch.nodes/shownIndex)만 만든다. 루트 직속 노드는 fragment에 모여
      // 루트 가지에 담긴다(자식 region 노드는 아직 안 붙음 - 부모 nodes 오염 방지). 그 뒤
      // attachIf가 루트부터 재귀로 노드를 anchor 뒤에 끼우고 구독을 건다.
      // rootFlat은 plantRoot가 준 [STORE, base, ...] - 루트 슬롯은 정의상 전부 외부 데이터 바인딩이라 STORE.
      const interpreter = new Interpreter(
        module,
        handlers,
        resources,
        loadedHrefs,
        store,
        arrayPool,
        regionPool,
        branchPool,
        createdContexts,
        rootFlat,
      );
      const fragment = interpreter.interpret(
        rootFlat,
        compId, // 루트 def
        def.codeOff,
        def.codeOff + def.codeLen,
        rootRegion.branchIndices[THEN_INDEX], // branch index
        "", // 루트 경로 prefix 비어 있음
        0, // 세그먼트 인덱스 base 0
        { loopIndexStack: [], activeContexts: [] }, // 루트는 @for/@with 밖 - 빈 스택
      );
      branchPool.entries[rootRegion.branchIndices[THEN_INDEX]].nodes = Array.from(fragment.childNodes);
      fragment.prepend(rootRegion.anchor); // anchor를 루트 노드 앞에 - attach가 anchor.after로 채운다
      rootRegion.attach(store, regionPool, branchPool, rootRegion);
      // fragment 자식 전체(anchor + 붙은 트리)가 이 인스턴스의 루트 노드들(append 시 비워지므로 배열로).
      const nodes = Array.from(fragment.childNodes);
      // store를 인스턴스에 실어 반환 - 호출측이 set(leafIndex, v)로 반응성을 건다(옛 setPath 대체).
      // destroy = 인스턴스 해체: 붙은 DOM/구독을 region 트리 재귀로 떼고(detach - 반응 갱신으로
      // 나중에 붙은 노드까지 region이 안다), 루트 anchor와 document 위임 리스너를 제거해 인스턴스가
      // GC되게 한다.
      const destroy = () => {
        rootRegion.detach(store, regionPool, branchPool, rootRegion);
        rootRegion.anchor.remove();
        interpreter.removeDelegates();
      };
      return { nodes, regionPool, branchPool, arrayPool, store, destroy };
    };
};

// 상태 저장소(store)는 leaf-store.ts가 정의한다. blueprint가 받는 store가 이것 - 편의상 여기서 재공개한다.
export { createLeafStoreSubject };
