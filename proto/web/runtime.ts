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
  FOR_COUNT_VAR: 0x16,
  FOR_END: 0x17,
  PUSH_PATH_INDEX_SEGMENT: 0x18,
  PUSH_FIELD: 0x19,
  FOR_ARRAY_VAR: 0x1a,
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
    case OP.FOR_COUNT_VAR: // scope_index: u8, offset: u8
    case OP.FOR_ARRAY_VAR: // scope_index: u8, offset: u8
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
// 센다(같은 깊이 0의 FOR_END가 이 몸체 끝). IF는 몸체 안에 섞여도 여기선 무시 - @for 여는
// opcode(FOR_RAW/FOR_COUNT_VAR/FOR_ARRAY_VAR)와 FOR_END만 깊이에 관여한다.
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
// 경로(반응값, 구독), CONST는 참조가 상수풀 인덱스(불변, 구독 스킵), RAW는 참조가 값 자체
// (count @for의 회차 인덱스 - store에 안 앉는 회차 상수, 구독 스킵).
const STORE = 0;
const CONST = 1;
const RAW = 2;

// 스코프 - (kind, ref) 쌍을 인터리브로 담은 평탄 배열. 슬롯 offset o는 [2o]=kind, [2o+1]=ref.
type TScope = number[];

const slotKind = (scope: TScope, o: number): number => scope[2 * o];
const slotRef = (scope: TScope, o: number): number => scope[2 * o + 1];

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
// @param fieldSourcePairs 이 field의 flat 값-소스 [kind, ref, …](깊이우선, step의 LEAF 순서와 일치)

const assemble = (
  steps: TStep[],
  fieldSourcePairs: number[],
  store: TLeafStoreSubject,
  module: TModule,
  arrayPool: TArrayInfo[],
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
      const info = arrayPool[arrayInfoIndex];
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
    const arrayInfoIndex = appendArrayInfo(arrayPool, freeArrays, elemSize, t.elemTypeRef);
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
const plantRoot = (module: TModule, rootValue: unknown, arrayPool: TArrayInfo[], freeArrays: number[]) => {
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
  const {
    handlers,
    fullName,
    payload,
    contextLeaves,
    props,
    loopIndices,
    store,
    module,
    arrayPool,
    freeArrays,
    regionPool,
    freeRegions,
    branchPool,
    freeBranches,
  } = b;
  const data: Record<string, unknown> = {};
  for (const p of payload) {
    data[p.name] = assemble(compiledStepsOf(module, p.typeRef), p.fieldSourcePairs, store, module, arrayPool);
  }
  const context: Record<string, Record<string, unknown>> = {};
  for (const ctxName in contextLeaves) {
    const values: Record<string, unknown> = {};
    for (const p of contextLeaves[ctxName]) {
      values[p.name] = assemble(compiledStepsOf(module, p.typeRef), p.fieldSourcePairs, store, module, arrayPool);
    }
    context[ctxName] = values;
  }
  // 배열 요소 추가 - props의 배열 필드(arrayLeafIndex) 칸 값이 arrayInfoIndex다. 요소를 타입대로 store에 심고
  // (plantFixed로 로컬에 펴 store.alloc으로 삽입, 요소 안 중첩 배열은 plantRoot처럼 레벨별로 마저 심음),
  // 그 시작 leaf를 elemStartLeafIndices에 잇고 길이 칸(sizeLeafIndex)을 set해 @for grow를 깨운다. sizeLeafIndex가
  // null이면 이 배열은 아직 @for에 안 쓰여 grow 대상이 없다(목록만 갱신).
  const push = (arrayLeafIndex: number, elem: unknown): void => {
    const info = arrayPool[Number(store.get(arrayLeafIndex))];
    // 한 요소를 이 arrayInfo에 심는다: 고정부를 local에 펴(plantFixed) store.alloc으로 삽입하고 그 base를
    // elemStartLeafIndices에 잇는다. 요소 안 중첩 배열은 plantFixed가 deferred로 돌려주니, 그 배열들의 요소도
    // 같은 방식으로 재귀해 마저 심는다(plantRoot의 레벨 심기와 같되 store.alloc 삽입).
    const plantElem = (value: unknown, target: TArrayInfo): void => {
      const local: unknown[] = [];
      const deferred = plantFixed(value, target.elemTypeRef, module, local, arrayPool, freeArrays);
      target.elemStartLeafIndices.push(store.alloc(local));
      for (const d of deferred) {
        for (const child of d.value as unknown[]) {
          plantElem(child, arrayPool[d.arrayInfoIndex]);
        }
      }
    };
    plantElem(elem, info);
    // 인덱스 leaf도 동기로 하나 잇는다 - 단 이 배열이 @for로 순회 중일 때만(forRegionIndex). 순회 전이면
    // reactiveArrayFor의 lazy 채움에 맡긴다. "@for 순회 중"의 신호는 forRegionIndex지 indexLeafIndices.length가
    // 아니다 - 요소가 전부 제거돼 빈 배열(length 0)이어도 순회는 진행 중이라, length로 판단하면 이 채움을
    // 건너뛰어 인덱스 없는 요소가 쌓이고 region과 어긋난다. 새 요소는 꼬리라 인덱스 = 마지막 자리.
    const tail = info.elemStartLeafIndices.length - 1;
    if (info.forRegionIndex !== null) {
      info.indexLeafIndices[tail] = store.alloc([tail]);
    }
    if (info.sizeLeafIndex !== null) {
      store.set(info.sizeLeafIndex, info.elemStartLeafIndices.length); // @for grow 발화
    }
  };
  // 요소 하나(start, typeRef)를 회수한다 - 고정부를 타입대로 걸어 배열 칸(offset)을 만나면 그 자식 배열의 요소를
  // 재귀 회수하고 arrayInfo·길이 칸을 반납한다. 걷기가 끝나면 이 요소 고정 블록을 store.free. 제거된 요소의
  // 서브트리는 어디서도 참조되지 않으므로 안쪽까지 전부 반납해야 한다(누수 방지). 배열 칸 값이 arrayInfoIndex.
  const freeElem = (start: number, typeRef: number): void => {
    let cursor = start;
    const walk = (ref: number): void => {
      const t = module.types[ref];
      if (t.tag === "object") {
        for (const [, childTypeRef] of t.fields) {
          walk(childTypeRef);
        }
        return;
      }
      if (t.tag === "array") {
        const child = arrayPool[Number(store.get(cursor))];
        for (const elemStart of child.elemStartLeafIndices) {
          freeElem(elemStart, child.elemTypeRef);
        }
        if (child.sizeLeafIndex !== null) {
          store.free(child.sizeLeafIndex, 1); // @for에 쓰였으면 길이 칸도 회수(region은 removeBranchAt 재귀가 뗌)
        }
        freeArrayInfo(arrayPool, freeArrays, Number(store.get(cursor)));
      }
      cursor += 1; // 스칼라·배열 칸 하나 소비
    };
    walk(typeRef);
    store.free(start, leafCountOf(module, typeRef));
  };
  // 배열 요소 제거 - i번째 요소를 재귀 회수(freeElem)하고 목록(elemStartLeafIndices)에서 뺀다. @for에 쓰였으면
  // (forRegionIndex) 그 region의 i번째 회차 DOM만 뗀다 - 나머지 회차는 자기 요소 leaf를 그대로 보므로 무손상
  // (재빌드·재바인딩 없음). 중간 제거라 뒤 목록이 당겨지지만 store의 요소 leaf는 안 움직인다. 길이 칸
  // (sizeLeafIndex)을 새 개수로 set해 둔다 - DOM과 목록을 이미 손수 줄여 놨으니 그 발화(onSize)는 next===cur라
  // no-op이고(이중 제거 없음), 목적은 값을 진실과 맞춰 다음 push의 grow 발화가 동등성에 안 막히게 하는 것이다.
  const removeAt = (arrayLeafIndex: number, i: number): void => {
    const info = arrayPool[Number(store.get(arrayLeafIndex))];
    if (info.forRegionIndex !== null) {
      removeBranchAt(store, regionPool, freeRegions, branchPool, freeBranches, info.forRegionIndex, i);
    }
    freeElem(info.elemStartLeafIndices[i], info.elemTypeRef);
    info.elemStartLeafIndices.splice(i, 1);
    // 인덱스 leaf 처리(@for로 순회 중일 때만 - push와 같은 forRegionIndex 기준) - i번째 인덱스 칸을 회수하고
    // 목록에서 뺀 뒤, 뒤로 당겨진 요소들의 인덱스 leaf를 새 자리 번호로 set한다. 이 leaf를 몸체 {i}가 구독하고
    // $n이 발화 시 읽으므로, 중간 제거로 뒤가 당겨져도 표시·이벤트 인덱스가 자동 정합한다(값 고정·위치 이동 설계).
    if (info.forRegionIndex !== null) {
      store.free(info.indexLeafIndices[i], 1);
      info.indexLeafIndices.splice(i, 1);
      for (let k = i; k < info.indexLeafIndices.length; k++) {
        store.set(info.indexLeafIndices[k], k); // 뒤 인덱스 당김 발화
      }
    }
    if (info.sizeLeafIndex !== null) {
      store.set(info.sizeLeafIndex, info.elemStartLeafIndices.length);
    }
  };
  // 회차 인덱스를 발화 시점에 읽는다 - STORE면 store.get(ref)(array-for: 중간 제거로 당겨진 현재 인덱스),
  // RAW면 ref 값 자체(count-for: 상수). 이제서야 읽어야 array-for $n이 정합한다(바인딩 시점 값은 낡을 수 있다).
  const currentIndices: Record<string, number> = {};
  for (const key in loopIndices) {
    const src = loopIndices[key as TIndexSymbol];
    if (src) {
      currentIndices[key] = src.kind === STORE ? (store.get(src.ref) as number) : src.ref;
    }
  }
  handlers[fullName]?.(data, {
    event: domEventObject,
    set: store.set,
    get: store.get,
    push,
    removeAt,
    props,
    context,
    ...currentIndices,
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
  loopIndices: Partial<{ [key in TIndexSymbol]: { kind: number; ref: number } }>; // 회차 인덱스 소스(kind, ref) - 발화 시 store.get(STORE)/값(RAW)으로 해소

  store: TLeafStoreSubject;
  module: TModule;
  arrayPool: TArrayInfo[];
  freeArrays: number[];
  regionPool: TRegion[]; // removeAt이 요소 회차 DOM(region)을 뗄 때 필요
  freeRegions: number[];
  branchPool: TBranch[];
  freeBranches: number[];
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
  arrayPool: TArrayInfo[];
  freeArrays: number[];
  regionPool: TRegion[];
  freeRegions: number[];
  branchPool: TBranch[];
  freeBranches: number[];
  createdContexts: TCreatedContext[];

  constructor(
    module: TModule,
    handlers: THandlers,
    resources: string[],
    loadedHrefs: Set<unknown>,
    store: TLeafStoreSubject,
    arrayPool: TArrayInfo[],
    freeArrays: number[],
    regionPool: TRegion[],
    freeRegions: number[],
    branchPool: TBranch[],
    freeBranches: number[],
    createdContexts: TCreatedContext[],
  ) {
    this.module = module;
    this.code = module.code;
    this.handlers = handlers;
    this.resources = resources;
    this.loadedHrefs = loadedHrefs;
    this.store = store;
    this.arrayPool = arrayPool;
    this.freeArrays = freeArrays;
    this.regionPool = regionPool;
    this.freeRegions = freeRegions;
    this.branchPool = branchPool;
    this.freeBranches = freeBranches;
    this.createdContexts = createdContexts;
  }

  componentEvents = (componentId: number): TEventEntry[] => {
    return this.module.defs[componentId].events;
  };

  componentContexts = (componentId: number): TEventEntry[] => {
    return this.module.defs[componentId].contexts;
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
  // @param activeContexts   지금 감싼 @with 컨텍스트 누적([{ name, fields }]). RENDER가 자식에 물려준다.
  // @param startPc, endPc   해석 범위(endPc는 IF_END 직전)
  // @param startBranchIndex 구독을 쌓을 가지의 전역 branchIndex(branchPool[startBranchIndex])
  // @param pathPrefix       이벤트 fullname의 누적 경로(루트 ""). RENDER가 자식 type-name을 잇는다.
  // @param loopIndexStack   @for 회차 인덱스 소스 누적(인터리브 kind,ref). buildIteration이 회차마다 push/pop해 물려준다.
  // @returns                직속 노드를 담은 DocumentFragment
  interpret = (
    argumentSourcePairs: TScope,
    compId: number,
    activeContexts: number[],
    startPc: number,
    endPc: number,
    startBranchIndex: number,
    pathPrefix: string,
    loopIndexStack: number[],
    loopIndexBase: number,
  ): DocumentFragment => {
    const fragment = document.createDocumentFragment();
    const nodeStack: Node[] = [fragment]; // 노드 스택 - DOM 부모 추적
    let pending: HTMLElement | null = null;
    let args = [];
    let segment: string | null = null; // 다음 RENDER/BIND_EVENT가 소비할 경로 세그먼트(PUSH_PATH_SEGMENT/INDEX가 적재)
    let pc = startPc;

    // 이 interpret이 채우는 가지. 한 호출 = 한 가지라 불변(중첩 if는 재귀 호출이 자식 가지를
    // 새 컨텍스트로 받는다 - JS 호출 스택이 옛 region/branch 스택 역할을 대신한다).
    const branch = this.branchPool[startBranchIndex]; // startBranchIndex는 전역 branchIndex

    const u16at = () => {
      const v = this.code[pc] | (this.code[pc + 1] << 8);
      pc += 2;
      return v;
    };
    const u8at = () => this.code[pc++];
    const nodeTop = () => nodeStack[nodeStack.length - 1];

    // @for 회차 i의 몸체(bodyStart~forEndPc)를 해석해 fragment로 낸다. 노드·구독·자식region은
    // target 가지에 쌓인다(인라인이면 지금 가지, 반응이면 회차 branch). 회차 인덱스를 공유
    // 스택에 push -> 재귀 -> pop한다 - 매 회차 [...stack, i] 복사 대신 배열 하나를 재사용한다
    // (10만 회차 x 깊이만큼의 할당 제거). 재귀는 동기라 push된 상태에서 완료되고, 발화 인덱스는
    // BIND_EVENT가 바인딩 시점에 loopIndices로 스냅샷하므로(공유 배열을 잡지 않음) 재사용이 안전하다.
    const buildIteration = (
      indexKind: number,
      indexRef: number,
      bodyStart: number,
      forEndPc: number,
      targetBranchIndex: number,
    ) => {
      loopIndexStack.push(indexKind, indexRef); // 인터리브 (kind, ref) - argumentSourcePairs와 동형. count-for는 (RAW, i), array-for는 (STORE, 인덱스 leaf)
      const f = this.interpret(
        argumentSourcePairs,
        compId,
        activeContexts,
        bodyStart,
        forEndPc,
        targetBranchIndex,
        pathPrefix,
        loopIndexStack, // 회차 인덱스 소스를 물려준다(발화 시 $n으로 해소)
        loopIndexBase, // base는 그대로 - 이 @for는 몸체의 operand로 표현된다
      );
      loopIndexStack.pop(); // ref
      loopIndexStack.pop(); // kind
      return f;
    };

    // 안 변하는 @for(FOR_RAW·CONST) - 각 회차를 지금 가지(startRegion/Branch)에 fragment로
    // 인라인한다. @for는 컴포넌트 경계가 아니라 같은 가지의 제어 흐름이라 부모 노드에 통째로
    // 붙인다. appendChild(fragment)는 내용 전체를 한 번에 옮기고 fragment를 비운다(노드별 재입양
    // 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는 라이브라 순회 중 인덱스가 밀려 건너뛴다.
    const inlineFor = (count: number, bodyStart: number, forEndPc: number) => {
      for (let i = 0; i < count; i++) {
        argumentSourcePairs.push(RAW, i, RAW, i); // 슬롯 2칸 - item(회차값)·index 모두 [RAW,i](리터럴은 반응성 없어 상수)
        nodeTop().appendChild(buildIteration(RAW, i, bodyStart, forEndPc, startBranchIndex));
        argumentSourcePairs.pop(); // index ref
        argumentSourcePairs.pop(); // index kind
        argumentSourcePairs.pop(); // item ref
        argumentSourcePairs.pop(); // item kind
      }
    };

    // 숫자 count 반응 @for(FOR_SCOPE_INDEX+STORE, 값이 숫자) - 전용 region을 만들어 회차마다 branch
    // 하나에 노드·구독·자식region을 격리한다(count 줄 때 그 회차만 통째로 떼기 위함). anchor를 지금
    // 가지에 남기고 회차 노드는 anchor 뒤에 붙는다. 초기엔 branch.nodes만 채운다(부모 attachIf가
    // 루트부터 일괄 attach할 때 이 region도 childRegionIndices 재귀로 붙는다 - @if 자식과 동일).
    // count leaf 구독이 꼬리 회차를 늘리고(build+attach) 줄인다(truncate).
    const reactiveCountFor = (countLeafIndex: number, bodyStart: number, forEndPc: number) => {
      const forRegionIndex = appendForRegion(this.regionPool, this.freeRegions, countLeafIndex);
      const region = this.regionPool[forRegionIndex];
      branch.childRegionIndices.push(forRegionIndex); // 부모 가지에 자식 등록(detach 재귀 대상)
      nodeTop().appendChild(region.anchor);

      // 회차 branch 하나를 추가하고 build해 담는다(interpret이 fragment로 낸 노드를 detach 때
      // 되찾게 branch.nodes에 보관). 껍데기 push(appendBranchOfForRegion) + build(buildIteration).
      // 새 회차의 전역 branchIndex를 돌려준다.
      // 몸체 `{i}`가 읽을 회차변수(인덱스) 슬롯을 [RAW, i]로 밀고 build 후 되돌린다
      // (array-for와 같은 push/pop 규칙). 슬롯 번호는 그 시점 pairs 길이/2 = props+바깥 회차변수 뒤.
      const addIterationBranch = (i: number) => {
        const newBranchIndex = appendBranchOfForRegion(
          this.regionPool,
          this.branchPool,
          this.freeBranches,
          forRegionIndex,
        );
        argumentSourcePairs.push(RAW, i, RAW, i); // 슬롯 2칸 - item(회차값)·index 모두 [RAW,i](count-for는 중간 제거 없어 인덱스 상수)
        this.branchPool[newBranchIndex].nodes = Array.from(
          buildIteration(RAW, i, bodyStart, forEndPc, newBranchIndex).childNodes,
        );
        argumentSourcePairs.pop(); // index ref
        argumentSourcePairs.pop(); // index kind
        argumentSourcePairs.pop(); // item ref
        argumentSourcePairs.pop(); // item kind
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
          attachForIteration(this.store, this.regionPool, this.branchPool, region, addIterationBranch(i)); // 늘어난 꼬리만 build+attach
        }
        if (next < cur) {
          truncateFor(this.store, this.regionPool, this.freeRegions, this.branchPool, this.freeBranches, region, next); // 줄어든 꼬리 제거
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
    const reactiveArrayFor = (arrayLeafIndex: number, bodyStart: number, forEndPc: number) => {
      const info = this.arrayPool[Number(this.store.get(arrayLeafIndex))];
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

      const forRegionIndex = appendForRegion(this.regionPool, this.freeRegions, sizeLeafIndex);
      info.forRegionIndex = forRegionIndex; // removeAt이 이 region의 회차 DOM을 뗀다
      const region = this.regionPool[forRegionIndex];
      branch.childRegionIndices.push(forRegionIndex);
      nodeTop().appendChild(region.anchor);

      // array-for는 슬롯 2칸 - [STORE, 요소 base], [STORE, 인덱스 leaf] 순. 요소 슬롯은 몸체가 요소 필드를
      // (count-for의 [RAW,i]와 같은 push/pop 규칙), 인덱스 슬롯은 몸체 {i}가 읽는다. 인덱스 leaf는 발화 시
      // $n으로도 해소되게 loopIndexStack에 (STORE, 인덱스 leaf)로 실어 물려준다. 슬롯 번호 = props + 바깥 슬롯 뒤.
      const addIterationBranch = (i: number) => {
        const newBranchIndex = appendBranchOfForRegion(
          this.regionPool,
          this.branchPool,
          this.freeBranches,
          forRegionIndex,
        );
        const indexLeaf = info.indexLeafIndices[i];
        argumentSourcePairs.push(STORE, info.elemStartLeafIndices[i], STORE, indexLeaf);
        this.branchPool[newBranchIndex].nodes = Array.from(
          buildIteration(STORE, indexLeaf, bodyStart, forEndPc, newBranchIndex).childNodes,
        );
        argumentSourcePairs.pop(); // 인덱스 ref
        argumentSourcePairs.pop(); // 인덱스 kind
        argumentSourcePairs.pop(); // 요소 ref
        argumentSourcePairs.pop(); // 요소 kind
        return newBranchIndex;
      };

      for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
        addIterationBranch(i);
      }

      const onSize = () => {
        const next = info.elemStartLeafIndices.length; // store 값이 아니라 요소 목록 길이가 진실
        const cur = region.branchIndices.length;
        for (let i = cur; i < next; i++) {
          attachForIteration(this.store, this.regionPool, this.branchPool, region, addIterationBranch(i)); // 늘어난 꼬리만 build+attach
        }
        if (next < cur) {
          truncateFor(this.store, this.regionPool, this.freeRegions, this.branchPool, this.freeBranches, region, next); // 줄어든 꼬리 제거
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
    const bindVar = (scopeIndex: number, offset: number, update: (v: unknown) => void) => {
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
          const v = bindVar(scopeIndex, offset, (v) => el.setAttribute(name, v as string));
          el.setAttribute(name, v as string);
          break;
        }
        case OP.ATTR_L_VAR: {
          const name = this.module.constpool[u16at()] as string;
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
          // props: 핸들러의 상태변경 대상(필드명 -> leafIndex). STORE 슬롯만 - 상수 슬롯은 불변이라 대상이
          // 못 된다. 스칼라는 그 leaf(set/get 대상), 배열은 배열 칸 leaf(push 대상 - 그 값이 arrayInfoIndex).
          // 객체의 set 의미는 미정(ISSUES). data(읽기)는 객체까지 조립된다.
          const props: Record<string, number> = {};
          for (const p of payload) {
            const tag = this.module.types[p.typeRef].tag;
            if ((tag === "scalar" || tag === "array") && p.fieldSourcePairs[0] === STORE) {
              props[p.name] = p.fieldSourcePairs[1];
            }
          }
          // 지금 활성인 컨텍스트들을 context명 -> (필드명 -> leafIndex)로 묶는다(바인딩 시점 고정).
          // 같은 이름은 뒤(안쪽)가 덮는다 - activeContexts 순서대로 돌아 안쪽이 마지막에 쓰인다.
          const contextLeaves: Record<string, TAssembled[]> = {};
          for (const i of activeContexts) {
            const created = this.createdContexts[i];
            contextLeaves[created.name] = created.fields;
          }
          // @for 회차 인덱스 소스를 바인딩 시점에 굳힌다($0=바깥, $1=안쪽...). loopIndexStack은 인터리브
          // (kind, ref)라 i번째 $는 [2i]=kind, [2i+1]=ref. 값을 지금 굳히지 않고 (kind, ref)로 들었다가
          // 발화 때 해소하는 이유: array-for(STORE) 인덱스는 그 사이 중간 제거로 뒤 인덱스가 당겨질 수
          // 있어 발화 시점 store.get이라야 정합하다(count-for RAW는 상수라 아무 때나 같다). fullname [$n]과 짝.
          const loopIndices: Partial<{ [key in TIndexSymbol]: { kind: number; ref: number } }> = {};
          for (let i = 0; i * 2 < loopIndexStack.length; i++) {
            loopIndices[`$${i}` as TIndexSymbol] = {
              kind: loopIndexStack[2 * i],
              ref: loopIndexStack[2 * i + 1],
            };
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
            handlers: this.handlers,
            fullName,
            payload,
            contextLeaves,
            props,
            loopIndices,
            store: this.store,
            module: this.module,
            arrayPool: this.arrayPool,
            freeArrays: this.freeArrays,
            regionPool: this.regionPool,
            freeRegions: this.freeRegions,
            branchPool: this.branchPool,
            freeBranches: this.freeBranches,
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
          nodeTop().appendChild(document.createTextNode(this.module.constpool[u16at()] as string));
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
          if (activeContexts.some((i) => this.createdContexts[i].name === name)) {
            console.warn(`quble: 컨텍스트 '${name}'가 중복 활성화됐습니다(안쪽이 우선).`);
          }
          activeContexts.push(this.createdContexts.length);
          this.createdContexts.push({ name, fields });
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
          // 시작 가지 = 지금 이 가지(startBranchIndex) -> 자식 IF는 이 가지의
          // childRegionIndices에 합류하고 같은 regionPool 배열에 append된다(인덱스 전역 유일).
          // 자식 루트 region 없음 - 자식 직속 노드는 fragment로 모여 RENDER 위치에 붙는다.
          const childDef = this.module.defs[childCompId];
          const childFragment = this.interpret(
            childArgumentSourcePairs,
            childCompId, // 자식 BIND_EVENT/ENTER_CONTEXT는 자식 def의 이벤트/컨텍스트 테이블을 본다
            activeContexts, // 부모 활성 컨텍스트를 공유로 물려준다 - 자식의 ENTER/EXIT_CONTEXT는
            // @with 경계마다 push/pop 짝이라 자식 반환 시 원상복구된다(RENDER는 반환 후
            // activeContexts를 다시 읽지 않아 오염 여지도 없다). 매 RENDER의 [...] 복사 제거.
            childDef.codeOff,
            childDef.codeOff + childDef.codeLen,
            startBranchIndex,
            // biome-ignore lint/style/noNonNullAssertion: RENDER 지점엔 PUSH_PATH_SEGMENT가 깐 segment가 있어 childPrefix는 non-null(바이트코드 순서 보장)
            childPrefix!,
            loopIndexStack, // 자식은 회차 값을 물려받는다(발화 시 $n)
            loopIndexStack.length / 2, // 자식 세그먼트 인덱스의 base = 여기까지 누적된 @for 깊이(스택은 인터리브라 /2)
          );
          // fragment를 통째로 붙인다 - appendChild(fragment)는 내용 전체를 한 번에 옮기고
          // fragment를 비운다(노드별 재입양 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는
          // 라이브라 순회 중 인덱스가 밀려 건너뛴다.
          nodeTop().appendChild(childFragment);
          break;
        }
        case OP.IF: {
          pc = this.runIf(
            pc,
            argumentSourcePairs,
            compId,
            activeContexts,
            pathPrefix,
            loopIndexStack,
            loopIndexBase,
            branch,
            nodeTop(),
          );
          break;
        }
        case OP.FOR_RAW: {
          // 소스에 박힌 리터럴 횟수 - 안 변하니 지금 가지(startRegion/Branch)에 count회 인라인.
          const count = Number(u16at()) || 0;
          const bodyStart = pc;
          const forEndPc = forBodyEnd(this.code, bodyStart);
          inlineFor(count, bodyStart, forEndPc);
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
          const forEndPc = forBodyEnd(this.code, bodyStart);
          if (slotKind(argumentSourcePairs, scopeIndex) === CONST) {
            inlineFor(Number(this.module.constpool[ref]) || 0, bodyStart, forEndPc);
          } else {
            reactiveCountFor(ref + offset, bodyStart, forEndPc);
          }
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        case OP.FOR_ARRAY_VAR: {
          // 배열 count slot. 배열 칸에 든 arrayInfoIndex로 요소 수·요소 위치를 얻어, 회차마다
          // 회차변수(item) slot을 그 요소 leaf로 바인딩하며 반복한다. item slot은 codegen과 같은
          // 규칙(props 슬롯 수 + 현재 @for 깊이)으로 계산한다. base+offset이 배열 칸의 leaf.
          const scopeIndex = u8at();
          const offset = u8at();
          const arrayLeafIndex = slotRef(argumentSourcePairs, scopeIndex) + offset;
          const bodyStart = pc;
          const forEndPc = forBodyEnd(this.code, bodyStart);
          reactiveArrayFor(arrayLeafIndex, bodyStart, forEndPc);
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
    activeContexts: number[],
    pathPrefix: string,
    loopIndexStack: number[],
    loopIndexBase: number,
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
    const regionIndex = appendIfRegion(
      this.regionPool,
      this.freeRegions,
      this.branchPool,
      this.freeBranches,
      condLeafIndex,
    );
    const region = this.regionPool[regionIndex];
    branch.childRegionIndices.push(regionIndex); // 부모(이 interpret의) 가지에 자식 등록
    const thenBranchIndex = region.branchIndices[THEN_INDEX];
    const elseBranchIndex = region.branchIndices[ELSE_INDEX];
    const thenBranch = this.branchPool[thenBranchIndex];
    const elseBranch = this.branchPool[elseBranchIndex];
    // anchor(if 자리 고정용 주석)는 appendIfRegion이 만들었다. 여기서 DOM 트리에 붙인다.
    parent.appendChild(region.anchor);

    // then/else 코드 경계. thenStart = IF operand 직후(현재 pc).
    const thenStart = pc;
    const { thenEnd, elseStart, ifEndPc } = ifBranchRanges(this.code, thenStart);

    // 각 가지를 build하는 클로저. 활성 가지는 지금 호출하고, 비활성 가지는 심어만 둔다.
    const buildThen = () => {
      const f = this.interpret(
        argumentSourcePairs,
        compId,
        activeContexts, // 가지는 같은 컨텍스트 범위 - 그대로 물려받는다
        thenStart,
        thenEnd,
        thenBranchIndex,
        pathPrefix, // 가지 안의 합성도 부모 경로를 물려받는다
        loopIndexStack, // @if는 @for 깊이를 안 늘린다 - 그대로 물려받는다(클로저 캡처라 lazyBuild 지연 실행에도 정합)
        loopIndexBase,
      );
      thenBranch.nodes = Array.from(f.childNodes);
    };
    const buildElse = () => {
      const f =
        elseStart === -1
          ? document.createDocumentFragment() // else 없는 if - 빈 가지
          : this.interpret(
              argumentSourcePairs,
              compId,
              activeContexts, // 가지는 같은 컨텍스트 범위 - 그대로 물려받는다
              elseStart,
              ifEndPc,
              elseBranchIndex,
              pathPrefix, // 가지 안의 합성도 부모 경로를 물려받는다
              loopIndexStack, // @if는 @for 깊이를 안 늘린다 - 그대로 물려받는다(클로저 캡처라 lazyBuild 지연 실행에도 정합)
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
    const initialBranch = this.branchPool[region.branchIndices[initialShownIndex]];
    // biome-ignore lint/style/noNonNullAssertion: 방금 buildThen/buildElse로 lazyBuild를 심었으니 null 아님
    initialBranch.lazyBuild!();
    initialBranch.built = true;
    region.shownIndex = initialShownIndex;

    return ifEndPc + 1; // IF_END 마커 소비 - if 블록 다음 pc
  };
}

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

    // build: 트리(regionPool/branch.nodes/shownIndex)만 만든다. 루트 직속 노드는 fragment에 모여
    // 루트 가지에 담긴다(자식 region 노드는 아직 안 붙음 - 부모 nodes 오염 방지). 그 뒤
    // attachIf가 루트부터 재귀로 노드를 anchor 뒤에 끼우고 구독을 건다.
    // rootFlat은 plantRoot가 준 [STORE, base, …] - 루트 슬롯은 정의상 전부 외부 데이터 바인딩이라 STORE.
    const interpreter = new Interpreter(
      module,
      handlers,
      resources,
      loadedHrefs,
      store,
      arrayPool,
      freeArrays,
      regionPool,
      freeRegions,
      branchPool,
      freeBranches,
      createdContexts,
    );
    const fragment = interpreter.interpret(
      rootFlat,
      compId, // 루트 def
      [], // 루트는 활성 컨텍스트 없음
      def.codeOff,
      def.codeOff + def.codeLen,
      rootRegion.branchIndices[THEN_INDEX], // branch index
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
