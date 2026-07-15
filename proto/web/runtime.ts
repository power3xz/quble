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
// 가지는 구독 0이다(region 구조/동작은 region.js). RENDER는 자식 def를 같은 interpret으로 인라인
// 재진입해, 자식 if가 부모와 같은 regionPool/가지에 합류한다(별도 인스턴스 없음).
//
// 값 소비 경로 (REACTIVITY.md §1~§3):
//   offset(컴포넌트 로컬) -> argumentSourcePairs 슬롯 [kind, ref] -> kind가 STORE면 store.leafOf로
//   leafIndex(lazy 발급) + store.get, CONST면 module.constpool[ref] 직접.

type TDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

// 숫자 한 자리 이상 (재귀)
type TDigitString = `${TDigit}` | `${TDigit}${TDigit}`;

type TIndexSymbol = `$${TDigitString}`;

import { createLeafStoreSubject, type LeafStoreSubject as TLeafStoreSubject } from "./leaf-store.ts";
import {
  activateIf,
  appendArrayInfo,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  attachForIteration,
  ELSE_INDEX,
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
] as const;
const ATTRS = ["class", "id", "src", "alt", "href", "type", "name", "value", "title", "style", "placeholder"] as const;
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
  FOR_SCOPE_INDEX: 0x16,
  FOR_END: 0x17,
  PUSH_PATH_INDEX_SEGMENT: 0x18,
  PUSH_FIELD: 0x19,
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
    case OP.FOR_SCOPE_INDEX:
    case OP.PUSH_PATH_INDEX_SEGMENT:
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

// @for 몸체 끝(FOR_END)의 pc를 찾는다. bodyStart부터 op 경계를 전진하며 중첩 @for 깊이를
// 센다(같은 깊이 0의 FOR_END가 이 몸체 끝). IF는 몸체 안에 섞여도 여기선 무시 - FOR_RAW/
// FOR_SCOPE_INDEX/FOR_END만 깊이에 관여한다.
//
// @param code      def 바이트코드
// @param bodyStart 몸체 첫 op 위치(FOR operand 직후)
// @returns         FOR_END의 pc - 호출자가 그 마커를 소비
const forBodyEnd = (code: Uint8Array, bodyStart: number) => {
  let pc = bodyStart;
  let depth = 0;
  while (pc < code.length) {
    const markerPc = pc;
    const op = code[pc++];
    if (op === OP.FOR_RAW || op === OP.FOR_SCOPE_INDEX) {
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

// IF 블록의 then/else 코드 경계를 구한다(순수 - code와 then 시작 pc만 본다).
//
// then = thenStart~thenEnd, else = elseStart~ifEndPc. else 없으면 elseStart = -1이고
// thenEnd === ifEndPc === IF_END 위치. 마커는 skipBranch로 찾고 호출자가 소비한다.
//
// @param code      def 바이트코드
// @param thenStart then 가지 시작 pc(IF operand 직후)
// @returns         { thenEnd, elseStart, ifEndPc }
const ifBranchRanges = (code: Uint8Array, thenStart: number) => {
  const thenEnd = skipBranch(code, thenStart); // ELSE 또는 IF_END
  if (code[thenEnd] === OP.ELSE) {
    const elseStart = thenEnd + 1;
    return { thenEnd, elseStart, ifEndPc: skipBranch(code, elseStart) };
  }
  return { thenEnd, elseStart: -1, ifEndPc: thenEnd }; // else 없는 if
};

// ── 디코드 (proto/BYTECODE.md 포맷) ───────────────────────────────────
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
// 경로(반응값, 구독), CONST는 참조가 상수풀 인덱스(불변, 구독 스킵). (RAW는 @for 때 추가.)
const STORE = 0;
const CONST = 1;

// FieldValue ref 출처 태그(Rust serialize <REF>와 대칭). ref마다 태그 1바이트 + payload.
// 슬롯 해석방법(STORE/CONST)과 다른 층이다 - Scope 슬롯의 실제 kind는 argumentSourcePairs가 정한다.
const FV_SCOPE = 0;
const FV_CONST = 1;
const FV_RAW = 2;

// 타입 테이블 엔트리 태그(BYTECODE.md §4). Rust read_type 대칭.
const TYPE_SCALAR = 0;
const TYPE_OBJECT = 1;
const TYPE_ARRAY = 2;

// 타입 테이블 엔트리 하나를 읽는다. Scalar는 payload 없음, Object는 field_count +
// [(nameConstIndex, typeRef)], Array는 elem_type_ref. typeRef로 자식을 가리켜 중첩/공유(Rust put_type 대칭).
//
// @param r Reader
// @returns { tag: "scalar" } | { tag: "object", fields } | { tag: "array", elemTypeRef }
type TType =
  | { tag: "scalar" }
  | { tag: "object"; fields: TField[] }
  | { tag: "array"; elemTypeRef: number };
type TField = [number, number];
const readType = (reader: Reader): TType => {
  const tag = reader.u8();
  if (tag === TYPE_SCALAR) {
    return { tag: "scalar" };
  }
  if (tag === TYPE_OBJECT) {
    const count = reader.u16();
    const fields: TField[] = [];
    for (let f = 0; f < count; f++) {
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
  for (let f = 0; f < count; f++) {
    const nameConstIndex = reader.u16();
    const typeRef = reader.u16();
    const ref = readRef(reader);
    fields.push({ nameConstIndex, typeRef, ref });
  }
  return fields;
};

// field ref 하나를 assemble이 커서로 소비할 [kind, ref, …] 열로 푼다(바인딩 때 1회). 한 field는
// 단일 출처다 - 리터럴이면 CONST 쌍 하나, 변수면 그 슬롯의 kind. 객체 변수는 store에 연속으로
// 깔려(base부터 재귀적으로 이어짐) base+offset부터 leaf 개수만큼 STORE 쌍으로 펼친다. leaf
// 개수 = steps의 STEP_LEAF 수. assemble이 이 열을 steps 따라 소비해 (중첩) 객체를 조립한다.
//
// @param ref       field.ref
// @param leafCount  field.typeRef의 leaf 칸 수(객체를 몇 칸 펼칠지)
// @param argumentSourcePairs flat 슬롯 배열
// @returns          [kind, ref, …] 열
type TRef = { kind: number; ref: number; offset: number };
const refToSourcePairs = (ref: TRef, leafCount: number, argumentSourcePairs: (string | number)[]): number[] => {
  if (ref.kind === FV_CONST) {
    return [CONST, ref.ref];
  }
  if (ref.kind === FV_RAW) {
    throw new Error("FV_RAW는 아직 미구현(@for)");
  }
  // FV_SCOPE - 슬롯의 kind를 물려받는다. CONST 슬롯(부모가 리터럴로 준 prop)은 상수 하나.
  const kind = argumentSourcePairs[2 * ref.ref] as number;
  const slotRef = argumentSourcePairs[2 * ref.ref + 1] as number;
  if (kind === CONST) {
    return [CONST, slotRef];
  }
  // STORE 슬롯 - base(slotRef+offset)부터 leaf 개수만큼 연속 칸을 STORE 쌍으로 펼친다.
  const base = slotRef + ref.offset;
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
const STEP_ENTER = 0;
const STEP_LEAF = 1;
const STEP_EXIT = 2;

// type_ref 구조를 조립 step 열로 컴파일한다(type_ref별 1회, dedup되니 공유 가능). 명시적 스택
// 반복이라 깊은 타입에도 콜스택 안전. leaf 자리엔 인덱스를 안 박고 STEP_LEAF로 "다음 leaf 소비"만
// 표시 - 실제 leaf는 assemble이 leafIndices를 커서로 소비한다(구조=step, 인스턴스=leafIndices).
//
// @param types   타입 테이블
// @param typeRef 시작 타입
// @param constpool 상수풀(필드명 해석)
// @returns       [[STEP_*, key]] 평탄 열. 루트 key=null.
type TStep = [number, string | null];
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
      // payload/context에 배열 통째 전달은 아직 없다 - 값 자리엔 leaf만(컴파일러 NotLeaf로 거른다).
      throw new Error("배열 타입 조립은 미구현(payload/context 배열 전달)");
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
// @param fieldSourcePairs 이 field의 flat 값-소스 [kind, ref, …](깊이우선, step의 LEAF 순서와 일치)

const assemble = (steps: TStep[], fieldSourcePairs: number[], store: TLeafStoreSubject, module: TModule) => {
  let cursor = 0;
  const root: Record<string, unknown> = {};
  const stack: Record<string, unknown>[] = [root];
  for (const [step, key] of steps) {
    const top = stack[stack.length - 1];
    if (step === STEP_LEAF) {
      const kind = fieldSourcePairs[cursor++];
      const ref = fieldSourcePairs[cursor++];
      const value = kind === CONST ? module.constpool[ref] : store.get(ref);
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

// 지연 심기 항목 - 배열 하나. 요소 leaf가 객체 고정 칸 사이에 끼면 뒤 필드 offset이 밀리므로,
// 고정부를 다 심은 뒤 요소를 store 끝에 몰아 심는다(중간 삽입 금지). value는 원본 배열.
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
  arrayPool: TArrayInfo[],
  freeArrays: number[],
): TDeferredArray[] => {
  const t = module.types[typeRef];
  if (t.tag === "scalar") {
    leaves.push(value);
    return [];
  }
  if (t.tag === "array") {
    // 배열 칸 = arrayInfoIndex 하나. 요소 심기는 미룬다(고정부 연속 유지).
    const elemSize = leafCountOf(module, t.elemTypeRef);
    const arrayInfoIndex = appendArrayInfo(arrayPool, freeArrays, elemSize);
    leaves.push(arrayInfoIndex);
    return [{ arrayInfoIndex, value, elemTypeRef: t.elemTypeRef }];
  }
  const obj = value as Record<string, unknown> | undefined;
  const deferred: TDeferredArray[] = [];
  for (const [nameConstIndex, childTypeRef] of t.fields) {
    const key = module.constpool[nameConstIndex] as string;
    deferred.push(...plantFixed(obj?.[key], childTypeRef, module, leaves, arrayPool, freeArrays));
  }
  return deferred;
};

// 루트 props 타입(반드시 object)의 각 1뎁스 prop을 슬롯 하나로 보고, rootValue를 leaves에 펴며
// 각 prop의 base leafIndex를 모은다. 반환 leaves/arrayPool로 store·인스턴스를 채우고,
// rootFlat([STORE, base, …])을 진입점 argumentSourcePairs로 쓴다. 루트 슬롯은 정의상 전부
// 외부 데이터 바인딩이라 kind가 늘 STORE. 루트 고정부를 다 심은 뒤(base가 고정 칸을 가리켜야
// 한다) 배열 요소를 store 끝에 몰아 심는다(drainArrays).
const plantRoot = (
  module: TModule,
  rootValue: unknown,
  arrayPool: TArrayInfo[],
  freeArrays: number[],
) => {
  const rootType = module.types[module.rootPropsTypeRef];
  const leaves: unknown[] = [];
  const rootFlat: number[] = [];
  const obj = rootValue as Record<string, unknown> | undefined;

  // 루트 고정부를 먼저 심어(base가 고정 칸을 가리켜야 한다) 레벨 0 배열들을 얻는다.
  let pending: TDeferredArray[] = [];
  for (const [nameConstIndex, childTypeRef] of (rootType as { fields: TField[] }).fields) {
    rootFlat.push(STORE, leaves.length); // 이 prop 첫 고정 칸이 base
    const key = module.constpool[nameConstIndex] as string;
    pending.push(...plantFixed(obj?.[key], childTypeRef, module, leaves, arrayPool, freeArrays));
  }

  // 레벨별로 배열 요소를 store 끝에 심는다. 한 레벨의 형제 배열들 요소를 다 심어(연속) 그 안에서
  // 만난 다음 레벨 배열들을 next에 모으고, 빌 때까지 반복. for 경계가 다 고정이라 자라는 큐가 없다.
  while (pending.length) {
    const next: TDeferredArray[] = [];
    for (const { arrayInfoIndex, value, elemTypeRef } of pending) {
      const info = arrayPool[arrayInfoIndex];
      const elems = Array.isArray(value) ? value : [];
      for (const elem of elems) {
        info.elemStartLeafIndices.push(leaves.length); // 이 요소 첫 leaf
        next.push(...plantFixed(elem, elemTypeRef, module, leaves, arrayPool, freeArrays));
      }
    }
    pending = next;
  }
  return { leaves, rootFlat };
};

// ── 이벤트 위임 ──────────────────────────────────────────────────────
// element마다 addEventListener를 다는 대신(부하 시 리스너 클로저가 노드 수만큼 쌓인다),
// element -> 발화 바인딩을 WeakMap에 심고 document에 DOM 이벤트 타입별 위임 리스너 하나만 단다.
// 발화 시 target에서 위로 올라가며 첫 바인딩을 찾아 디스패치하고 멈춘다(자기 선에서 버블 끊기와
// 동등 - 조상의 같은 타입 위임으로 새지 않는다). 바인딩은 인스턴스 스코프 값(handlers/store/module)을
// 함께 담아 위임 리스너에서 복원한다.
const eventBindings = new WeakMap<Element, Record<string, TBinding>>();
const installedDelegates = new Set(); // 이미 document에 단 DOM 이벤트 타입(중복 설치 방지)

// 한 바인딩을 발화한다 - 기존 element별 리스너가 하던 data/context 조립 + 핸들러 호출.
const dispatchBinding = (b: TBinding, domEventObject: Event) => {
  const { handlers, fullName, payload, contextLeaves, props, loopIndices, store, module } = b;
  const data: Record<string, unknown> = {};
  for (const p of payload) {
    data[p.name] = assemble(compiledStepsOf(module, p.typeRef), p.fieldSourcePairs, store, module);
  }
  const context: Record<string, Record<string, unknown>> = {};
  for (const ctxName in contextLeaves) {
    const values: Record<string, unknown> = {};
    for (const p of contextLeaves[ctxName]) {
      values[p.name] = assemble(compiledStepsOf(module, p.typeRef), p.fieldSourcePairs, store, module);
    }
    context[ctxName] = values;
  }
  handlers[fullName]?.(data, {
    event: domEventObject,
    set: store.set,
    get: store.get,
    props,
    context,
    ...loopIndices,
  });
};

// domEvent 타입의 위임 리스너를 document에 (한 번만) 단다. target -> 조상 순회로 첫 바인딩을
// 찾아 발화하고 멈춘다. 같은 타입 바인딩이 있는 element만 매칭한다.
const ensureDelegate = (domEventName: (typeof DOM_EVENTS)[number]) => {
  if (installedDelegates.has(domEventName)) {
    return;
  }
  installedDelegates.add(domEventName);
  document.addEventListener(domEventName, (domEventObject) => {
    let node = domEventObject.target;
    while (node && node !== document) {
      const bound = eventBindings.get(node as Element);
      const b = bound?.[domEventName];
      if (b) {
        dispatchBinding(b, domEventObject);
        return; // 첫 매칭에서 멈춤 - 자기 선에서 버블 끊기와 동등
      }
      node = (node as Node).parentNode;
    }
  });
};

// qubb 바이트를 모듈로 디코드한다(상수풀/def 테이블/코드).
//
// @param bytes qubb 바이트 (proto/BYTECODE.md 포맷)
// @returns     { constpool, defs, code }
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

  // 루트 props 객체 타입 인덱스 - 진입점이 rootValue를 이 구조로 store에 풀필한다.
  const rootPropsTypeRef = r.u16();

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
  // leafCounts: type_ref -> leaf 칸 수 캐시(refToSourcePairs가 객체를 몇 칸 펼칠지).
  return { constpool, types, rootPropsTypeRef, defs, code, compiledSteps: [], leafCounts: [] };
};
type TFieldEntry = { nameConstIndex: number; typeRef: number; ref: TRef };
type TEventEntry = { nameConstIndex: number; fields: TFieldEntry[] };
type TDef = {
  nameConstIndex: number;
  codeOff: number;
  codeLen: number;
  events: TEventEntry[];
  contexts: TEventEntry[];
};
type TModule = {
  code: Uint8Array;
  constpool: (string | number | boolean)[];
  types: TType[];
  rootPropsTypeRef: number;
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
// 한 element·DOM이벤트 타입의 발화 바인딩. eventBindings WeakMap에 심고 위임 리스너가 복원한다.
type TBinding = {
  handlers: THandlers;
  fullName: string;
  payload: TAssembled[];
  contextLeaves: Record<string, TAssembled[]>;
  props: Record<string, number>;
  loopIndices: Partial<{ [key in TIndexSymbol]: number }>;
  store: TLeafStoreSubject;
  module: TModule;
};

// ── 한 def를 Blueprint로 컴파일 ──────────────────────────────────────
// 한 컴포넌트 def를 Blueprint(인스턴스화 함수)로 만든다.
//
// Blueprint는 호출 시 def 코드를 훑어 DOM/구독을 만든다. 자식 RENDER는 interpret을 자식 def
// 구간으로 재진입해 인라인 합성한다(별도 청사진 호출 없음).
//
// @param module 디코드된 모듈
// @param compId 컴포넌트 def 인덱스
// @returns      Blueprint: (rootValue, handlers) => Instance { nodes, regionPool, store }
const compileDef = (module: TModule, compId: number, resources: string[] = [], loadedHrefs = new Set()) => {
  const def = module.defs[compId];
  if (!def) {
    throw new Error(`bad component ${compId}`);
  }
  // code는 전체 module.code를 그대로 쓰고 pc는 절대 오프셋으로 다룬다 - def/자식 구간마다
  // subarray 뷰를 새로 할당하지 않는다(자식 RENDER가 많으면 그 할당이 누적된다).

  return (rootValue: unknown, handlers: THandlers = {}) => {
    // 인스턴스 불변 상태 - 모든 build(최초/lazy)가 공유한다.
    const arrayPool: TArrayInfo[] = []; // @for가 순회하는 배열마다 요소 leaf 위치. 요소 추가/제거 시 참조.
    const freeArrays: number[] = []; // arrayPool의 빈 칸 인덱스(freelist).
    // rootValue를 루트 props 타입대로 store에 펴 심고(고정부 연속 + 배열 요소는 뒤로), 각 루트
    // 슬롯의 base leafIndex를 rootFlat([STORE, base, …])으로 얻는다. 배열 요소는 arrayPool에 등록된다.
    const { leaves, rootFlat } = plantRoot(module, rootValue, arrayPool, freeArrays);
    const store = createLeafStoreSubject(leaves);
    // 루트도 region(균일성): swap 없는 단일 가지지만, anchor/branch.nodes를 자식과 똑같이 갖춰
    // attachIf가 분기 없이 처리한다. 루트 anchor 주석은 인스턴스 노드의 맨 앞에 선다.
    const regionPool: TRegion[] = []; // 한 인스턴스의 모든 Region. alloc/free(@for 회차 제거 시 자식 region 반납).
    const freeRegions: number[] = []; // regionPool의 빈 칸 인덱스(freelist). alloc이 재사용한다.
    const branchPool: TBranch[] = []; // 한 인스턴스의 모든 Branch. alloc/free(@for 회차 제거 시 반납).
    const freeBranches: number[] = []; // branchPool의 빈 칸 인덱스(freelist). alloc이 재사용한다.
    // 만들어진 컨텍스트 저장소. EnterContext마다 { name, fields }를 append하고 그 인덱스를
    // activeContexts에 싣는다. fields는 그 시점 argumentSourcePairs로 푼 leafIndex라 인스턴스마다 달라 공유
    // 안 됨. 지금은 append만(회수는 @for+leafIndex 회수 때 - ISSUES).
    const createdContexts: TCreatedContext[] = [];
    const rootRegion = regionPool[appendIfRegion(regionPool, freeRegions, branchPool, freeBranches, -1)]; // 루트도 region(인덱스 0)
    branchPool[rootRegion.branchIndices[THEN_INDEX]].built = true; // 루트 then은 즉시 build됨(아래 interpret)
    rootRegion.shownIndex = THEN_INDEX;

    // 한 가지(startPc~endPc)를 build한다 - 노드는 fragment로 반환, 구독은 해당 가지에 쌓는다.
    //
    // 재진입 가능: 최초 인스턴스화는 루트 전체를, lazy build는 swap으로 처음 켜지는 가지 범위만
    // 해석한다. 자식 IF는 활성 가지를 재귀로 즉시 build하고 비활성 가지엔 lazyBuild만 심는다.
    // RENDER는 자식 def 구간을 자식 argumentSourcePairs로 이 함수에 재진입해 인라인 합성한다(별도 인스턴스/
    // 루트 region 없이 부모 가지 안에 합류).
    //
    // @param code             해석할 바이트코드(자식은 자식 def 구간)
    // @param argumentSourcePairs            offset -> store 경로 매핑(자식은 자식 argumentSourcePairs)
    // @param events           현재 def의 이벤트 테이블(BIND_EVENT가 event_idx로 참조. 자식은 자식 def의 것)
    // @param contexts         현재 def의 컨텍스트 테이블(ENTER_CONTEXT가 context_index로 참조. 자식은 자식 def의 것)
    // @param activeContexts   지금 감싼 @with 컨텍스트 누적([{ name, fields }]). RENDER가 자식에 물려준다.
    // @param startPc, endPc   해석 범위(endPc는 IF_END 직전)
    // @param startRegionIndex 구독을 쌓을 region
    // @param startBranchIndex 구독을 쌓을 가지의 전역 branchIndex(branchPool[startBranchIndex])
    // @param pathPrefix       이벤트 fullname의 누적 경로(루트 ""). RENDER가 자식 type-name을 잇는다.
    // @returns                직속 노드를 담은 DocumentFragment
    const interpret = (
      code: Uint8Array,
      argumentSourcePairs: (string | number)[],
      events: TEventEntry[],
      contexts: TEventEntry[],
      activeContexts: number[],
      startPc: number,
      endPc: number,
      startRegionIndex: number,
      startBranchIndex: number,
      pathPrefix: string,
      loopIndexStack: number[],
      loopIndexBase: number,
    ) => {
      const fragment = document.createDocumentFragment();
      const nodeStack: Node[] = [fragment]; // 노드 스택 - DOM 부모 추적
      let pending: HTMLElement | null = null;
      let args = [];
      let segment: string | null = null; // 다음 RENDER/BIND_EVENT가 소비할 경로 세그먼트(PUSH_PATH_SEGMENT/INDEX가 적재)
      let pc = startPc;

      // 이 interpret이 채우는 가지. 한 호출 = 한 가지라 불변(중첩 if는 재귀 호출이 자식 가지를
      // 새 컨텍스트로 받는다 - JS 호출 스택이 옛 region/branch 스택 역할을 대신한다).
      const branch = branchPool[startBranchIndex]; // startBranchIndex는 전역 branchIndex

      const u16at = () => {
        const v = code[pc] | (code[pc + 1] << 8);
        pc += 2;
        return v;
      };
      const u8at = () => code[pc++];
      const nodeTop = () => nodeStack[nodeStack.length - 1];

      // @for 회차 i의 몸체(bodyStart~forEndPc)를 해석해 fragment로 낸다. 노드·구독·자식region은
      // target 가지에 쌓인다(인라인이면 지금 가지, 반응이면 회차 branch). 회차 인덱스를 공유
      // 스택에 push -> 재귀 -> pop한다 - 매 회차 [...stack, i] 복사 대신 배열 하나를 재사용한다
      // (10만 회차 x 깊이만큼의 할당 제거). 재귀는 동기라 push된 상태에서 완료되고, 발화 인덱스는
      // BIND_EVENT가 바인딩 시점에 loopIndices로 스냅샷하므로(공유 배열을 잡지 않음) 재사용이 안전하다.
      const buildIteration = (
        i: number,
        bodyStart: number,
        forEndPc: number,
        targetRegionIndex: number,
        targetBranchIndex: number,
      ) => {
        loopIndexStack.push(i);
        const f = interpret(
          code,
          argumentSourcePairs,
          events,
          contexts,
          activeContexts,
          bodyStart,
          forEndPc,
          targetRegionIndex,
          targetBranchIndex,
          pathPrefix,
          loopIndexStack, // 회차 값을 물려준다(발화 시 $n)
          loopIndexBase, // base는 그대로 - 이 @for는 몸체의 operand로 표현된다
        );
        loopIndexStack.pop();
        return f;
      };

      // 안 변하는 @for(FOR_RAW·CONST) - 각 회차를 지금 가지(startRegion/Branch)에 fragment로
      // 인라인한다. @for는 컴포넌트 경계가 아니라 같은 가지의 제어 흐름이라 부모 노드에 통째로
      // 붙인다. appendChild(fragment)는 내용 전체를 한 번에 옮기고 fragment를 비운다(노드별 재입양
      // 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는 라이브라 순회 중 인덱스가 밀려 건너뛴다.
      const inlineFor = (count: number, bodyStart: number, forEndPc: number) => {
        for (let i = 0; i < count; i++) {
          nodeTop().appendChild(buildIteration(i, bodyStart, forEndPc, startRegionIndex, startBranchIndex));
        }
      };

      // 숫자 count 반응 @for(FOR_SCOPE_INDEX+STORE, 값이 숫자) - 전용 region을 만들어 회차마다 branch
      // 하나에 노드·구독·자식region을 격리한다(count 줄 때 그 회차만 통째로 떼기 위함). anchor를 지금
      // 가지에 남기고 회차 노드는 anchor 뒤에 붙는다. 초기엔 branch.nodes만 채운다(부모 attachIf가
      // 루트부터 일괄 attach할 때 이 region도 childRegionIndices 재귀로 붙는다 - @if 자식과 동일).
      // count leaf 구독이 꼬리 회차를 늘리고(build+attach) 줄인다(truncate).
      const reactiveCountFor = (countLeafIndex: number, bodyStart: number, forEndPc: number) => {
        const forRegionIndex = appendForRegion(regionPool, freeRegions, countLeafIndex);
        const region = regionPool[forRegionIndex];
        branch.childRegionIndices.push(forRegionIndex); // 부모 가지에 자식 등록(detach 재귀 대상)
        nodeTop().appendChild(region.anchor);

        // 회차 branch 하나를 추가하고 build해 담는다(interpret이 fragment로 낸 노드를 detach 때
        // 되찾게 branch.nodes에 보관). 껍데기 push(appendBranchOfForRegion) + build(buildIteration).
        // 새 회차의 전역 branchIndex를 돌려준다.
        const addIterationBranch = (i: number) => {
          const newBranchIndex = appendBranchOfForRegion(regionPool, branchPool, freeBranches, forRegionIndex);
          branchPool[newBranchIndex].nodes = Array.from(
            buildIteration(i, bodyStart, forEndPc, forRegionIndex, newBranchIndex).childNodes,
          );
          return newBranchIndex;
        };

        const initial = Number(store.get(countLeafIndex)) || 0;
        for (let i = 0; i < initial; i++) {
          addIterationBranch(i);
        }

        const onCount = (v: unknown) => {
          const next = Number(v) || 0;
          const cur = region.branchIndices.length;
          for (let i = cur; i < next; i++) {
            attachForIteration(store, regionPool, branchPool, region, addIterationBranch(i)); // 늘어난 꼬리만 build+attach
          }
          if (next < cur) {
            truncateFor(store, regionPool, freeRegions, branchPool, freeBranches, region, next); // 줄어든 꼬리 제거
          }
        };
        // 부모 가지 구독에 실어 생애를 함께 한다 - 부모가 detach/free되면 count 감시도 꺼진다.
        branch.leafIndices.push(countLeafIndex);
        branch.updateFns.push(onCount);
        store.subscribe(countLeafIndex, onCount);
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
      const bindVar = (scopeIndex: number, offset: number, update: (v: unknown) => void) => {
        const ref = argumentSourcePairs[2 * scopeIndex + 1];
        if (argumentSourcePairs[2 * scopeIndex] === CONST) {
          // 상수: 상수풀 직접 참조. 안 변하니 구독은 죽은 구독 - 스킵한다.
          return module.constpool[ref as number] ?? "";
        }
        // STORE 슬롯의 ref는 base leafIndex. 객체 필드면 base+offset이 그 leaf.
        const leafIndex = (ref as number) + offset;
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
            // 스킵(한 compile의 여러 컴포넌트/인스턴스가 같은 리소스를 써도 한 번만). 삽입한 href를
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
            // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            pending!.setAttribute(name, module.constpool[u16at()] as string);
            break;
          }
          case OP.ATTR_L: {
            const name = module.constpool[u16at()] as string;
            // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            pending!.setAttribute(name, module.constpool[u16at()] as string);
            break;
          }
          case OP.ATTR_G_VAR: {
            const name = ATTRS[u16at()];
            const scopeIndex = u8at();
            const offset = u8at();
            // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            const el = pending!;
            const v = bindVar(scopeIndex, offset, (v) => el.setAttribute(name, v as string));
            el.setAttribute(name, v as string);
            break;
          }
          case OP.ATTR_L_VAR: {
            const name = module.constpool[u16at()] as string;
            const scopeIndex = u8at();
            const offset = u8at();
            // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            const el = pending!;
            const v = bindVar(scopeIndex, offset, (v) => el.setAttribute(name, v as string));
            el.setAttribute(name, v as string);
            break;
          }
          case OP.BIND_EVENT: {
            // 지금 여는 요소(pending)에 리스너를 단다. event_type=DOM 이벤트, event_idx=이 def의 이벤트.
            const domEvent = DOM_EVENTS[u16at()];
            const event = events[u16at()];
            const eventName = module.constpool[event.nameConstIndex] as string;
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
              name: module.constpool[field.nameConstIndex] as string,
              typeRef: field.typeRef,
              fieldSourcePairs: refToSourcePairs(field.ref, leafCountOf(module, field.typeRef), argumentSourcePairs),
            }));
            // props: 핸들러의 set/get 대상(필드명 -> leafIndex). 스칼라 field 중 STORE만 - 상수
            // 슬롯은 불변이라 set 대상이 못 된다. 객체의 set 의미는 미정(ISSUES). data(읽기)는
            // 객체까지 조립된다.
            const props: Record<string, number> = {};
            for (const p of payload) {
              if (module.types[p.typeRef].tag === "scalar" && p.fieldSourcePairs[0] === STORE) {
                props[p.name] = p.fieldSourcePairs[1];
              }
            }
            // 지금 활성인 컨텍스트들을 context명 -> (필드명 -> leafIndex)로 묶는다(바인딩 시점 고정).
            // 같은 이름은 뒤(안쪽)가 덮는다 - activeContexts 순서대로 돌아 안쪽이 마지막에 쓰인다.
            const contextLeaves: Record<string, TAssembled[]> = {};
            for (const i of activeContexts) {
              const created = createdContexts[i];
              contextLeaves[created.name] = created.fields;
            }
            // @for 회차 인덱스를 바인딩 시점에 스냅샷($0=바깥, $1=안쪽...). 발화 때 핸들러
            // 인자로 편다. fullname의 [$n] 정적 표기와 짝 - 이건 실제 회차값이다.
            const loopIndices: Partial<{ [key in TIndexSymbol]: number }> = {};
            for (let i = 0; i < loopIndexStack.length; i++) {
              loopIndices[`$${i}` as TIndexSymbol] = loopIndexStack[i];
            }
            // element별 리스너 대신 발화 바인딩을 WeakMap에 심고 document 위임을 켠다.
            // 한 element에 DOM 이벤트 타입이 여럿 붙을 수 있어 타입별로 담는다.
            // biome-ignore lint/style/noNonNullAssertion: BIND_EVENT는 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            const el = pending!;
            let bound = eventBindings.get(el);
            if (!bound) {
              bound = {};
              eventBindings.set(el, bound);
            }
            bound[domEvent] = {
              handlers,
              fullName,
              payload,
              contextLeaves,
              props,
              loopIndices,
              store,
              module,
            };
            ensureDelegate(domEvent);
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
            nodeTop().appendChild(document.createTextNode(module.constpool[u16at()] as string));
            break;
          }
          case OP.TEXT_VAR: {
            const node = document.createTextNode("");
            const scopeIndex = u8at();
            const offset = u8at();
            node.textContent = bindVar(scopeIndex, offset, (v) => (node.textContent = v as string)) as string;
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
            args.push(argumentSourcePairs[2 * scopeIndex], argumentSourcePairs[2 * scopeIndex + 1]);
            break;
          }
          case OP.PUSH_FIELD: {
            // 필드 참조 - 부모 슬롯 base에 offset을 더해 자식에 넘긴다. kind는 그대로 전파,
            // 위치만 옮긴다. CONST 슬롯은 필드가 없어(리터럴은 객체 아님) FIELD로 오지 않는다.
            const scopeIndex = u8at();
            const offset = u8at();
            args.push(argumentSourcePairs[2 * scopeIndex], (argumentSourcePairs[2 * scopeIndex + 1] as number) + offset);
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
            segment = module.constpool[u16at()] as string;
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
            const contextDef = contexts[u16at()];
            const name = module.constpool[contextDef.nameConstIndex as number] as string;
            // payload와 같은 조립 준비 - leaf만 미리 풀고 steps는 조회 시 lazy. 발생 시 context 조립.
            const fields: TAssembled[] = contextDef.fields.map((field) => ({
              name: module.constpool[field.nameConstIndex] as string,
              typeRef: field.typeRef,
              fieldSourcePairs: refToSourcePairs(field.ref, leafCountOf(module, field.typeRef), argumentSourcePairs),
            }));
            // 맥락은 같은 이름이 중복으로 쌓이지 않는 게 맞다(ISSUES). 일어나면 알리고, 가장
            // 안쪽이 이기도록 그냥 쌓는다(context 조립이 뒤(=안쪽) 것으로 덮는다).
            if (activeContexts.some((i) => createdContexts[i].name === name)) {
              console.warn(`quble: 컨텍스트 '${name}'가 중복 활성화됐습니다(안쪽이 우선).`);
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
            const childArgumentSourcePairs = args;
            args = [];
            // 자식 경로 prefix = 부모 prefix + 세그먼트. 이벤트 fullname의 path 축을 누적한다.
            const childPrefix = pathPrefix ? `${pathPrefix}.${segment}` : segment;
            segment = null;
            // 합성 = 인라인 재진입. 자식 def의 code 구간을 자식 argumentSourcePairs로 같은 interpret에 돌린다.
            // 시작 가지 = 지금 이 가지(startRegionIndex/startBranchIndex) -> 자식 IF는 이 가지의
            // childRegionIndices에 합류하고 같은 regionPool 배열에 append된다(인덱스 전역 유일).
            // 자식 루트 region 없음 - 자식 직속 노드는 fragment로 모여 RENDER 위치에 붙는다.
            const childDef = module.defs[childCompId];
            const childFragment = interpret(
              module.code,
              childArgumentSourcePairs,
              childDef.events, // 자식 BIND_EVENT는 자식 def의 이벤트 테이블을 본다
              childDef.contexts, // 자식 ENTER_CONTEXT는 자식 def의 컨텍스트 테이블을 본다
              activeContexts, // 부모 활성 컨텍스트를 공유로 물려준다 - 자식의 ENTER/EXIT_CONTEXT는
              // @with 경계마다 push/pop 짝이라 자식 반환 시 원상복구된다(RENDER는 반환 후
              // activeContexts를 다시 읽지 않아 오염 여지도 없다). 매 RENDER의 [...] 복사 제거.
              childDef.codeOff,
              childDef.codeOff + childDef.codeLen,
              startRegionIndex,
              startBranchIndex,
              // biome-ignore lint/style/noNonNullAssertion: RENDER 지점엔 PUSH_PATH_SEGMENT가 깐 segment가 있어 childPrefix는 non-null(바이트코드 순서 보장)
              childPrefix!,
              loopIndexStack, // 자식은 회차 값을 물려받는다(발화 시 $n)
              loopIndexStack.length, // 자식 세그먼트 인덱스의 base = 여기까지 누적된 @for 깊이
            );
            // fragment를 통째로 붙인다 - appendChild(fragment)는 내용 전체를 한 번에 옮기고
            // fragment를 비운다(노드별 재입양 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는
            // 라이브라 순회 중 인덱스가 밀려 건너뛴다.
            nodeTop().appendChild(childFragment);
            break;
          }
          case OP.IF: {
            const condScopeIndex = u8at();
            const condOffset = u8at();
            // 조건 슬롯도 STORE/CONST 위임 처리. CONST(부모가 리터럴로 준 prop)는 값이 안
            // 변하니 leafIndex도 구독도 없다 - condLeafIndex=-1(region이 이 값을 읽지 않는다).
            const condIsConst = argumentSourcePairs[2 * condScopeIndex] === CONST;
            const condRef = argumentSourcePairs[2 * condScopeIndex + 1];
            const condLeafIndex = condIsConst ? -1 : (condRef as number) + condOffset;
            const regionIndex = appendIfRegion(regionPool, freeRegions, branchPool, freeBranches, condLeafIndex);
            const region = regionPool[regionIndex];
            branch.childRegionIndices.push(regionIndex); // 부모(이 interpret의) 가지에 자식 등록
            const thenBranchIndex = region.branchIndices[THEN_INDEX];
            const elseBranchIndex = region.branchIndices[ELSE_INDEX];
            const thenBranch = branchPool[thenBranchIndex];
            const elseBranch = branchPool[elseBranchIndex];
            // anchor(if 자리 고정용 주석)는 appendIfRegion이 만들었다. 여기서 DOM 트리에 붙인다.
            nodeTop().appendChild(region.anchor);

            // then/else 코드 경계. thenStart = IF operand 직후(현재 pc).
            const thenStart = pc;
            const { thenEnd, elseStart, ifEndPc } = ifBranchRanges(code, thenStart);

            // 각 가지를 build하는 클로저. 활성 가지는 지금 호출하고, 비활성 가지는 심어만 둔다.
            const buildThen = () => {
              const f = interpret(
                code,
                argumentSourcePairs,
                events,
                contexts,
                activeContexts, // 가지는 같은 컨텍스트 범위 - 그대로 물려받는다
                thenStart,
                thenEnd,
                regionIndex,
                thenBranchIndex,
                pathPrefix, // 가지 안의 합성도 부모 경로를 물려받는다
                loopIndexStack, // @if는 @for 깊이를 안 늘린다 - 그대로 물려받는다
                loopIndexBase,
              );
              thenBranch.nodes = Array.from(f.childNodes);
            };
            const buildElse = () => {
              const f =
                elseStart === -1
                  ? document.createDocumentFragment() // else 없는 if - 빈 가지
                  : interpret(
                      code,
                      argumentSourcePairs,
                      events,
                      contexts,
                      activeContexts, // 가지는 같은 컨텍스트 범위 - 그대로 물려받는다
                      elseStart,
                      ifEndPc,
                      regionIndex,
                      elseBranchIndex,
                      pathPrefix, // 가지 안의 합성도 부모 경로를 물려받는다
                      loopIndexStack, // @if는 @for 깊이를 안 늘린다 - 그대로 물려받는다
                      loopIndexBase,
                    );
              elseBranch.nodes = Array.from(f.childNodes);
            };
            thenBranch.lazyBuild = buildThen;
            elseBranch.lazyBuild = buildElse;

            // cond 변경 시 해당 가지를 활성화(swap). 첫 활성화면 activateIf가 lazyBuild 호출.
            // CONST 조건은 안 변하니 구독을 걸지 않는다(초기 가지로 고정).
            if (!condIsConst) {
              const onCond = (condValue: unknown) => {
                activateIf(store, regionPool, branchPool, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
              };
              // 부모 가지 구독에 실어 생애를 함께 한다 - 부모가 detach/free되면 조건 감시도 꺼진다.
              branch.leafIndices.push(condLeafIndex);
              branch.updateFns.push(onCond);
              store.subscribe(condLeafIndex, onCond);
            }
            // build는 "생성만" 한다 - 활성 가지를 lazyBuild로 만들어 자식 branch.nodes에 담고
            // shownIndex만 설정한다. DOM 부착/구독 등록은 하지 않는다(attachIf가 일괄).
            // 그래야 부모 fragment엔 anchor만 남아, 부모 branch.nodes가 자손까지 머금지 않는다.
            // (anchor는 평평한 형제라, 여기서 자식 노드를 붙이면 부모 nodes에 섞여 detach가 깨진다.)
            const condInitial = condIsConst ? module.constpool[condRef as number] : store.get(condLeafIndex);
            const initialShownIndex = condInitial ? THEN_INDEX : ELSE_INDEX;
            const initialBranch = branchPool[region.branchIndices[initialShownIndex]];
            // biome-ignore lint/style/noNonNullAssertion: 방금 buildThen/buildElse로 lazyBuild를 심었으니 null 아님
            initialBranch.lazyBuild!();
            initialBranch.built = true;
            region.shownIndex = initialShownIndex;

            pc = ifEndPc + 1; // IF_END 마커 소비 - if 블록 다음으로.
            break;
          }
          case OP.FOR_RAW: {
            // 소스에 박힌 리터럴 횟수 - 안 변하니 지금 가지(startRegion/Branch)에 count회 인라인.
            const count = Number(u16at()) || 0;
            const bodyStart = pc;
            const forEndPc = forBodyEnd(code, bodyStart);
            inlineFor(count, bodyStart, forEndPc);
            pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
            break;
          }
          case OP.FOR_SCOPE_INDEX: {
            // 슬롯 위임(@if 조건과 동형). CONST(부모가 리터럴로 준 prop)는 안 변하니 인라인,
            // STORE는 count leaf에 구독을 걸어 값이 바뀌면 꼬리 회차를 늘리고 줄인다.
            const scopeIndex = u16at();
            const ref = argumentSourcePairs[2 * scopeIndex + 1];
            const bodyStart = pc;
            const forEndPc = forBodyEnd(code, bodyStart);
            if (argumentSourcePairs[2 * scopeIndex] === CONST) {
              inlineFor(Number(module.constpool[ref as number]) || 0, bodyStart, forEndPc);
            } else {
              reactiveCountFor(ref as number, bodyStart, forEndPc);
            }
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

    // build: 트리(regionPool/branch.nodes/shownIndex)만 만든다. 루트 직속 노드는 fragment에 모여
    // 루트 가지에 담긴다(자식 region 노드는 아직 안 붙음 - 부모 nodes 오염 방지). 그 뒤
    // attachIf가 루트부터 재귀로 노드를 anchor 뒤에 끼우고 구독을 건다.
    // rootFlat은 plantRoot가 준 [STORE, base, …] - 루트 슬롯은 정의상 전부 외부 데이터 바인딩이라 STORE.
    const fragment = interpret(
      module.code,
      rootFlat,
      def.events, // 루트 def의 이벤트 테이블
      def.contexts, // 루트 def의 컨텍스트 테이블
      [], // 루트는 활성 컨텍스트 없음
      def.codeOff,
      def.codeOff + def.codeLen,
      0,
      rootRegion.branchIndices[THEN_INDEX],
      "", // 루트 경로 prefix 비어 있음
      [], // 루트는 @for 밖 - 회차 인덱스 없음
      0, // 세그먼트 인덱스 base 0
    );
    branchPool[rootRegion.branchIndices[THEN_INDEX]].nodes = Array.from(fragment.childNodes);
    fragment.prepend(rootRegion.anchor); // anchor를 루트 노드 앞에 - attach가 anchor.after로 채운다
    rootRegion.attach(store, regionPool, branchPool, rootRegion);
    // fragment 자식 전체(anchor + 붙은 트리)가 이 인스턴스의 루트 노드들(append 시 비워지므로 배열로).
    const nodes = Array.from(fragment.childNodes);
    // store를 인스턴스에 실어 반환 - 호출측이 set(leafIndex, v)로 반응성을 건다(옛 setPath 대체).
    return { nodes, regionPool, freeRegions, branchPool, freeBranches, arrayPool, store };
  };
};

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
  return (compId: number) => compileDef(module, compId, resources, loadedHrefs);
};

// 상태 저장소(store)는 leaf-store.js가 정의한다. blueprint가 받는 store가 이것 - 편의상 여기서 재공개한다.
export { createLeafStoreSubject };
