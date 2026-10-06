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

import {
  EXPR_ADD,
  EXPR_AND,
  EXPR_DIV,
  EXPR_ELEM_AT,
  EXPR_EQ,
  EXPR_FIELD_AT,
  EXPR_GE,
  EXPR_GT,
  EXPR_LE,
  EXPR_LOAD_ARRAY_LENGTH,
  EXPR_LOAD_CONST,
  EXPR_LOAD_FALSE,
  EXPR_LOAD_SMALL_INT,
  EXPR_LOAD_STRING_LENGTH,
  EXPR_LOAD_TRUE,
  EXPR_LOAD_VAR,
  EXPR_LT,
  EXPR_MUL,
  EXPR_NE,
  EXPR_NEG,
  EXPR_NOT,
  EXPR_OR,
  EXPR_READ_LEAF,
  EXPR_REM,
  EXPR_SUB,
  instrSize,
} from "./expr-opcode.ts";
import { buildSkipPastOpsOfVars, buildSkipTable, type TExprSkipTable, type TSkipPastOps } from "./expr-skip-table.ts";
import { createLeafStoreSubject, type LeafStoreSubject as TLeafStoreSubject, type TSubscriber } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import {
  activateIf,
  appendArrayInfo,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  attachGrownIterations,
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

const OP_HALT = 0x00;
const OP_ELEM_OPEN = 0x01;
const OP_ATTR_G = 0x02;
const OP_ELEM_CLOSE_OPEN = 0x03;
const OP_TEXT = 0x04;
const OP_ELEM_END = 0x05;
const OP_RENDER = 0x06;
const OP_ATTR_L = 0x07;
const OP_TEXT_VAR = 0x08;
const OP_ATTR_G_VAR = 0x09;
const OP_ATTR_L_VAR = 0x0a;
const OP_PUSH_THROUGH = 0x0b;
const OP_IF = 0x0c;
const OP_ELSE = 0x0d;
const OP_IF_END = 0x0e;
const OP_LOAD_RES = 0x0f;
const OP_BIND_EVENT = 0x10;
const OP_PUSH_ARG_LIT = 0x11;
const OP_PUSH_PATH_SEGMENT = 0x12;
const OP_ENTER_CONTEXT = 0x13;
const OP_EXIT_CONTEXT = 0x14;
const OP_FOR_RAW = 0x15;
const OP_FOR_COUNT_VAR = 0x16;
const OP_FOR_END = 0x17;
const OP_PUSH_PATH_INDEX_SEGMENT = 0x18;
const OP_PUSH_FIELD = 0x19;
const OP_FOR_ARRAY_VAR = 0x1a;
const OP_PUSH_SLOT_PLACEHOLDER_CONTENT = 0x1b;
const OP_SLOT_PLACEHOLDER_CONTENT_END = 0x1c;
const OP_FILL_SLOT_PLACEHOLDER = 0x1d;
const OP_IF_EXPR = 0x1e;
const OP_TEXT_EXPR = 0x1f;
const OP_ATTR_G_EXPR = 0x20;
const OP_ATTR_L_EXPR = 0x21;

// opcode의 operand 바이트 수를 돌려준다.
//
// skipBranch가 op 경계를 짚어 마커(IF/ELSE/IF_END)를 operand 값과 혼동하지 않게 한다.
// (SSR renderer operand_len과 동일.)
//
// @param op opcode 바이트
// @returns  operand 바이트 수(0/2/4)
const operandLen = (op: number) => {
  switch (op) {
    case OP_HALT:
    case OP_ELEM_CLOSE_OPEN:
    case OP_ELEM_END:
    case OP_ELSE:
    case OP_IF_END:
    case OP_EXIT_CONTEXT:
    case OP_FOR_END:
    case OP_SLOT_PLACEHOLDER_CONTENT_END:
      return 0;
    case OP_PUSH_THROUGH: // scope_index: u8
    case OP_IF_EXPR: // expr_index: u8
    case OP_TEXT_EXPR: // expr_index: u8
      return 1;
    case OP_ELEM_OPEN:
    case OP_TEXT:
    case OP_TEXT_VAR: // scope_index: u8, offset: u8
    case OP_RENDER:
    case OP_PUSH_FIELD: // scope_index: u8, offset: u8
    case OP_PUSH_ARG_LIT:
    case OP_PUSH_PATH_SEGMENT:
    case OP_IF: // scope_index: u8, offset: u8
    case OP_LOAD_RES:
    case OP_ENTER_CONTEXT:
    case OP_FOR_RAW:
    case OP_FOR_COUNT_VAR: // scope_index: u8, offset: u8
    case OP_FOR_ARRAY_VAR: // scope_index: u8, offset: u8
    case OP_PUSH_PATH_INDEX_SEGMENT:
    case OP_PUSH_SLOT_PLACEHOLDER_CONTENT:
    case OP_FILL_SLOT_PLACEHOLDER:
      return 2;
    case OP_ATTR_G_EXPR: // name: u16, expr_index: u8
    case OP_ATTR_L_EXPR: // name: u16, expr_index: u8
      return 3;
    case OP_ATTR_G:
    case OP_ATTR_L:
    case OP_ATTR_G_VAR: // name: u16, scope_index: u8, offset: u8
    case OP_ATTR_L_VAR: // name: u16, scope_index: u8, offset: u8
    case OP_BIND_EVENT:
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
    // IF_EXPR도 IF와 같은 분기다 - 깊이를 안 세면 중첩 안쪽의 IF_END를 이 가지 끝으로 오인한다.
    if (op === OP_IF || op === OP_IF_EXPR) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP_IF_END) {
      if (depth === 0) {
        return markerPc;
      }
      depth -= 1;
    } else if (op === OP_ELSE && depth === 0) {
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
    if (op === OP_FOR_RAW || op === OP_FOR_COUNT_VAR || op === OP_FOR_ARRAY_VAR) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP_FOR_END) {
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
    if (op === OP_PUSH_SLOT_PLACEHOLDER_CONTENT) {
      depth += 1;
      pc += operandLen(op);
    } else if (op === OP_SLOT_PLACEHOLDER_CONTENT_END) {
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
  if (code[ifBodyEnd] === OP_ELSE) {
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
//
// 만든 뒤 바꾸지 않는다 - @for 회차는 바깥 스코프 뒤에 회차변수 슬롯을 붙인 새 배열을 받는다.
// 그래서 식/이벤트/지연 build가 나중에 슬롯을 다시 읽어도 복사 없이 참조로 들고 있으면 된다.
type TScope = readonly number[];

const slotKind = (scope: TScope, o: number): number => scope[2 * o];
const slotRef = (scope: TScope, o: number): number => scope[2 * o + 1];

// 바깥 스코프 뒤에 회차변수 슬롯 2칸(item, index)을 붙인 새 스코프. 배열 하나로 concat해야 빈칸
// 없는(PACKED) 배열이 딱 맞는 크기로 나온다 - new Array(n)와 값 여럿 concat은 빈칸 있는(HOLEY) 배열이
// 되고, spread는 저장 공간을 넉넉히 잡아 두 배 넘게 크다.
const scopeWithIteration = (
  scope: TScope,
  itemKind: number,
  itemRef: number,
  indexKind: number,
  indexRef: number,
): TScope => scope.concat([itemKind, itemRef, indexKind, indexRef]);

// i번째를 뺀다. 빈자리에는 마지막 원소를 옮겨 오므로 순서가 바뀐다.
// [a, b, c, d]에서 swapDeleteAt(_, 1)이면 [a, d, c]
//
// 순서를 유지해야 하는 배열에는 쓰지 않는다. 예를 들어 elemStartLeafIndices는 순서가 곧 요소의
// 인덱스라 이것으로 지우면 rows[1]이 다른 요소를 가리킨다. 순서가 무의미하고 찾을 때 indexOf만 쓰는
// 배열에만 쓴다. 같은 자리 번호로 짝지은 배열 여럿(가지의 leafIndices와 updateFns처럼)은 모두 같은 i로
// 지워야 짝이 유지된다.
//
// splice(i, 1)는 뺀 원소를 담은 배열을 매번 새로 만들고 뒤를 당긴다. 이것은 원소 하나만 옮기고
// 아무것도 만들지 않는다.
export const swapDeleteAt = (items: unknown[], i: number): void => {
  items[i] = items[items.length - 1];
  items.pop();
};

// 이항 연산자 하나를 적용한다. 피연산자 타입은 컴파일타임에 맞춰져(compiler/src/expr_type.rs)
// 여기서 검사하지 않는다 - 산술/비교는 number, 논리는 bool, `==`/`!=`는 양쪽이 같은 타입이다.
const applyBinary = (op: number, left: unknown, right: unknown): unknown => {
  switch (op) {
    case EXPR_ADD:
      return (left as number) + (right as number);
    case EXPR_SUB:
      return (left as number) - (right as number);
    case EXPR_MUL:
      return (left as number) * (right as number);
    case EXPR_DIV:
      return (left as number) / (right as number);
    case EXPR_REM:
      return (left as number) % (right as number);
    case EXPR_EQ:
      return left === right;
    case EXPR_NE:
      return left !== right;
    case EXPR_LT:
      return (left as number) < (right as number);
    case EXPR_LE:
      return (left as number) <= (right as number);
    case EXPR_GT:
      return (left as number) > (right as number);
    case EXPR_GE:
      return (left as number) >= (right as number);
    case EXPR_AND:
      return (left as boolean) && (right as boolean);
    case EXPR_OR:
      return (left as boolean) || (right as boolean);
    default:
      throw new Error(`bad expr opcode 0x${op.toString(16)}`);
  }
};

// 식 정의(expr 바이트)당 건너뛰기 표 하나. 같은 식을 쓰는 인스턴스(@for 회차마다 생기는 것)끼리
// 공유한다. expr 바이트는 decode한 모듈이 들고 있어, 모듈이 버려지면 표도 함께 버려진다.
const skipTables = new WeakMap<Uint8Array, TExprSkipTable | null>();

// 식을 처음 셀 때 runExpr에 넘기는 값 - 아무것도 건너뛰지 않는다.
const SKIP_NOTHING: TSkipPastOps = {};

// 식 평가 스택. runExpr마다 새로 만들지 않고 이것을 다시 쓴다. 식 평가는 동기이고 runExpr가 다시 부르지
// 않아 런타임 인스턴스가 여럿이어도 하나를 함께 쓴다.
const exprStack: unknown[] = [];

// 바이트코드를 훑어(walk) 내려가며 누적되는 가변 스택 묶음 - interpret 재진입마다 함께 흐른다.
// @for 회차/RENDER 재진입은 같은 walkStacks를 이어 쓰고(push/pop 공유), 지연 실행(@if lazyBuild/@for grow)만
// build 시점 상태를 snapshotStacks로 딥카피해 캡처한다 - 지연 시점엔 원본 스택이 이미 pop돼 있어,
// 카피 없이는 회차 인덱스($n)/컨텍스트를 잃는다.
// (pathPrefix/loopIndexBase/argumentSourcePairs는 불변 값이라 여기 안 담고 파라미터로 흐른다 -
//  클로저가 값을 캡처.)
//   loopIndexStack: @for 회차 인덱스 소스 누적(인터리브 kind,ref). buildIteration이 push/pop.
//   activeContexts: @with 컨텍스트 누적(createdContexts 인덱스). ENTER/EXIT_CONTEXT가 push/pop.
type TWalkStacks = {
  loopIndexStack: number[];
  activeContexts: number[];
};

// 템플릿 복제 계획 - 한 범위(startPc~endPc)의 정적 뼈대와 값 자리 목록(templatePlanOf).
//   template  요소/정적 속성/정적 텍스트만 든 뼈대. 값 자리 텍스트는 빈 텍스트 노드로 자리만 잡는다.
//   holes     [명령 위치, 노드 번호]를 이어 담은 목록. 노드 번호는 뼈대를 앞순회한 순서다. 노드가
//             없는 명령(PUSH_PATH_INDEX_SEGMENT)은 -1.
//
// li(class="row") { span() { ${row.label} } button(@click:PICK) { "pick" } } 이면
//   template  <li class="row"><span>""</span><button>"pick"</button></li>
//   노드 번호  0=li 1=span 2=span 안 텍스트 3=button 4="pick"
//   holes     [TEXT_VAR 위치, 2, BIND_EVENT 위치, 3]
type TTemplatePlan = { template: DocumentFragment; holes: number[] };

// 사용쪽이 RENDER 앞에 깔아둔 슬롯 콘텐츠 한 덩이. 코드 구간은 부모 def 안에 있고 해석
// 컨텍스트도 부모 것을 그대로 들고 간다 - 실행은 자식의 FILL_SLOT_PLACEHOLDER 자리에서 하지만
// 보간/이벤트 경로는 콘텐츠를 쓴 곳(부모) 기준이다(SYNTAX #3.3).
// walkStacks는 카피 - 이 구조체가 담는 건 "이 자리에서 본 부모 컨텍스트"라 값이어야 한다. 가변
// 배열을 참조로 들면 부모가 이후 push/pop한 상태가 비쳐 들어와, 담은 것이 그 시점의 컨텍스트가
// 아니게 된다. 지금은 실행이 pop 전(즉시)이거나 이미 카피본 위(@if lazyBuild)라 참조로도 값이
// 같지만, 그건 호출 경로가 우연히 그런 것이고 이 값의 계약이 아니다. argumentSourcePairs는
// 불변(TScope)이라 참조로 든다.
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
const FV_EXPR = 3;

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
// 위치(scopeIndex, offset), Const/Raw는 값 하나(u16), Expr는 exprIndex(u8). offset은 Scope만
// 의미 있어 나머진 0.
//
// @param r Reader
// @returns { kind, ref, offset } - ref: Scope=scopeIndex/Const=상수풀 인덱스/Raw=값/Expr=exprIndex
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
  if (tag === FV_EXPR) {
    return { kind: FV_EXPR, ref: reader.u8(), offset: 0 };
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
  // RAW 슬롯(개수 반복의 회차 번호를 받은 prop) - 번호 자체가 값이라 그대로 싣는다.
  if (kind === RAW) {
    return [RAW, slotBase];
  }
  // STORE 슬롯 - base(slotRef+offset)부터 leaf 개수만큼 연속 칸을 STORE 쌍으로 펼친다.
  return storeSourcePairs(slotBase + ref.offset, leafCount);
};

// base부터 leaf 개수만큼 연속 칸을 STORE 쌍으로 편다.
const storeSourcePairs = (base: number, leafCount: number): number[] => {
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
      const value = kind === CONST ? module.constpool[ref] : kind === RAW ? ref : store.get(ref);
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
// 식 필드는 식 바이트와 바인딩 때의 슬롯을 들고 발생 시점에 평가한다.
type TAssembled =
  | { name: string; typeRef: number; fieldSourcePairs: number[] }
  | { name: string; typeRef: number; expr: Uint8Array; pairs: TScope };
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
  // 필드 없는 이벤트, 활성 컨텍스트 없는 바인딩은 null - 행마다 빈 배열/객체를 만들지 않는다.
  payload: TAssembled[] | null;
  contextLeaves: Record<string, TAssembled[]> | null;
  compId: number;
  // props를 펼 scope의 바인딩 시점 복사본(@for가 원본을 회차마다 push/pop한다). props는 첫 발화 때 편다 -
  // 바인딩은 행마다 생기지만 발화는 드물어 미리 펴면 대부분 버려진다.
  scope: TScope;
  props: Record<string, unknown> | null;
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
  // 범위 -> 템플릿 복제 계획(복제할 수 없는 범위면 null). 키는 시작 pc - interpret 범위는 끝이 시작에서
  // 정해진다(@for 본문은 FOR_END, @if 가지는 ELSE/IF_END, 합성은 def 끝).
  templatePlanCache = new Map<number, TTemplatePlan | null>();

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

  // 발화 comp의 props를 이름->leafIndex 중첩 객체로 편다(바인딩의 첫 발화 때 1회). props는 이 comp가
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

  // 바인딩 때 필드 하나를 발생 시점에 조립할 준비물로 푼다(payload/컨텍스트 공용).
  toAssembled = (compId: number, field: TFieldEntry, argumentSourcePairs: TScope): TAssembled => {
    const name = this.module.constpool[field.nameConstIndex] as string;
    if (field.ref.kind === FV_EXPR) {
      const expr = this.module.defs[compId].exprs[field.ref.ref];
      return { name, typeRef: field.typeRef, expr, pairs: argumentSourcePairs };
    }
    const leafCount = leafCountOf(this.module, field.typeRef);
    return {
      name,
      typeRef: field.typeRef,
      fieldSourcePairs: refToSourcePairs(field.ref, leafCount, argumentSourcePairs),
    };
  };

  // 발생 시점에 필드 하나의 값을 낸다. 식 필드는 여기서 평가한다 - 결과가 원시면 그 값,
  // 객체/배열이면 그 시작 leafIndex부터 조립한다.
  assembledValue = (p: TAssembled): unknown => {
    const steps = compiledStepsOf(this.module, p.typeRef);
    if (!("expr" in p)) {
      return assemble(steps, p.fieldSourcePairs, this.store, this.module, this.arrayPool);
    }
    const result = this.runExpr(p.expr, p.pairs, null, null, SKIP_NOTHING, null);
    if (this.module.types[p.typeRef].tag === "scalar") {
      return result;
    }
    const pairs = storeSourcePairs(result as number, leafCountOf(this.module, p.typeRef));
    return assemble(steps, pairs, this.store, this.module, this.arrayPool);
  };

  // 한 바인딩을 발화한다 - data/context 조립 + 핸들러 호출. 인스턴스 상태는 this에서 꺼낸다.
  dispatch = (binding: TBinding, domEventObject: Event) => {
    const data: Record<string, unknown> = {};
    if (binding.payload !== null) {
      for (const p of binding.payload) {
        data[p.name] = this.assembledValue(p);
      }
    }
    const context: Record<string, Record<string, unknown>> = {};
    if (binding.contextLeaves !== null) {
      for (const ctxName of Object.keys(binding.contextLeaves)) {
        const values: Record<string, unknown> = {};
        for (const p of binding.contextLeaves[ctxName]) {
          values[p.name] = this.assembledValue(p);
        }
        context[ctxName] = values;
      }
    }
    // 회차 인덱스를 발화 시점에 읽는다 - STORE면 store.get(ref)(array-for: 중간 제거로 당겨진 현재 인덱스),
    // RAW면 ref 값 자체(count-for: 상수). 이제서야 읽어야 array-for $n이 정합한다(바인딩 시점 값은 낡을 수 있다).
    const currentIndices: Record<string, number> = {};
    for (const key of Object.keys(binding.loopIndices)) {
      const src = binding.loopIndices[key as TIndexSymbol];
      if (src) {
        currentIndices[key] = src.kind === STORE ? (this.store.get(src.ref) as number) : src.ref;
      }
    }
    binding.props ??= this.buildProps(this.module.defs[binding.compId].propsTypeRef, binding.scope);
    // own 키만 본다 - 상속된 키(Object.prototype의 constructor나 오염된 키)를 핸들러로 호출하지 않는다.
    const handler = Object.hasOwn(this.handlers, binding.fullName) ? this.handlers[binding.fullName] : undefined;
    if (handler === undefined) {
      return;
    }
    // 핸들러가 끝날 때까지 구독자 통지를 모은다 - 값은 set이 바로 기록하니 핸들러 안의 get은 새 값을 읽는다.
    // 같은 칸을 여러 번 써도 한 번, 배열 조작이 쓰는 여러 칸도 칸마다 한 번씩만 나간다. 핸들러가 반환하는
    // Promise를 기다린 뒤의 쓰기는 이미 배치 밖이라 지금처럼 바로 통지한다.
    this.store.batch(() => {
      handler(data, {
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
    // 목록에서 뺀 뒤, 뒤로 당겨진 요소들의 인덱스 leaf를 새 자리 번호로 set한다. 이 leaf를 몸체 ${i}가 구독하고
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
    // 인덱스 접근 식(`${rows[cursor].title}`)은 배열 필드 leaf를 구독한다. 요소가 당겨져 같은 인덱스가 다른
    // 요소를 가리키게 됐지만, 그 leaf의 값(arrayInfoIndex)은 그대로라 set으로는 구독 함수가 호출되지 않는다.
    // 호출되면 식이 다시 세어 ELEM_AT이 지금 목록에서 요소를 찾고, READ_LEAF 구독도 그 요소의 leaf에 다시 건다.
    this.store.notify(array[NODE_BASE]);
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
    this.setArrayInto(array[NODE_BASE], elems);
  };

  // setArray의 본체 - 배열 필드 leaf를 받는다. 요소나 객체 안의 배열은 overwriteFixedBlock이 그
  // 필드 leaf로 여기로 재귀한다.
  setArrayInto = (arrayLeafIndex: number, elems: unknown[]): void => {
    const info = this.arrayInfoOf(arrayLeafIndex);
    const shrunk = elems.length < info.elemStartLeafIndices.length;
    const kept = Math.min(info.elemStartLeafIndices.length, elems.length);
    for (let i = 0; i < kept; i++) {
      this.overwriteFixedBlock(info.elemStartLeafIndices[i], info.elemTypeRef, elems[i]);
    }

    // 꼬리 제거 - 회차 DOM(truncateFor)을 먼저 떼고 요소 leaf를 회수해야 한다. 반대로 하면 떼는 도중
    // 회차가 이미 반납된 leaf를 읽는다.
    if (shrunk) {
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
    // 줄었으면 꼬리 자리를 가리키던 인덱스 접근 식이 다시 세어 범위 밖 에러를 내게 한다. 겹치는 자리는
    // 값만 덮어써 가리키는 leaf가 그대로라, 같거나 늘면 호출하지 않는다.
    if (shrunk) {
      this.store.notify(arrayLeafIndex);
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
        this.setArrayInto(cursor, Array.isArray(v) ? v : []);
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
      parent.appendChild(
        this.buildIteration(
          RAW,
          i,
          bodyStart,
          forEndPc,
          startBranchIndex,
          scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i), // item(회차값)/index 모두 [RAW,i](리터럴은 반응성 없어 상수)
          compId,
          pathPrefix,
          loopIndexBase,
          walkStacks,
        ),
      );
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

    // grow(onCount 발화)는 지연 실행이라 그 시점 공유 walkStacks는 이 @for 지점을 지나 이미 pop돼
    // 있다(@if lazyBuild와 동형). build 시점 상태를 딥카피해 addIterationBranch가 캡처한다 - 초기
    // 회차도 같은 스냅샷을 쓴다(build 시점이라 값 동일, push/pop도 스냅샷에만 가 원본 무오염).
    const stacks = snapshotStacks(walkStacks);

    // 회차 branch 하나를 추가하고 build해 담는다(interpret이 fragment로 낸 노드를 detach 때
    // 되찾게 branch.nodes에 보관). 껍데기 push(appendBranchOfForRegion) + build(buildIteration).
    // 새 회차의 전역 branchIndex를 돌려준다.
    // 몸체 `${i}`가 읽을 회차변수(인덱스) 슬롯 [RAW, i]를 바깥 스코프 뒤에 붙인다. 슬롯 번호 =
    // props+바깥 회차변수 뒤.
    const addIterationBranch = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(this.regionPool, this.branchPool, forRegionIndex);
      this.branchPool.entries[newBranchIndex].nodes = Array.from(
        this.buildIteration(
          RAW,
          i,
          bodyStart,
          forEndPc,
          newBranchIndex,
          scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i), // item(회차값)/index 모두 [RAW,i](count-for는 중간 제거 없어 인덱스 상수)
          compId,
          pathPrefix,
          loopIndexBase,
          stacks,
        ).childNodes,
      );
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
        addIterationBranch(i); // 늘어난 꼬리만 build
      }
      if (next > cur) {
        attachGrownIterations(this.store, this.regionPool, this.branchPool, forRegionIndex, cur);
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

    // grow(onSize 발화)는 지연 실행이라 그 시점 공유 walkStacks는 이 @for 지점을 지나 이미 pop돼
    // 있다(@if lazyBuild와 동형). build 시점 상태를 딥카피해 addIterationBranch가 캡처한다 - 초기
    // 회차도 같은 스냅샷을 쓴다(build 시점이라 값 동일, push/pop도 스냅샷에만 가 원본 무오염).
    const stacks = snapshotStacks(walkStacks);

    // array-for는 슬롯 2칸 - [STORE, 요소 base], [STORE, 인덱스 leaf] 순. 요소 슬롯은 몸체가 요소 필드를,
    // 인덱스 슬롯은 몸체 ${i}가 읽는다. 인덱스 leaf는 발화 시 $n으로도 해소되게 loopIndexStack에
    // (STORE, 인덱스 leaf)로 실어 물려준다. 슬롯 번호 = props + 바깥 슬롯 뒤.
    const addIterationBranch = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(this.regionPool, this.branchPool, forRegionIndex);
      const indexLeaf = info.indexLeafIndices[i];
      this.branchPool.entries[newBranchIndex].nodes = Array.from(
        this.buildIteration(
          STORE,
          indexLeaf,
          bodyStart,
          forEndPc,
          newBranchIndex,
          scopeWithIteration(argumentSourcePairs, STORE, info.elemStartLeafIndices[i], STORE, indexLeaf),
          compId,
          pathPrefix,
          loopIndexBase,
          stacks,
        ).childNodes,
      );
      return newBranchIndex;
    };

    for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
      addIterationBranch(i);
    }

    const onSize = () => {
      const next = info.elemStartLeafIndices.length; // store 값이 아니라 요소 목록 길이가 진실
      const cur = region.branchIndices.length;
      for (let i = cur; i < next; i++) {
        addIterationBranch(i); // 늘어난 꼬리만 build
      }
      if (next > cur) {
        attachGrownIterations(this.store, this.regionPool, this.branchPool, forRegionIndex, cur);
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

  // bindVar의 식 버전 - 연산자가 붙은 값(TEXT_EXPR/ATTR_*_EXPR)을 세어 현재 값을 주고, 식이
  // 읽는 칸이 바뀌면 다시 세어 update에 넘긴다.
  //
  // IF_EXPR과 달리 파생 칸을 안 잡는다 - 값을 받아 DOM에 바로 쓰므로 중간에 담을 자리가
  // 필요 없다(IF_EXPR은 분기가 조건 칸 하나를 구독하는 구조라 잡는다).
  bindExpr = (expr: Uint8Array, update: (v: unknown) => void, argumentSourcePairs: TScope, branch: TBranch) => {
    return this.subscribeExpr(expr, argumentSourcePairs, branch, update);
  };

  // 식을 처음 세고, 식이 읽은 칸마다 구독을 건다. 칸이 바뀌면 다시 세어, 값이 지난번과 다를 때만
  // onValue에 넘긴다. 처음 센 값을 돌려준다. 구독은 branch에 실어 가지와 생애를 함께 한다.
  //
  // 구독 함수는 식 인스턴스마다 하나다. `(a + b) * (c - d)`면 a~d 네 칸에 같은 함수를 건다. 칸마다
  // 함수를 만들면 1만 행 목록에서 함수가 수만 개 늘어, 메모리가 CPU 캐시를 넘쳐 다시 세기가 오히려
  // 느려진다.
  //
  // 건너뛸 부분식이 있는 식과 없는 식을 메서드로 나눈다. 한 메서드 안에서 나누면 구독 함수가 잡는
  // 컨텍스트에 다른 쪽 변수의 자리까지 생긴다.
  subscribeExpr = (expr: Uint8Array, pairs: TScope, branch: TBranch, onValue: (v: unknown) => void): unknown => {
    const table = this.skipTable(expr);
    return table === null
      ? this.subscribeWholeExpr(expr, pairs, branch, onValue)
      : this.subscribePartialExpr(expr, pairs, table, branch, onValue);
  };

  // 건너뛸 부분식이 없는 식. cache도 건너뛰기 표도 두지 않고, 칸이 바뀌면 처음부터 센다.
  subscribeWholeExpr = (expr: Uint8Array, pairs: TScope, branch: TBranch, onValue: (v: unknown) => void): unknown => {
    const reads: number[] = [];
    const value = this.runExpr(expr, pairs, null, null, SKIP_NOTHING, reads);
    const readLeaves: number[] = [];
    for (let i = 0; i < reads.length; i += 2) {
      if (!readLeaves.includes(reads[i])) {
        readLeaves.push(reads[i]);
      }
    }
    // `${big > 50}`에서 big이 100 -> 200이면 true 그대로라 DOM에 쓰지 않는다.
    let lastValue = value;
    // 같은 flush에서 바뀐 leaf를 읽는 곳마다 불리지만 처음부터 세므로 한 번이면 된다.
    let handledFlush: ReadonlySet<number> | undefined;
    const reevalOnChange: TSubscriber = (_, __, flushLeaves) => {
      if (flushLeaves !== undefined) {
        if (flushLeaves === handledFlush) {
          return;
        }
        handledFlush = flushLeaves;
      }
      const v = this.runExpr(expr, pairs, null, null, SKIP_NOTHING, null);
      if (v !== lastValue) {
        lastValue = v;
        onValue(v);
      }
    };
    for (const leafIndex of readLeaves) {
      branch.leafIndices.push(leafIndex);
      branch.updateFns.push(reevalOnChange);
    }
    return value;
  };

  // 건너뛸 부분식이 있는 식. 칸이 바뀌면 그 칸과 무관한 부분식은 건너뛰며 센다. 구독 함수는 불릴 때
  // 받은 leafIndex로 그 칸의 건너뛰기 표를 고른다(skipPastOpsOfLeaf).
  //
  // 인스턴스가 드는 것은 cache와 leafOfVar(변수마다 읽는 leafIndex) 둘이다. 건너뛰기 표는 식 정의가
  // 공유하고, 행마다 다른 것은 읽는 leafIndex뿐이다.
  //
  // `${rows[cursor].title}`에서 cursor가 바뀌면 READ_LEAF가 읽는 leafIndex가 바뀐다. 다시 센 뒤 구독을
  // 그 READ_LEAF가 방금 읽은 leafIndex에 다시 건다(resubscribeReadLeaf).
  subscribePartialExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable,
    branch: TBranch,
    onValue: (v: unknown) => void,
  ): unknown => {
    const cache: unknown[] = new Array(table.opCount);
    const { value, leafOfVar } = this.evalExpr(expr, pairs, table, cache);
    // 인덱스 접근이 있으면 배열 변수가 READ_LEAF가 읽을 leafIndex를 정하므로 readLeafIndexOpsByVar 어딘가가
    // 비어 있지 않다.
    const hasIndexAccess = table.readLeafIndexOpsByVar.some((ops) => ops.length > 0);
    let lastValue = value;
    // 같은 flush에서 읽는 leaf 둘 이상이 바뀌면 처음 불릴 때 바뀐 변수 전체로 만든 건너뛰기 표로
    // 한꺼번에 센다. 읽는 leaf마다 따로 세면 먼저 센 쪽이 다른 부분식의 cache에 든 옛 값을 섞어 쓴다.
    // 같은 flush의 나머지 호출은 건너뛴다.
    let handledFlush: ReadonlySet<number> | undefined;
    const reevalOnChange: TSubscriber = (_, leafIndex, flushLeaves) => {
      if (flushLeaves !== undefined && flushLeaves.size > 1) {
        if (flushLeaves === handledFlush) {
          return;
        }
        handledFlush = flushLeaves;
        // 다시 걸기가 leafOfVar를 고치므로 바뀐 leaf를 읽는 변수를 먼저 번호의 비트로 모은다.
        let changedVarMask = 0;
        for (let n = 0; n < leafOfVar.length; n++) {
          if (flushLeaves.has(leafOfVar[n])) {
            changedVarMask |= 1 << n;
          }
        }
        if (changedVarMask === 0) {
          return;
        }
        const v = this.reevalExpr(expr, pairs, table, cache, buildSkipPastOpsOfVars(table, expr, changedVarMask));
        if (hasIndexAccess) {
          for (let varNumber = 0; varNumber < leafOfVar.length; varNumber++) {
            if (changedVarMask & (1 << varNumber)) {
              this.resubscribeReadLeavesDependingOn(expr, table, cache, leafOfVar, branch, reevalOnChange, varNumber);
            }
          }
        }
        if (v !== lastValue) {
          lastValue = v;
          onValue(v);
        }
        return;
      }
      const skipPastOps = this.skipPastOpsOfLeaf(expr, table, leafOfVar, leafIndex);
      // 구독을 다시 걸며 이미 뺀 leafIndex다. 가지를 다시 붙일 때 다시 걸기 전 사본으로 따라잡으면 온다 -
      // 다시 건 그 호출이 이미 다시 셌으므로 할 일이 없다.
      if (skipPastOps === null) {
        return;
      }
      const v = this.reevalExpr(expr, pairs, table, cache, skipPastOps);
      // 다시 걸기가 leafOfVar를 고쳐, 바뀐 leaf를 읽는 변수가 여럿이면 먼저 모아 둔다.
      //   ${nums[nums[0]]}, nums = [0, 7]에서 두 READ_LEAF가 nums[0]을 읽는다.
      //   nums[0]에 1을 쓰면 안쪽 차례에 바깥을 nums[1]로 옮겨, leafOfVar로는 바깥이 안 보인다.
      // 하나면 고쳐지기 전에 읽으므로 모으지 않는다.
      if (hasIndexAccess) {
        const first = leafOfVar.indexOf(leafIndex);
        if (leafOfVar.indexOf(leafIndex, first + 1) < 0) {
          this.resubscribeReadLeavesDependingOn(expr, table, cache, leafOfVar, branch, reevalOnChange, first);
        } else {
          const changedVars: number[] = [];
          for (let n = first; n < leafOfVar.length; n++) {
            if (leafOfVar[n] === leafIndex) {
              changedVars.push(n);
            }
          }
          for (const varNumber of changedVars) {
            this.resubscribeReadLeavesDependingOn(expr, table, cache, leafOfVar, branch, reevalOnChange, varNumber);
          }
        }
      }
      if (v !== lastValue) {
        lastValue = v;
        onValue(v);
      }
    };
    // 같은 leaf를 읽는 변수가 여럿이면 한 번만 건다 - 두 번 걸면 한 번 바뀔 때 식을 두 번 다시 센다.
    for (let n = 0; n < leafOfVar.length; n++) {
      const leafIndex = leafOfVar[n];
      if (leafIndex >= 0 && leafOfVar.indexOf(leafIndex) === n) {
        branch.leafIndices.push(leafIndex);
        branch.updateFns.push(reevalOnChange);
      }
    }
    return value;
  };

  // leafIndex를 읽는 변수들의 건너뛰기 표. 읽는 변수가
  //   없으면   null이다. 구독을 다시 걸며 이미 뺀 leafIndex다.
  //   하나면   식 정의가 공유하는 표(table.skipPastOpsByVar)다.
  //   둘 이상  부모가 같은 칸을 두 prop으로 넘긴 경우다(자식의 `${x + y}`에서 x, y가 같은 칸).
  //            그 칸이 바뀌면 두 변수가 함께 바뀌므로 두 변수를 모두 품지 않은 부분식의 표를 만든다.
  skipPastOpsOfLeaf = (
    expr: Uint8Array,
    table: TExprSkipTable,
    leafOfVar: number[],
    leafIndex: number,
  ): TSkipPastOps | null => {
    const first = leafOfVar.indexOf(leafIndex);
    if (first < 0) {
      return null;
    }
    if (leafOfVar.indexOf(leafIndex, first + 1) < 0) {
      return table.skipPastOpsByVar[first];
    }
    let changedVarMask = 0;
    for (let n = first; n < leafOfVar.length; n++) {
      if (leafOfVar[n] === leafIndex) {
        changedVarMask |= 1 << n;
      }
    }
    return buildSkipPastOpsOfVars(table, expr, changedVarMask);
  };

  // 변수 varNumber가 바뀌어 READ_LEAF가 읽을 leafIndex가 달라졌으면 그 READ_LEAF의 구독을 다시 건다.
  // READ_LEAF에 leafIndex를 넘긴 연산의 cache 값이 방금 읽은 leafIndex다.
  resubscribeReadLeavesDependingOn = (
    expr: Uint8Array,
    table: TExprSkipTable,
    cache: unknown[],
    leafOfVar: number[],
    branch: TBranch,
    subscriber: TSubscriber,
    varNumber: number,
  ): void => {
    for (const op of table.readLeafIndexOpsByVar[varNumber]) {
      const readLeafVar = table.varAt[op + instrSize(expr[op])];
      const newLeafIndex = cache[table.cacheIndex[op]] as number;
      this.resubscribeReadLeaf(leafOfVar, branch, subscriber, readLeafVar, newLeafIndex);
    }
  };

  // READ_LEAF 변수(varNumber) 하나가 읽는 leafIndex를 newLeafIndex로 옮긴다. 옛 leafIndex를 읽는 변수가
  // 더 없으면 구독을 풀어 branch에서 빼고, 새 leafIndex를 읽던 변수가 없었으면 구독해 branch에 더한다.
  // leafIndex가 그대로면 아무것도 하지 않는다.
  //
  // `${rows[cursor].score + rows[0].score}`에서 cursor가 1 -> 0이면 두 변수가 rows[0].score를 읽게 돼
  // 구독은 그대로 하나다.
  resubscribeReadLeaf = (
    leafOfVar: number[],
    branch: TBranch,
    subscriber: TSubscriber,
    varNumber: number,
    newLeafIndex: number,
  ): void => {
    const oldLeafIndex = leafOfVar[varNumber];
    if (oldLeafIndex === newLeafIndex) {
      return;
    }
    const newAlreadyRead = leafOfVar.includes(newLeafIndex);
    leafOfVar[varNumber] = newLeafIndex;
    const oldDropped = oldLeafIndex >= 0 && !leafOfVar.includes(oldLeafIndex);
    if (oldDropped) {
      this.store.unsubscribe(oldLeafIndex, subscriber);
    }
    if (!newAlreadyRead) {
      this.store.subscribe(newLeafIndex, subscriber);
    }

    // 가지 목록. 옛 것을 빼고 새 것을 더할 때는 같은 자리를 덮어쓴다.
    if (oldDropped) {
      for (let i = 0; i < branch.leafIndices.length; i++) {
        if (branch.leafIndices[i] === oldLeafIndex && branch.updateFns[i] === subscriber) {
          if (newAlreadyRead) {
            swapDeleteAt(branch.leafIndices, i);
            swapDeleteAt(branch.updateFns, i);
          } else {
            branch.leafIndices[i] = newLeafIndex;
          }
          return;
        }
      }
    }
    if (!newAlreadyRead) {
      branch.leafIndices.push(newLeafIndex);
      branch.updateFns.push(subscriber);
    }
  };

  // 식 정의당 건너뛰기 표 하나. 같은 expr 바이트면 같은 표를 돌려준다. 건너뛸 부분식이 없는 식은
  // null이고, 그것도 담아 두어 다시 판정하지 않는다.
  skipTable = (expr: Uint8Array): TExprSkipTable | null => {
    let table = skipTables.get(expr);
    if (table === undefined) {
      table = buildSkipTable(expr);
      skipTables.set(expr, table);
    }
    return table;
  };

  // 값 자리 명령 하나(TEXT_VAR, TEXT_EXPR, ATTR_G_VAR, ATTR_L_VAR, ATTR_G_EXPR, ATTR_L_EXPR)를 node에
  // 건다 - 지금 값을 쓰고, 값이 바뀌면 다시 쓰도록 구독한다. operand는 pc(opcode 다음 바이트)부터 읽는다.
  // node는 TEXT_*면 텍스트 노드, ATTR_*면 그 속성을 가진 요소다.
  //
  // interpret와 cloneTemplate가 함께 쓴다. 해석할 때는 노드를 새로 만들어 넘기고, 복제할 때는 복제본의
  // 노드를 넘긴다.
  bindValueSlot = (
    op: number,
    pc: number,
    node: Node,
    compId: number,
    argumentSourcePairs: TScope,
    branch: TBranch,
  ): void => {
    const code = this.code;
    const u16 = (at: number) => code[at] | (code[at + 1] << 8);
    switch (op) {
      case OP_TEXT_VAR: {
        // operand: scope_index, offset
        node.textContent = this.bindVar(
          code[pc],
          code[pc + 1],
          (v) => (node.textContent = v as string),
          argumentSourcePairs,
          branch,
        ) as string;
        return;
      }
      case OP_TEXT_EXPR: {
        // operand: expr_index
        node.textContent = this.bindExpr(
          this.module.defs[compId].exprs[code[pc]],
          (v) => (node.textContent = v as string),
          argumentSourcePairs,
          branch,
        ) as string;
        return;
      }
    }
    // ATTR_*: operand 앞 두 바이트가 속성 이름. G는 전역 속성 표(ATTRS), L은 상수풀.
    const el = node as HTMLElement;
    const nameIndex = u16(pc);
    const name =
      op === OP_ATTR_G_VAR || op === OP_ATTR_G_EXPR ? ATTRS[nameIndex] : (this.module.constpool[nameIndex] as string);
    const update = (v: unknown) => el.setAttribute(name, v as string);
    const v =
      op === OP_ATTR_G_VAR || op === OP_ATTR_L_VAR
        ? // 이어서 scope_index, offset
          this.bindVar(code[pc + 2], code[pc + 3], update, argumentSourcePairs, branch)
        : // 이어서 expr_index
          this.bindExpr(this.module.defs[compId].exprs[code[pc + 2]], update, argumentSourcePairs, branch);
    el.setAttribute(name, v as string);
  };

  // 범위(startPc~endPc)의 템플릿 복제 계획. 범위마다 처음 한 번 만들어 둔다.
  //
  // 범위가 아래 명령만으로 되어 있으면 뼈대를 DOM으로 만들고 값 자리를 적는다. 하나라도 다른 명령
  // (@if, @for, 합성, 슬롯, @with, LOAD_RES)이 섞이면 null - interpret가 지금처럼 해석한다.
  //   뼈대      ELEM_OPEN, ATTR_G, ATTR_L, ELEM_CLOSE_OPEN, ELEM_END, TEXT
  //   값 자리   TEXT_VAR, TEXT_EXPR, ATTR_G_VAR, ATTR_L_VAR, ATTR_G_EXPR, ATTR_L_EXPR, BIND_EVENT
  //   경로 상태  PUSH_PATH_INDEX_SEGMENT(뒤따르는 BIND_EVENT의 [$n])
  //
  // 노드 번호는 노드를 만든 순서다. 요소는 자식보다 먼저, 형제는 앞에서부터 만들므로 이 순서가
  // 곧 뼈대의 앞순회 순서다 - 복제본을 앞순회로 모으면 같은 번호로 같은 노드를 찾는다.
  templatePlanOf = (startPc: number, endPc: number): TTemplatePlan | null => {
    const cached = this.templatePlanCache.get(startPc);
    if (cached !== undefined) {
      return cached;
    }
    const code = this.code;
    const u16 = (at: number) => code[at] | (code[at + 1] << 8);
    const template = document.createDocumentFragment();
    const parents: Node[] = [template];
    const holes: number[] = [];
    let pending: HTMLElement | null = null;
    let nodeCount = 0;
    let plan: TTemplatePlan | null = { template, holes };
    for (let pc = startPc; pc < endPc && plan !== null; ) {
      const at = pc;
      const op = code[pc++];
      switch (op) {
        case OP_ELEM_OPEN:
          pending = document.createElement(TAGS[u16(pc)]);
          nodeCount++;
          break;
        case OP_ATTR_G:
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(ATTRS[u16(pc)], this.module.constpool[u16(pc + 2)] as string);
          break;
        case OP_ATTR_L:
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(this.module.constpool[u16(pc)] as string, this.module.constpool[u16(pc + 2)] as string);
          break;
        case OP_ATTR_G_VAR:
        case OP_ATTR_L_VAR:
        case OP_ATTR_G_EXPR:
        case OP_ATTR_L_EXPR:
        case OP_BIND_EVENT:
          // 여는 중인 요소가 방금 만든 노드다.
          holes.push(at, nodeCount - 1);
          break;
        case OP_ELEM_CLOSE_OPEN:
          // biome-ignore lint/style/noNonNullAssertion: CLOSE_OPEN은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          parents[parents.length - 1].appendChild(pending!);
          // biome-ignore lint/style/noNonNullAssertion: 바로 위와 같은 pending
          parents.push(pending!);
          pending = null;
          break;
        case OP_ELEM_END:
          parents.pop();
          break;
        case OP_TEXT:
          parents[parents.length - 1].appendChild(document.createTextNode(this.module.constpool[u16(pc)] as string));
          nodeCount++;
          break;
        case OP_TEXT_VAR:
        case OP_TEXT_EXPR:
          parents[parents.length - 1].appendChild(document.createTextNode(""));
          holes.push(at, nodeCount);
          nodeCount++;
          break;
        case OP_PUSH_PATH_INDEX_SEGMENT:
          holes.push(at, -1);
          break;
        default:
          plan = null;
      }
      pc += operandLen(op);
    }
    this.templatePlanCache.set(startPc, plan);
    return plan;
  };

  // 계획의 뼈대를 복제하고 값 자리에 바인딩을 건다. interpret가 계획이 있는 범위에서 해석 대신 부른다.
  // 값 자리는 interpret와 같은 bindValueSlot/bindEvent로 건다.
  cloneTemplate = (
    plan: TTemplatePlan,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
  ): DocumentFragment => {
    const fragment = plan.template.cloneNode(true) as DocumentFragment;
    // 복제본의 노드를 앞순회로 모은다 - 계획의 노드 번호와 같은 순서다.
    const nodes: Node[] = [];
    const collect = (parent: Node) => {
      for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
        nodes.push(child);
        collect(child);
      }
    };
    collect(fragment);

    const code = this.code;
    const { holes } = plan;
    // interpret의 segment와 같다 - PUSH_PATH_INDEX_SEGMENT가 깔고 다음 BIND_EVENT가 소비한다.
    let segment: string | null = null;
    for (let h = 0; h < holes.length; h += 2) {
      const at = holes[h];
      const node = nodes[holes[h + 1]];
      const op = code[at];
      const pc = at + 1;
      if (op === OP_PUSH_PATH_INDEX_SEGMENT) {
        segment = `${segment ?? ""}[$${loopIndexBase + (code[pc] | (code[pc + 1] << 8))}]`;
      } else if (op === OP_BIND_EVENT) {
        const domEventIndex = code[pc] | (code[pc + 1] << 8);
        const eventIndex = code[pc + 2] | (code[pc + 3] << 8);
        this.bindEvent(
          node as HTMLElement,
          domEventIndex,
          eventIndex,
          segment,
          compId,
          pathPrefix,
          argumentSourcePairs,
          walkStacks,
        );
        segment = null;
      } else {
        this.bindValueSlot(op, pc, node, compId, argumentSourcePairs, branch);
      }
    }
    return fragment;
  };

  // el에 DOM 이벤트 바인딩을 심고 document 위임을 켠다(BIND_EVENT).
  //
  // interpret 밖에 따로 둔다. 이 본문이 interpret의 switch 안에 있으면 V8이 interpret를 잘 최적화하지
  // 못해, 1만 행 목록의 mount가 눈에 띄게 느려졌다(작은 도우미 u16at/nodeTop이 인라인되지 않았다).
  // 어느 V8 제약에 걸리는지는 확인하지 못했다.
  bindEvent = (
    el: HTMLElement,
    domEventIndex: number,
    eventIndex: number,
    segment: string | null,
    compId: number,
    pathPrefix: string,
    argumentSourcePairs: TScope,
    walkStacks: TWalkStacks,
  ): void => {
    const domEvent = DOM_EVENTS[domEventIndex];
    const event = this.componentEvents(compId)[eventIndex];
    const eventName = this.module.constpool[event.nameConstIndex] as string;
    // fullname = 합성 경로 + (@for 직속 element면 익명 인덱스 세그먼트) + 로컬 이벤트명.
    let eventPrefix = pathPrefix;
    if (segment !== null) {
      eventPrefix = eventPrefix ? `${eventPrefix}.${segment}` : segment;
    }
    const fullName = eventPrefix ? `${eventPrefix}.${eventName}` : eventName;
    // fields의 leaf를 flat 값-소스로 미리 푼다(바인딩 때 1회). steps(조립
    // 구조)는 발생 때 lazy 컴파일. 스칼라 field는 leaf 하나, 객체는 leaf 여럿(깊이우선).
    const payload =
      event.fields.length === 0
        ? null
        : event.fields.map((field) => this.toAssembled(compId, field, argumentSourcePairs));
    // props: 발화 comp가 선언한 props 전체를 이름->leafIndex 중첩 객체로(payload에 실었는지와
    // 무관 - payload는 data 값, props는 상태 주소). propsTypeRef + 이 scope로 dispatch가 편다.
    const scope = argumentSourcePairs;
    // 지금 활성인 컨텍스트들을 context명 -> (필드명 -> leafIndex)로 묶는다(바인딩 시점 고정).
    // 같은 이름은 뒤(안쪽)가 덮는다 - activeContexts 순서대로 돌아 안쪽이 마지막에 쓰인다.
    let contextLeaves: Record<string, TAssembled[]> | null = null;
    for (const i of walkStacks.activeContexts) {
      const created = this.createdContexts[i];
      contextLeaves ??= {};
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
    let bound = this.eventBindings.get(el);
    if (!bound) {
      bound = {};
      this.eventBindings.set(el, bound);
    }
    bound[domEvent] = { fullName, payload, contextLeaves, compId, scope, props: null, loopIndices };
    this.ensureDelegate(domEvent);
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
    // 요소/텍스트/값 자리/이벤트만으로 된 범위(@for 회차 본문 등)는 해석하지 않고 뼈대를 복제한다.
    const plan = this.templatePlanOf(startPc, endPc);
    if (plan !== null) {
      return this.cloneTemplate(
        plan,
        argumentSourcePairs,
        compId,
        pathPrefix,
        loopIndexBase,
        walkStacks,
        this.branchPool.entries[startBranchIndex],
      );
    }
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
        case OP_HALT: {
          pc = endPc;
          break;
        }
        case OP_LOAD_RES: {
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
        case OP_ELEM_OPEN: {
          pending = document.createElement(TAGS[u16at()]);
          break;
        }
        case OP_ATTR_G: {
          const name = ATTRS[u16at()];
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(name, this.module.constpool[u16at()] as string);
          break;
        }
        case OP_ATTR_L: {
          const name = this.module.constpool[u16at()] as string;
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(name, this.module.constpool[u16at()] as string);
          break;
        }
        case OP_ATTR_G_VAR:
        case OP_ATTR_L_VAR:
        case OP_ATTR_G_EXPR:
        case OP_ATTR_L_EXPR: {
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          this.bindValueSlot(op, pc, pending!, compId, argumentSourcePairs, branch);
          pc += operandLen(op);
          break;
        }
        case OP_BIND_EVENT: {
          // 지금 여는 요소(pending)에 리스너를 단다. event_type=DOM 이벤트, event_idx=이 def의 이벤트.
          const domEventIndex = u16at();
          const eventIndex = u16at();
          this.bindEvent(
            // biome-ignore lint/style/noNonNullAssertion: BIND_EVENT는 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            pending!,
            domEventIndex,
            eventIndex,
            segment,
            compId,
            pathPrefix,
            argumentSourcePairs,
            walkStacks,
          );
          // segment는 PUSH_PATH_INDEX_SEGMENT가 이 element에 깐 [$n]이다(RENDER를 안 거치니 여기서
          // 소비). 이벤트 있는 element마다 새로 깔리므로 소비(비움)해도 형제/중첩이 다시 깐다.
          segment = null;
          break;
        }
        case OP_ELEM_CLOSE_OPEN: {
          // biome-ignore lint/style/noNonNullAssertion: CLOSE_OPEN은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          nodeTop().appendChild(pending!);
          // biome-ignore lint/style/noNonNullAssertion: 바로 위와 같은 pending
          nodeStack.push(pending!);
          pending = null;
          break;
        }
        case OP_TEXT: {
          nodeTop().appendChild(document.createTextNode(this.module.constpool[u16at()] as string));
          break;
        }
        case OP_TEXT_VAR:
        case OP_TEXT_EXPR: {
          const node = document.createTextNode("");
          this.bindValueSlot(op, pc, node, compId, argumentSourcePairs, branch);
          pc += operandLen(op);
          nodeTop().appendChild(node);
          break;
        }
        case OP_ELEM_END: {
          nodeStack.pop();
          break;
        }
        case OP_PUSH_THROUGH: {
          // 경로 없는 참조 - 부모 슬롯 (kind, ref)를 편집 없이 그대로 자식에 넘긴다. kind를
          // 보존해 부모가 리터럴로 받은 CONST 슬롯도 그대로 아래로 흐른다.
          const scopeIndex = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex));
          break;
        }
        case OP_PUSH_FIELD: {
          // 필드 참조 - 부모 슬롯 base에 offset을 더해 자식에 넘긴다. kind는 그대로 전파,
          // 위치만 옮긴다. CONST 슬롯은 필드가 없어(리터럴은 객체 아님) FIELD로 오지 않는다.
          const scopeIndex = u8at();
          const offset = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex) + offset);
          break;
        }
        case OP_PUSH_ARG_LIT: {
          // 리터럴 인자(불변): 상수풀 인덱스를 CONST 슬롯으로 자식에 넘긴다. store에 심지
          // 않는다 - 소비 지점(bindVar)이 CONST를 보고 pool을 직접 읽고 구독을 스킵한다.
          args.push(CONST, u16at());
          break;
        }
        case OP_PUSH_PATH_SEGMENT: {
          // 다음 RENDER가 자식 경로 prefix에 이을 세그먼트(자식 type-name). 합성당 하나라
          // 단일 변수로 적재 - args(여럿 누적)와 달리 RENDER가 하나만 소비한다.
          segment = this.module.constpool[u16at()] as string;
          break;
        }
        case OP_PUSH_PATH_INDEX_SEGMENT: {
          // @for 인덱스 세그먼트를 정적 fullname에 접미한다. 직전 이름 세그먼트가 있으면
          // Row[$0], 없으면(element 직속) 익명 [$0]. operand는 컴포넌트-로컬 깊이라 use-site에서
          // 물려받은 깊이(loopIndexStack.length)를 base로 더해 누적 표기($1...)로 만든다 - 자식
          // 컴포넌트 코드는 자기 @for를 0부터 세지만 fullname은 바깥까지 누적돼야 한다.
          const token = `[$${loopIndexBase + u16at()}]`;
          segment = (segment ?? "") + token;
          break;
        }
        case OP_ENTER_CONTEXT: {
          // @with 진입: 컨텍스트 def의 fields를 지금 argumentSourcePairs로 leafIndex로 풀어 createdContexts에
          // 싣고, 그 인덱스를 activeContexts에 push. 발생 시점 BIND_EVENT가 이걸로 context를 짓는다.
          const contextDef = this.componentContexts(compId)[u16at()];
          const name = this.module.constpool[contextDef.nameConstIndex as number] as string;
          // payload와 같은 조립 준비 - leaf만 미리 풀고 steps는 조회 시 lazy. 발생 시 context 조립.
          const fields = contextDef.fields.map((field) => this.toAssembled(compId, field, argumentSourcePairs));
          // 맥락은 같은 이름이 중복으로 쌓이지 않는 게 맞다(ISSUES). 일어나면 알리고, 가장
          // 안쪽이 이기도록 그냥 쌓는다(context 조립이 뒤(=안쪽) 것으로 덮는다).
          if (walkStacks.activeContexts.some((i) => this.createdContexts[i].name === name)) {
            console.warn(`quble: 컨텍스트 '${name}'가 중복 활성화됐습니다(안쪽이 우선).`);
          }
          walkStacks.activeContexts.push(this.createdContexts.length);
          this.createdContexts.push({ name, fields });
          break;
        }
        case OP_EXIT_CONTEXT: {
          // @with 블록 끝. 활성 스택에서만 빼고 createdContexts는 둔다(회수는 @for 때 - ISSUES).
          walkStacks.activeContexts.pop();
          break;
        }
        case OP_PUSH_SLOT_PLACEHOLDER_CONTENT: {
          // 콘텐츠 구간을 재서 담아두기만 한다 - 실행은 자식의 FILL_SLOT_PLACEHOLDER 자리에서.
          // 지금 컨텍스트(부모)를 함께 캡처한다: 콘텐츠는 부모 def 안이라 부모 scope/path로 읽힌다.
          const slotPlaceholderIndex = u16at();
          const contentStart = pc;
          const contentEndPc = this.cachedSlotContentEnd(contentStart);
          pendingSlotPlaceholderContents[slotPlaceholderIndex] = {
            startPc: contentStart,
            endPc: contentEndPc,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks: snapshotStacks(walkStacks),
            branchIndex: startBranchIndex,
          };
          pc = contentEndPc + 1; // SLOT_PLACEHOLDER_CONTENT_END 마커 소비
          break;
        }
        case OP_FILL_SLOT_PLACEHOLDER: {
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
        case OP_RENDER: {
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
        case OP_IF: {
          pc = this.runIf(pc, argumentSourcePairs, compId, pathPrefix, loopIndexBase, walkStacks, branch, nodeTop());
          break;
        }
        case OP_IF_EXPR: {
          pc = this.runIfExpr(
            pc,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
            branch,
            nodeTop(),
          );
          break;
        }
        case OP_FOR_RAW: {
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
        case OP_FOR_COUNT_VAR: {
          // 숫자 count slot(@if 조건과 동형). CONST(부모가 리터럴로 준 prop)와 RAW(바깥 개수 반복의
          // 회차 번호)는 안 변하니 인라인, STORE는 count leaf에 구독을 걸어 값이 바뀌면 꼬리 회차를
          // 늘리고 줄인다. count가 필드(a.count)면 base+offset이 그 leaf.
          const scopeIndex = u8at();
          const offset = u8at();
          const ref = slotRef(argumentSourcePairs, scopeIndex);
          const kind = slotKind(argumentSourcePairs, scopeIndex);
          const bodyStart = pc;
          const forEndPc = this.cachedForEnd(bodyStart);
          if (kind === CONST || kind === RAW) {
            this.inlineFor(
              kind === RAW ? ref : Number(this.module.constpool[ref]) || 0,
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
        case OP_FOR_ARRAY_VAR: {
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

  // 식을 처음부터 센다. 값과 함께, 변수(expr-skip-table.ts)마다 읽은 leafIndex(leafOfVar)를 낸다.
  // 연산 결과는 cache에 써 둔다.
  //
  // 읽은 leafIndex는 구독할 칸이다. 세어 보지 않고는 알 수 없어 값과 함께 나온다 - 인덱스 접근은
  // 어느 요소를 읽는지가 인덱스를 세어 봐야 정해진다. 범위 밖 에러로 식이 중간에 멈추면 못 읽은
  // 변수는 -1이다.
  //
  // ((a + b) * c) - (d + e)에서 a~e가 leafIndex 20~24를 읽는 인스턴스
  //   leafOfVar [20, 21, 22, 23, 24]
  // 부모가 d와 e에 같은 칸 23을 넘긴 인스턴스
  //   leafOfVar [20, 21, 22, 23, 23]
  //
  // leaf 기준(leaf마다 읽는 변수 목록)이 아니라 변수 기준이라, 길이가 식 정의로 정해져 처음부터 맞게
  // 잡는다. 빈 배열에 push로 채우면 V8이 늘어날 몫까지 잡아 1만 행에서 쓰지 않는 용량이 크게 남는다.
  evalExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable,
    cache: unknown[],
  ): { value: unknown; leafOfVar: number[] } => {
    const reads: number[] = [];
    const value = this.runExpr(expr, pairs, table, cache, SKIP_NOTHING, reads);
    const leafOfVar: number[] = new Array(table.positionsByVar.length).fill(-1);
    for (let i = 0; i < reads.length; i += 2) {
      leafOfVar[table.varAt[reads[i + 1]]] = reads[i];
    }
    return { value, leafOfVar };
  };

  // 식을 다시 센다. skipPastOps에 적힌 부분식은 계산하지 않고 cache의 지난번 값을 쓴다.
  reevalExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable,
    cache: unknown[],
    skipPastOps: TSkipPastOps,
  ): unknown => this.runExpr(expr, pairs, table, cache, skipPastOps, null);

  // 식을 후위 표기로 센다(BYTECODE.md #4 <EXPR>). evalExpr와 reevalExpr가 함께 쓰는 본체다.
  //
  // 타입은 컴파일타임에 검사가 끝나(compiler/src/expr_type.rs) 여기서 안 본다.
  //
  //   - 잎 명령 위치 at에 skipPastOps[at]이 있으면, 그 연산까지를 계산하지 않고 cache에 든 그 연산의
  //     지난번 값을 올린 뒤 그 연산 다음 명령으로 간다.
  //   - 연산 결과는 cache[table.cacheIndex[연산 위치]]에 써 둔다. 다음에 건너뛸 때 이 값을 쓴다.
  //     건너뛸 부분식이 없는 식은 표도 cache도 없어(null) 쓰지 않는다.
  //   - reads가 있으면 store 칸을 읽을 때마다 leafIndex와 읽은 명령의 위치를 이어 붙인다. a + b에서
  //     a, b가 칸 20, 21이면 [20, 0, 21, 3]. 다시 셀 때는 구독이 이미 걸려 있어 null을 넘긴다.
  runExpr = (
    expr: Uint8Array,
    pairs: TScope,
    table: TExprSkipTable | null,
    cache: unknown[] | null,
    skipPastOps: TSkipPastOps,
    reads: number[] | null,
  ): unknown => {
    // 스택 높이. 0부터 센다 - 앞선 평가가 ELEM_AT의 RangeError로 중간에 멈췄으면 배열에 그때 값이
    // 남아 있다. 배열 길이를 0으로 비우지 않는 것은 V8이 저장 공간을 놓아 다음에 다시 할당하기 때문이다.
    let sp = 0;
    for (let pc = 0; pc < expr.length; ) {
      const at = pc;
      const skipPastOpsAt = skipPastOps[at];
      if (skipPastOpsAt !== undefined && table !== null && cache !== null) {
        exprStack[sp++] = cache[table.cacheIndex[skipPastOpsAt]];
        pc = skipPastOpsAt + instrSize(expr[skipPastOpsAt]);
        continue;
      }
      const op = expr[pc++];
      // 연산의 결과. 값을 올리기만 하는 명령은 직접 올리고 다음 명령으로 넘어간다.
      let result: unknown;
      switch (op) {
        case EXPR_LOAD_VAR: {
          exprStack[sp++] = this.slotValue(pairs, expr[pc], expr[pc + 1], at, reads);
          pc += 2;
          continue;
        }
        case EXPR_LOAD_ARRAY_LENGTH: {
          // 배열 칸의 값이 arrayInfoIndex - 요소 수는 그 arrayInfo가 든다.
          //
          // 구독은 배열 칸이 아니라 길이 칸(sizeLeafIndex)에 건다 - 배열 칸의 값은 요소가 늘고
          // 줄어도 안 바뀐다. @for가 grow/shrink 발화에 쓰는 그 칸이고, 아직 없으면 여기서
          // 확보한다(주인은 배열이라 식이 없어져도 안 반납).
          const leafIndex = slotRef(pairs, expr[pc]) + expr[pc + 1];
          const info = this.arrayPool.entries[this.store.get(leafIndex) as number];
          if (slotKind(pairs, expr[pc]) !== CONST) {
            info.sizeLeafIndex ??= this.store.alloc([info.elemStartLeafIndices.length]);
            reads?.push(info.sizeLeafIndex, at);
          }
          exprStack[sp++] = info.elemStartLeafIndices.length;
          pc += 2;
          continue;
        }
        case EXPR_LOAD_STRING_LENGTH: {
          // 길이는 값 칸 자체를 구독해 바뀔 때 다시 잰다 - slotValue가 그 칸을 담는다.
          exprStack[sp++] = String(this.slotValue(pairs, expr[pc], expr[pc + 1], at, reads)).length;
          pc += 2;
          continue;
        }
        case EXPR_LOAD_CONST: {
          exprStack[sp++] = this.module.constpool[expr[pc] | (expr[pc + 1] << 8)];
          pc += 2;
          continue;
        }
        case EXPR_LOAD_SMALL_INT:
          exprStack[sp++] = expr[pc++];
          continue;
        case EXPR_LOAD_TRUE:
          exprStack[sp++] = true;
          continue;
        case EXPR_LOAD_FALSE:
          exprStack[sp++] = false;
          continue;
        // 단항 - 하나 꺼내 하나 넣는다.
        case EXPR_NOT:
          result = !exprStack[--sp];
          break;
        case EXPR_NEG:
          result = -(exprStack[--sp] as number);
          break;
        // 인덱스 접근 - 값 대신 leafIndex를 올린다. 요소 위치는 인덱스를 세어 봐야 정해진다.
        // 요소가 없는 인덱스(범위 밖, 음수, 정수 아님)는 에러다 - 범위는 핸들러 로직이 지킨다.
        case EXPR_ELEM_AT: {
          const i = exprStack[--sp] as number;
          const info = this.arrayPool.entries[exprStack[--sp] as number];
          const start = info.elemStartLeafIndices[i];
          if (start === undefined) {
            throw new RangeError(`index ${i} out of range (length ${info.elemStartLeafIndices.length})`);
          }
          result = start;
          break;
        }
        case EXPR_FIELD_AT:
          result = (exprStack[--sp] as number) + expr[pc++];
          break;
        case EXPR_READ_LEAF: {
          const leafIndex = exprStack[--sp] as number;
          reads?.push(leafIndex, at);
          result = this.store.get(leafIndex);
          break;
        }
        // 이항 - 둘 꺼내 하나 넣는다. 나중에 밀린 것이 오른쪽이라 먼저 꺼내진다.
        default: {
          const right = exprStack[--sp];
          const left = exprStack[--sp];
          result = applyBinary(op, left, right);
          break;
        }
      }
      // 연산 결과를 스택에 올리고, cache가 있으면 거기에도 써 둔다.
      exprStack[sp++] = result;
      if (table !== null && cache !== null) {
        cache[table.cacheIndex[at]] = result;
      }
    }
    return exprStack[0];
  };

  // 슬롯 하나가 가리키는 값. CONST면 상수풀, RAW면 ref 자체(개수 반복의 회차 번호), STORE면 store 칸.
  // CONST와 RAW는 바뀌지 않아 구독하지 않는다. STORE 칸을 읽으면 reads에 leafIndex와 읽은 위치(at)를 붙인다.
  slotValue = (pairs: TScope, scopeIndex: number, offset: number, at: number, reads: number[] | null): unknown => {
    const ref = slotRef(pairs, scopeIndex);
    const kind = slotKind(pairs, scopeIndex);
    if (kind === CONST) {
      return this.module.constpool[ref];
    }
    if (kind === RAW) {
      return ref;
    }
    reads?.push(ref + offset, at);
    return this.store.get(ref + offset);
  };

  // @if opcode 처리 - 조건 슬롯을 그대로 조건 칸으로 쓴다.
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
    return this.buildIfRegion(
      pc,
      condLeafIndex,
      condIsConst ? this.module.constpool[condRef] : this.store.get(condLeafIndex),
      false, // 부모 슬롯을 가리킬 뿐 - 이 region이 만든 칸이 아니다
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      parent,
    );
  };

  // IF_EXPR opcode 처리 - 연산자가 붙은 조건(BYTECODE.md #5.2). 식의 결과를 담을 파생 칸을 하나
  // 잡고, 식이 읽는 칸들을 구독해 하나라도 바뀌면 다시 세어 그 칸에 넣는다. 분기는 그 칸 하나만
  // 보므로 그 뒤는 IF와 같다.
  runIfExpr = (
    pc: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    parent: Node,
  ): number => {
    const expr = this.module.defs[compId].exprs[this.code[pc++]];
    // 식이 읽는 칸이 바뀌면 식을 다시 세어 파생 칸(condLeafIndex)에 넣는다. 그 set이 아래
    // buildIfRegion이 건 구독을 깨워 가지를 바꾼다 - 두 단계인 이유는 감시 칸과 조건 칸이 다르기
    // 때문이다. 구독은 부모 가지에 실어 생애를 함께 한다(파생 칸 구독과 같은 관례). 구독 함수는
    // 칸이 바뀔 때 불리므로, 그때는 아래에서 파생 칸을 이미 잡아 두었다.
    const value = this.subscribeExpr(expr, argumentSourcePairs, branch, (v) => this.store.set(condLeafIndex, v));
    const condLeafIndex = this.store.alloc([value]);
    return this.buildIfRegion(
      pc,
      condLeafIndex,
      this.store.get(condLeafIndex),
      true, // 이 region이 잡은 파생 칸 - region이 없어질 때 반납한다
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      parent,
    );
  };

  // IF/IF_EXPR이 공유하는 분기 구성 - then/else Region을 스폰해 anchor를 parent에 붙이고, 활성
  // 가지만 build한다. 비활성 가지엔 lazyBuild만 심어 첫 활성화 때 만든다. 조건 칸이 있으면(STORE)
  // 구독을 걸어 swap한다.
  //
  // 둘의 차이는 조건 칸을 어디서 얻느냐뿐이다 - IF는 부모 슬롯을 그대로 쓰고, IF_EXPR은 식을
  // 세어 넣은 파생 칸을 쓴다. 그래서 그 칸과 초기값만 받는다.
  //
  // @param pc             가지 첫 op(조건 operand 직후)
  // @param condLeafIndex  조건을 담은 칸. CONST 조건이면 -1(구독 없음)
  // @param condInitial    초기 조건값 - CONST 조건은 store에 없어 따로 받는다
  // @param ownsCondLeaf   region이 그 칸의 주인인가(IF_EXPR의 파생 칸). free 때 반납 여부
  // @param branch         구독을 실을 부모 가지 - 부모가 detach/free되면 조건 감시도 꺼진다
  // @param parent         anchor를 붙일 DOM 노드
  // @returns              IF_END 다음 pc
  buildIfRegion = (
    pc: number,
    condLeafIndex: number,
    condInitial: unknown,
    ownsCondLeaf: boolean,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    parent: Node,
  ): number => {
    const regionIndex = appendIfRegion(this.regionPool, this.branchPool, condLeafIndex, ownsCondLeaf);
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
    // walkStacks는 이 @if를 지나 이미 pop된 상태라, build 시점 상태를 딥카피해 캡처한다 - 카피
    // 없이는 회차 인덱스($n)/컨텍스트를 잃는다. then/else 중 하나만 실행되니 스냅샷 하나를 공유
    // 캡처한다(reactive @for grow의 addIterationBranch와 같은 관례).
    const stacks = snapshotStacks(walkStacks);

    // 각 가지를 build하는 클로저. 활성 가지는 지금 호출하고, 비활성 가지는 심어만 둔다.
    const buildThen = () => {
      const f = this.interpret(
        argumentSourcePairs,
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
          : this.interpret(
              argumentSourcePairs,
              compId,
              elseBodyStart,
              ifEndPc,
              elseBranchIndex,
              pathPrefix,
              loopIndexBase,
              stacks,
            );
      elseBranch.nodes = Array.from(f.childNodes);
    };
    thenBranch.lazyBuild = buildThen;
    elseBranch.lazyBuild = buildElse;

    // cond 변경 시 해당 가지를 활성화(swap). 첫 활성화면 activateIf가 lazyBuild 호출.
    // 조건 칸이 없으면(-1, CONST 조건) 안 변하니 구독을 걸지 않는다(초기 가지로 고정).
    if (condLeafIndex !== -1) {
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
      // 루트 props의 지금 값. mount 때 넘긴 rootValue와 같은 모양으로 다시 짓는다(핸들러 payload와 같은 조립).
      // 루트 슬롯 base는 rootFlat의 [STORE, base] 쌍에 루트 props 필드 순서로 놓여 있다.
      const snapshot = (): Record<string, unknown> => {
        const rootType = module.types[module.defs[0].propsTypeRef] as { fields: TField[] };
        const value: Record<string, unknown> = {};
        rootType.fields.forEach(([nameConstIndex, typeRef], i) => {
          const pairs = storeSourcePairs(rootFlat[i * 2 + 1], leafCountOf(module, typeRef));
          value[module.constpool[nameConstIndex] as string] = assemble(
            compiledStepsOf(module, typeRef),
            pairs,
            store,
            module,
            arrayPool,
          );
        });
        return value;
      };
      return { nodes, regionPool, branchPool, arrayPool, store, destroy, snapshot };
    };
};

// 상태 저장소(store)는 leaf-store.ts가 정의한다. blueprint가 받는 store가 이것 - 편의상 여기서 재공개한다.
export { createLeafStoreSubject };
