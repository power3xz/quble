// Quble 클라이언트 인터프리터 - def의 바이트코드를 훑어 DOM/구독을 만든다. 진입점(compile, instantiate)은 runtime.ts.
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

import { appendArrayInfo, freeArrayInfo, type TArrayInfo } from "./array-info.ts";
import {
  FV_CONST,
  FV_EXPR,
  FV_RAW,
  type TEventEntry,
  type TField,
  type TFieldEntry,
  type TModule,
  type TRef,
  type TStep,
  type TType,
} from "./decode.ts";
import { ATTRS, DOM_EVENTS, setAttributeSafely } from "./dom-tables.ts";
import { ExprEvaluator, SKIP_NOTHING } from "./expr-eval.ts";
import { ExprInstancePool } from "./expr-layer.ts";
import { createLeafStoreSubject, type LeafStoreSubject as TLeafStoreSubject } from "./leaf-store.ts";
import {
  forBodyEnd,
  ifBranchRanges,
  OP_ATTR_G_EXPR,
  OP_ATTR_G_VAR,
  OP_ATTR_L_VAR,
  OP_TEXT_EXPR,
  OP_TEXT_VAR,
  slotPlaceholderContentEnd,
} from "./opcodes.ts";
import { Pool } from "./pool-allocator.ts";
import {
  activateIf,
  addExprInstanceToBranch,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  attachGrownIterations,
  ELSE_INDEX,
  removeBranchAt,
  type TBranch,
  THEN_INDEX,
  type TRegion,
  truncateFor,
} from "./region.ts";
import { CONST, RAW, STORE, slotKind, slotRef, type TScope } from "./scope.ts";
import { type TUpdateMode, updateRoot } from "./update.ts";

// 바이트코드를 훑어(walk) 내려가며 누적되는 가변 스택 묶음 - interpret 재진입마다 함께 흐른다.
// @for 회차/RENDER 재진입은 같은 walkStacks를 이어 쓰고(push/pop 공유), 지연 실행(@if lazyBuild/@for grow)만
// build 시점 상태를 snapshotStacks로 딥카피해 캡처한다 - 지연 시점엔 원본 스택이 이미 pop돼 있어,
// 카피 없이는 회차 인덱스($n)/컨텍스트를 잃는다.
// (pathPrefix/loopIndexBase/argumentSourcePairs는 불변 값이라 여기 안 담고 파라미터로 흐른다 -
//  클로저가 값을 캡처.)
//   loopIndexStack: @for 회차 인덱스 소스 누적(인터리브 kind,ref). buildIteration이 push/pop.
//   activeContexts: 지금 열린 @with 컨텍스트. ENTER/EXIT_CONTEXT가 push/pop.
export type TWalkStacks = {
  loopIndexStack: number[];
  activeContexts: TActiveContext[];
};

// 열린 @with 컨텍스트 하나. 필드는 컴포넌트 props에서만 오므로 어느 def의 몇 번째 컨텍스트인지와 그 컴포넌트의
// 스코프만 들고, 필드(leaf)는 contextFieldsOf로 푼다. fields는 처음 바인딩할 때 채워 같은 @with 아래의
// 바인딩이 함께 쓴다.
export type TActiveContext = {
  name: string;
  compId: number;
  contextIndex: number;
  scope: TScope;
  fields: TAssembled[] | null;
};

// 템플릿 복제 계획 - 한 범위(startPc~endPc)의 정적 뼈대와 값 자리 목록(templatePlanOf).
//   template  요소/정적 속성/정적 텍스트만 든 뼈대. 값 자리 텍스트는 빈 텍스트 노드로 자리만 잡는다.
//   holes     [명령 위치, steps 시작, steps 끝]을 이어 담은 목록. 복제본 위의 커서가 앞 값 자리 노드에서
//             이 값 자리 노드까지 가는 걸음이 steps[시작, 끝)이다. 첫 값 자리는 복제본 root에서 시작한다.
//             노드가 없는 명령(PUSH_PATH_INDEX_SEGMENT)과 앞 값 자리와 같은 노드는 걸음이 비어 있다.
//   steps     값 자리마다 이어 붙인 걸음(STEP_FIRST_CHILD, STEP_NEXT_SIBLING, STEP_PARENT).
//
// li(class="row") { span() { ${row.label} } button(@click:PICK) { "pick" } } 이면
//   template  <li class="row"><span>""</span><button>"pick"</button></li>
//   노드 번호  0=li 1=span 2=span 안 텍스트 3=button 4="pick"
//   걸음      root에서 텍스트까지 [FIRST_CHILD, FIRST_CHILD, FIRST_CHILD], 텍스트에서 button까지 [PARENT, NEXT_SIBLING]
//   holes     [TEXT_VAR 위치, 0, 3, BIND_EVENT 위치, 3, 5]
export type TTemplatePlan = { template: DocumentFragment; holes: number[]; steps: number[] };

// 사용쪽이 RENDER 앞에 깔아둔 슬롯 콘텐츠 한 덩이. 코드 구간은 부모 def 안에 있고 해석
// 컨텍스트도 부모 것을 그대로 들고 간다 - 실행은 자식의 FILL_SLOT_PLACEHOLDER 자리에서 하지만
// 보간/이벤트 경로는 콘텐츠를 쓴 곳(부모) 기준이다(SYNTAX #3.3).
// walkStacks는 카피 - 이 구조체가 담는 건 "이 자리에서 본 부모 컨텍스트"라 값이어야 한다. 가변
// 배열을 참조로 들면 부모가 이후 push/pop한 상태가 비쳐 들어와, 담은 것이 그 시점의 컨텍스트가
// 아니게 된다. 지금은 실행이 pop 전(즉시)이거나 이미 카피본 위(@if lazyBuild)라 참조로도 값이
// 같지만, 그건 호출 경로가 우연히 그런 것이고 이 값의 계약이 아니다. argumentSourcePairs는
// 불변(TScope)이라 참조로 든다.
export type TSlotPlaceholderContent = {
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
export const snapshotStacks = (walkStacks: TWalkStacks): TWalkStacks => ({
  loopIndexStack: [...walkStacks.loopIndexStack],
  activeContexts: [...walkStacks.activeContexts],
});

// field ref 하나를 assemble이 커서로 소비할 [kind, ref, ...] 열로 푼다(바인딩 때 1회). 한 field는
// 단일 출처다 - 리터럴이면 CONST 쌍 하나, 변수면 그 슬롯의 kind. 객체 변수는 store에 연속으로
// 깔려(base부터 재귀적으로 이어짐) base+offset부터 leaf 개수만큼 STORE 쌍으로 펼친다. leaf
// 개수 = steps의 STEP_LEAF 수. assemble이 이 열을 steps 따라 소비해 (중첩) 객체를 조립한다.
//
// @param ref       field.ref
// @param leafCount  field.typeRef의 leaf 칸 수(객체를 몇 칸 펼칠지)
// @param argumentSourcePairs flat 슬롯 배열
// @returns          [kind, ref, ...] 열
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
export const storeSourcePairs = (base: number, leafCount: number): number[] => {
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

export const assemble = (
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
export const compiledStepsOf = (module: TModule, typeRef: number) => {
  if (module.compiledSteps[typeRef] === undefined) {
    module.compiledSteps[typeRef] = compileType(module.types, typeRef, module.constpool);
  }
  return module.compiledSteps[typeRef];
};

// type_ref가 store에서 차지하는 leaf 칸 수(스칼라 1, 객체 필드 합). Rust store_size의 JS판.
// 재귀가 leafCountOf를 다시 부르므로 만난 하위 type_ref도 같이 캐시된다(dedup 이점을 count까지).
export const leafCountOf = (module: TModule, typeRef: number): number => {
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
export const plantRoot = (module: TModule, rootValue: unknown, arrayPool: Pool<TArrayInfo>) => {
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

// 발생 시점에 조립할 준비물(payload/컨텍스트 공용) - field.refs를 바인딩 때 flat sourcePairs로 미리 푼 것.
// 식 필드는 식 바이트와 바인딩 때의 슬롯을 들고 발생 시점에 평가한다.
type TAssembled =
  | { name: string; typeRef: number; fieldSourcePairs: number[] }
  | { name: string; typeRef: number; expr: Uint8Array; pairs: TScope };
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

// 해석기가 만든 직속 노드 묶음. 표현은 해석기가 정한다 - runtime 해석기는 부모에 한 번에 붙일 수 있는
// DocumentFragment를, resume 해석기는 SSR이 그린 제자리 노드를 옮기지 않으려고 노드 배열을 낸다.
export type TBuiltNodes = ChildNode[] | DocumentFragment;

// 받는 쪽이 노드 묶음을 배열로 읽는다.
export const nodesOf = (built: TBuiltNodes): ChildNode[] =>
  Array.isArray(built) ? built : Array.from(built.childNodes);

// 바이트코드를 읽어 노드를 내는 해석기. VM이 지금의 해석기를 interpreter 필드로 들고, lazy build와
// @for grow가 그 시점의 해석기로 노드를 만든다. 상태는 VM이 들고 해석기는 첫 인자로 받는다.
export type TInterpreter = {
  interpret(
    vm: VM,
    argumentSourcePairs: TScope,
    compId: number,
    startPc: number,
    endPc: number,
    startBranchIndex: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    slotPlaceholderContents?: (TSlotPlaceholderContent | undefined)[],
  ): TBuiltNodes;
};

// 해체된 인스턴스의 destroy가 되는 함수. 아무것도 잡지 않는다.
const noop = (): void => { };

// 인스턴스의 snapshot - typeRef 타입의 값을 store의 base + offset 자리에서 읽어 data와 같은 모양으로 다시 짓는다.
// 인자를 모두 생략하면 루트 props 전체(propsTypeRef, 0, 0)다. 루트 props의 필드는 앞 필드의 칸 수만큼 이어서
// 놓이므로 루트를 base 0의 한 객체로 읽을 수 있다. VM이 아니라 인자만 잡으므로, 인스턴스를 쥔 호출자가
// VM까지 붙들지 않는다.
type TSnapshot = {
  (): Record<string, unknown>;
  (typeRef: number, base: number, offset: number): unknown;
};
const snapshotOf = (module: TModule, store: TLeafStoreSubject, arrayPool: Pool<TArrayInfo>): TSnapshot =>
  ((typeRef: number = module.defs[0].propsTypeRef, base: number = 0, offset: number = 0): unknown =>
    assemble(
      compiledStepsOf(module, typeRef),
      storeSourcePairs(base + offset, leafCountOf(module, typeRef)),
      store,
      module,
      arrayPool,
    )) as TSnapshot;

// ── 한 인스턴스의 VM ─────────────────────────────────────────────────
// 한 Blueprint 호출(인스턴스화)마다 하나. 인스턴스 불변 상태(store/각종 pool/module 등)와
// 바인딩(값, 식, 이벤트)을 들고, 바이트코드를 읽어 노드를 만드는 일은 interpreter 필드의 해석기에
// 맡긴다. 호출마다 다른 값(code/pc/가지 등)은 파라미터로 남기고, 인스턴스 내내 같은 값만 필드로 올린다.
export class VM {
  module: TModule;
  code: Uint8Array;
  handlers: THandlers;
  resources: string[];
  loadedHrefs: Set<unknown>;
  store: TLeafStoreSubject;
  arrayPool: Pool<TArrayInfo>;
  evaluator: ExprEvaluator;
  exprInstancePool: ExprInstancePool;
  regionPool: Pool<TRegion>;
  branchPool: Pool<TBranch>;
  // 진입점 argumentSourcePairs(plantRoot의 rootFlat). store(루트부터의 절대 경로) 접근에 쓴다 -
  // 어느 핸들러든 같은 루트라 인스턴스 전역. props(발화 comp 상대)와 달리 store는 defs[0] 기준.
  rootScope: TScope;
  // 지금 바이트코드를 읽는 해석기. 해석기는 VM을 가리키지 않는다(VM -> 해석기, 한 방향).
  interpreter: TInterpreter;

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
    leaves: unknown[],
    arrayPool: Pool<TArrayInfo>,
    rootScope: TScope,
    interpreter: TInterpreter,
  ) {
    this.module = module;
    this.code = module.code;
    this.handlers = handlers;
    this.resources = resources;
    this.loadedHrefs = loadedHrefs;
    this.store = createLeafStoreSubject(leaves);
    this.arrayPool = arrayPool;
    this.evaluator = new ExprEvaluator(module.constpool, this.store, arrayPool);
    this.exprInstancePool = new ExprInstancePool(this.evaluator, this.store);
    this.regionPool = new Pool();
    this.branchPool = new Pool();
    this.rootScope = rootScope;
    this.interpreter = interpreter;
  }

  // 지금의 해석기에 맡긴다. lazy build와 @for grow 클로저가 이것을 불러, 만들어진 시점이 아니라
  // 실행되는 시점의 해석기로 노드를 만든다.
  interpret = (
    argumentSourcePairs: TScope,
    compId: number,
    startPc: number,
    endPc: number,
    startBranchIndex: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    slotPlaceholderContents?: (TSlotPlaceholderContent | undefined)[],
  ): TBuiltNodes => {
    return this.interpreter.interpret(
      this,
      argumentSourcePairs,
      compId,
      startPc,
      endPc,
      startBranchIndex,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      slotPlaceholderContents,
    );
  };

  // 루트도 region(균일성): swap 없는 단일 가지지만, anchor/branch.nodes를 자식과 똑같이 갖춰 attach가
  // 분기 없이 처리한다. 루트 then은 곧바로 build되므로 built로 둔다. anchor를 주지 않으면 새로 만든다.
  openRootRegion = (anchor?: Comment): TRegion => {
    const rootRegion = this.regionPool.entries[appendIfRegion(this.regionPool, this.branchPool, -1, anchor)];
    this.branchPool.entries[rootRegion.branchIndices[THEN_INDEX]].built = true;
    rootRegion.shownIndex = THEN_INDEX;
    return rootRegion;
  };

  // 루트 def 전체를 루트 region의 then 가지로 해석한다. 루트는 경로 prefix가 비고 @for/@with 밖이다.
  interpretRoot = (compId: number, rootRegion: TRegion): TBuiltNodes => {
    const def = this.module.defs[compId];
    return this.interpret(
      this.rootScope,
      compId,
      def.codeOff,
      def.codeOff + def.codeLen,
      rootRegion.branchIndices[THEN_INDEX],
      "",
      0,
      { loopIndexStack: [], activeContexts: [] },
    );
  };

  // 첫 그리기를 마친 인스턴스를 호출자에게 내준다. store를 실어 호출측이 set(leafIndex, v)로 반응성을 건다.
  //
  // destroy는 인스턴스를 해체한다 - 붙은 DOM/구독을 region 트리 재귀로 떼고(detach - 반응 갱신으로 나중에
  // 붙은 노드까지 region이 안다), 루트 anchor와 document 위임 리스너를 제거해 인스턴스가 GC되게 한다.
  //
  // snapshot은 타입과 위치를 받아 store의 그 자리 값을 mount 때 넘긴 rootValue와 같은 모양으로 다시 짓는다
  // (핸들러 payload와 같은 조립). 인자를 생략하면 루트 props 전체다(snapshotOf).
  //
  // update는 루트 props를 이름으로 갱신한다(updateRoot). destroy가 이 클로저도 놓는다 - VM을 잡고 있다.
  instanceOf = (rootRegion: TRegion, nodes: ChildNode[]) => {
    const { module, store, exprInstancePool, regionPool, branchPool, arrayPool } = this;
    // 해체한 뒤에는 루트 region을 놓는다 - destroy 클로저가 붙들고 있으면 루트 anchor가 남는다. 이미 해체했으면
    // 풀이 비어 있어 detach가 예외를 throw하므로 두 번째 호출은 건너뛴다.
    let root: TRegion | null = rootRegion;
    const destroy = () => {
      if (root === null) {
        return;
      }
      root.detach(store, exprInstancePool, regionPool, branchPool, root);
      root.anchor.remove();
      root = null;
      this.removeDelegates();
      // 떼어진 노드, region/branch/배열 정보, store의 값, VM의 캐시를 인스턴스가 붙들지 않게 한다.
      nodes.length = 0;
      store.clear();
      exprInstancePool.clear();
      regionPool.clear();
      branchPool.clear();
      arrayPool.clear();
      this.forEndCache.clear();
      this.ifRangesCache.clear();
      this.slotContentEndCache.clear();
      this.templatePlanCache.clear();
      this.storeTree = null;
      // 이 클로저는 VM을 잡고 있다. 호출자가 인스턴스를 들고 있어도 VM이 거둬지도록 VM을 안 잡는 함수로 바꾼다.
      inst.destroy = noop;
      inst.update = noop;
    };
    const inst = {
      nodes,
      regionPool,
      branchPool,
      arrayPool,
      exprInstances: exprInstancePool.pool,
      store,
      destroy,
      snapshot: snapshotOf(module, store, arrayPool),
      update: (values: Record<string, unknown>, mode: TUpdateMode = "merge"): void => updateRoot(this, values, mode),
    };
    return inst;
  };

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
  ): TBuiltNodes => {
    // 회차 인덱스를 공유 스택에 push -> 재귀 -> pop한다 - 매 회차 [...stack, i] 복사 대신 배열 하나를 재사용한다
    // (10만 회차 x 깊이만큼의 할당 제거). 재귀는 동기라 push된 상태에서 완료되고, 발화 인덱스는 BIND_EVENT가
    // 바인딩 시점에 loopIndices로 스냅샷하므로(공유 배열을 잡지 않음) 재사용이 안전하다.
    // 인터리브 (kind, ref) - argumentSourcePairs와 동형. count-for는 (RAW, i), array-for는 (STORE, 인덱스 leaf).
    walkStacks.loopIndexStack.push(indexKind, indexRef);
    const built = this.interpreter.interpret(
      this,
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
    return built;
  };

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

  // 컴포넌트 compId의 contextIndex번째 컨텍스트 필드를 scope(그 컴포넌트가 받은 값의 주소)로 풀어 leaf를 정한다.
  // 스칼라 field는 leaf 하나, 객체는 leaf 여럿이고 조립 방법(steps)은 조회 때 lazy로 만든다.
  contextFieldsOf = (compId: number, contextIndex: number, scope: TScope): TAssembled[] =>
    this.componentContexts(compId)[contextIndex].fields.map((field) => this.toAssembled(compId, field, scope));

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

  // 배열이 @for에 처음 쓰일 때 길이 칸(sizeLeafIndex)과 인덱스 leaf(indexLeafIndices)를 확보하고 길이 칸을
  // 돌려준다. 이후 push/removeAt이 둘을 동기로 유지한다. 이미 확보했으면 아무것도 하지 않는다.
  ensureIterationLeaves = (info: TArrayInfo): number => {
    if (info.sizeLeafIndex === null) {
      info.sizeLeafIndex = this.store.alloc([info.elemStartLeafIndices.length]);
    }
    if (info.indexLeafIndices.length === 0) {
      for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
        info.indexLeafIndices[i] = this.store.alloc([i]);
      }
    }
    return info.sizeLeafIndex;
  };

  // @for region의 회차를 next개로 맞춘다 - 늘면 늘어난 꼬리 회차 i마다 buildIteration(i)로 만들고 한 번에 붙이고,
  // 줄면 꼬리를 떼어낸다. buildIteration은 회차 branch를 region에 더하고 노드를 담는 일까지 한다.
  resizeFor = (forRegionIndex: number, next: number, buildIteration: (i: number) => void): void => {
    const cur = this.regionPool.entries[forRegionIndex].branchIndices.length;
    for (let i = cur; i < next; i++) {
      buildIteration(i);
    }
    if (next > cur) {
      attachGrownIterations(this.store, this.exprInstancePool, this.regionPool, this.branchPool, forRegionIndex, cur);
    }
    if (next < cur) {
      truncateFor(this.store, this.exprInstancePool, this.regionPool, this.branchPool, forRegionIndex, next);
    }
  };

  // 부모 가지 밑에 @for region을 열고 그 regionIndex를 돌려준다. 부모 가지에 자식으로 등록해 부모가 detach될 때
  // 따라 떼어지게 한다. anchor는 resume이 SSR DOM의 앵커를 넘길 때만 받는다. 앵커를 DOM 어디에 붙일지는 호출자 몫.
  openForRegion = (branchIndex: number, countLeafIndex: number, anchor?: Comment): number => {
    const forRegionIndex = appendForRegion(this.regionPool, countLeafIndex, anchor);
    this.branchAt(branchIndex).childRegionIndices.push(forRegionIndex);
    return forRegionIndex;
  };

  regionAt = (regionIndex: number): TRegion => this.regionPool.entries[regionIndex];

  branchAt = (branchIndex: number): TBranch => this.branchPool.entries[branchIndex];

  // @for region에 빈 회차 가지를 더하고 그 branchIndex를 돌려준다. 노드와 구독은 호출자가 build해 담는다.
  appendIteration = (forRegionIndex: number): number =>
    appendBranchOfForRegion(this.regionPool, this.branchPool, forRegionIndex);

  // 부모 가지 밑에 @if region을 열고 지금 보이는 가지까지 만든다. IF/IF_EXPR 두 해석기가 같은 순서를 밟는 부분이다 -
  // region 등록, 조건 구독, 보이는 가지 build, 안 보이는 가지에 lazyBuild 설치(켜질 때 이것으로 만든다).
  // 가지는 부른 시점의 해석기로 만든다 - resume 중에는 SSR 노드를 연결하고 runtime은 새로 만든다.
  // anchor를 DOM 어디에 붙일지는 호출자 몫이다. 다음 pc(IF_END 다음)를 돌려준다.
  openIfRegion = (
    pc: number,
    condLeafIndex: number,
    condInitial: unknown,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branchIndex: number,
    anchor: Comment,
  ): number => {
    const regionIndex = appendIfRegion(this.regionPool, this.branchPool, condLeafIndex, anchor);
    this.branchAt(branchIndex).childRegionIndices.push(regionIndex);
    const region = this.regionPool.entries[regionIndex];
    const thenBranchIndex = region.branchIndices[THEN_INDEX];
    const elseBranchIndex = region.branchIndices[ELSE_INDEX];
    const thenBranch = this.branchPool.entries[thenBranchIndex];
    const elseBranch = this.branchPool.entries[elseBranchIndex];

    const { ifBodyEnd, elseBodyStart, ifEndPc } = this.cachedIfRanges(pc);

    // 안 보이는 가지는 나중(조건 swap)에 만든다. 그 시점의 공유 walkStacks는 이 @if를 지나 이미 pop된 상태라,
    // build 시점 상태를 딥카피해 캡처한다 - 카피 없이는 회차 인덱스($n)/컨텍스트를 잃는다. then/else 중 하나만
    // 실행되니 스냅샷 하나를 공유한다.
    const stacks = snapshotStacks(walkStacks);

    const buildThen = () => {
      thenBranch.nodes = nodesOf(
        this.interpret(argumentSourcePairs, compId, pc, ifBodyEnd, thenBranchIndex, pathPrefix, loopIndexBase, stacks),
      );
    };
    const buildElse = () => {
      elseBranch.nodes =
        elseBodyStart === -1
          ? [] // else 없는 if - 빈 가지
          : nodesOf(
            this.interpret(
              argumentSourcePairs,
              compId,
              elseBodyStart,
              ifEndPc,
              elseBranchIndex,
              pathPrefix,
              loopIndexBase,
              stacks,
            ),
          );
    };

    this.subscribeIfCond(branchIndex, condLeafIndex, regionIndex);

    // build는 "생성만" 한다 - 보이는 가지의 노드를 만들어 branch.nodes에 담고 shownIndex만 정한다. DOM 부착과
    // 구독 등록은 attachIf가 일괄한다. anchor는 평평한 형제라, 여기서 자식 노드를 붙이면 부모 nodes에 섞여 detach가
    // 깨진다.
    const shownIndex = condInitial ? THEN_INDEX : ELSE_INDEX;
    if (shownIndex === THEN_INDEX) {
      buildThen();
      thenBranch.built = true;
      elseBranch.lazyBuild = buildElse;
    } else {
      buildElse();
      elseBranch.built = true;
      thenBranch.lazyBuild = buildThen;
    }
    region.shownIndex = shownIndex;

    return ifEndPc + 1; // IF_END 마커 소비 - if 블록 다음 pc
  };

  // @if 조건 칸 구독을 부모 가지에 실어, 조건이 바뀌면 then/else 가지를 켠다. 조건 칸이 없으면(-1, CONST 조건)
  // 안 변하니 구독을 걸지 않는다(초기 가지로 고정).
  subscribeIfCond = (branchIndex: number, condLeafIndex: number, regionIndex: number): void => {
    if (condLeafIndex === -1) {
      return;
    }
    this.subscribeOnBranch(branchIndex, condLeafIndex, (condValue) => {
      activateIf(
        this.store,
        this.exprInstancePool,
        this.regionPool,
        this.branchPool,
        regionIndex,
        condValue ? THEN_INDEX : ELSE_INDEX,
      );
    });
  };

  // leafIndex 구독을 가지에 실어 가지와 생애를 함께 한다 - 가지가 detach/free되면 감시도 꺼진다.
  subscribeOnBranch = (branchIndex: number, leafIndex: number, onChange: (v: unknown) => void): void => {
    const branch = this.branchAt(branchIndex);
    branch.leafIndices.push(leafIndex);
    branch.updateFns.push(onChange);
    this.store.subscribe(leafIndex, onChange);
  };

  // 바인딩 때 필드 하나를 발생 시점에 조립할 준비물로 푼다(payload/컨텍스트 공용).
  toAssembled = (compId: number, field: TFieldEntry, argumentSourcePairs: TScope): TAssembled => {
    const name = this.module.constpool[field.nameConstIndex] as string;
    if (field.ref.kind === FV_EXPR) {
      const expr = this.module.defs[compId].exprBytecodes[field.ref.ref];
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
    const result = this.evaluator.runExpr(p.expr, p.pairs, null, null, SKIP_NOTHING, null);
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
        update: (values: Record<string, unknown>, mode: TUpdateMode = "merge"): void => updateRoot(this, values, mode),
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
      removeBranchAt(this.store, this.exprInstancePool, this.regionPool, this.branchPool, forRegionIndex, i);
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
          truncateFor(this.store, this.exprInstancePool, this.regionPool, this.branchPool, forRegionIndex, kept);
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
    branchIndex: number,
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
    this.bindLeaf(leafIndex, update, branchIndex);
    return initial;
  };

  // leaf를 가지에 실어 통지 구독한다. 구독은 가지가 붙을 때 걸리고 떼질 때 풀린다(restoreBranchSubs,
  // teardownBranchSubs). bindVar의 변수 leaf와 bindExpr의 결과 leaf가 함께 쓴다.
  bindLeaf = (leafIndex: number, update: (v: unknown) => void, branchIndex: number): void => {
    const branch = this.branchAt(branchIndex);
    branch.leafIndices.push(leafIndex);
    branch.updateFns.push(update);
  };

  // 식 인스턴스를 짓고 처음 세어 가지에 싣는다. 처음 센 값과 인스턴스 번호를 돌려준다. 구독은 가지가 붙을 때 건다
  // (restoreBranchSubs) - 안 보이는 가지는 구독 0이다.
  addExprInstance = (
    expr: Uint8Array,
    pairs: TScope,
    branchIndex: number,
  ): { exprInstanceIndex: number; value: unknown } => {
    const exprInstanceIndex = this.exprInstancePool.create(expr, pairs);
    const value = this.exprInstancePool.evaluate(exprInstanceIndex);
    addExprInstanceToBranch(this.branchAt(branchIndex), exprInstanceIndex);
    return { exprInstanceIndex, value };
  };

  // 식 인스턴스의 결과를 담을 leaf를 잡아 첫 값을 넣고, 인스턴스가 돌려준 값이 그 leaf에 쓰이도록 연결한다. 결과
  // leaf는 인스턴스를 든 가지가 없어질 때 반납된다(freeBranchTree). 보간 식과 IF_EXPR 조건이 함께 쓴다.
  allocResultLeaf = (exprInstanceIndex: number, value: unknown): number => {
    const resultLeafIndex = this.store.alloc([value]);
    this.exprInstancePool.bindResultLeaf(exprInstanceIndex, resultLeafIndex);
    return resultLeafIndex;
  };

  // bindVar의 식 버전 - 연산자가 붙은 값(TEXT_EXPR/ATTR_*_EXPR)을 세어 현재 값을 주고, 식이
  // 읽는 칸이 바뀌면 다시 센 값을 update에 넘긴다.
  //
  // 식의 결과를 담을 leaf를 잡아 그 leaf를 통지 구독한다 - 식이 바뀌면 파생 구독이 그 leaf에 쓰고, 값이
  // 달라졌을 때만 통지 구독인 update가 DOM을 쓴다. 결과 leaf는 식 인스턴스를 든 가지가 없어질 때
  // 반납된다(freeBranchTree).
  bindExpr = (expr: Uint8Array, update: (v: unknown) => void, argumentSourcePairs: TScope, branchIndex: number) => {
    const { exprInstanceIndex, value } = this.addExprInstance(expr, argumentSourcePairs, branchIndex);
    this.bindLeaf(this.allocResultLeaf(exprInstanceIndex, value), update, branchIndex);
    return value;
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
    branchIndex: number,
  ): void => {
    const code = this.code;
    const u16 = (at: number) => code[at] | (code[at + 1] << 8);
    // 구독 함수가 직전에 쓴 값. 가지를 다시 켤 때 따라잡기가 칸마다 구독 함수를 부르므로, 꺼진 동안 바뀌지
    // 않은 값은 쓰지 않는다. case 블록 안에 두면 클로저가 쓰는 블록 Context가 바인딩마다 따로 할당된다.
    let lastValue: unknown;
    switch (op) {
      case OP_TEXT_VAR: {
        // operand: scope_index, offset
        lastValue = this.bindVar(
          code[pc],
          code[pc + 1],
          (v) => {
            if (v !== lastValue) {
              lastValue = v;
              node.textContent = v as string;
            }
          },
          argumentSourcePairs,
          branchIndex,
        );
        node.textContent = lastValue as string;
        return;
      }
      case OP_TEXT_EXPR: {
        // operand: expr_index
        lastValue = this.bindExpr(
          this.module.defs[compId].exprBytecodes[code[pc]],
          (v) => {
            if (v !== lastValue) {
              lastValue = v;
              node.textContent = v as string;
            }
          },
          argumentSourcePairs,
          branchIndex,
        );
        node.textContent = lastValue as string;
        return;
      }
    }
    // ATTR_*: operand 앞 두 바이트가 속성 이름. G는 전역 속성 표(ATTRS), L은 상수풀.
    const el = node as HTMLElement;
    const nameIndex = u16(pc);
    const name =
      op === OP_ATTR_G_VAR || op === OP_ATTR_G_EXPR ? ATTRS[nameIndex] : (this.module.constpool[nameIndex] as string);
    const update = (v: unknown) => {
      if (v !== lastValue) {
        lastValue = v;
        setAttributeSafely(el, name, v);
      }
    };
    lastValue =
      op === OP_ATTR_G_VAR || op === OP_ATTR_L_VAR
        ? // 이어서 scope_index, offset
        this.bindVar(code[pc + 2], code[pc + 3], update, argumentSourcePairs, branchIndex)
        : // 이어서 expr_index
        this.bindExpr(this.module.defs[compId].exprBytecodes[code[pc + 2]], update, argumentSourcePairs, branchIndex);
    setAttributeSafely(el, name, lastValue);
  };

  // 리소스 로드 - resId의 URL로 <link>를 document.head에 삽입. 이미 삽입한 href는
  // 스킵(한 compile의 여러 컴포넌트/인스턴스가 같은 리소스를 써도 한 번만). 삽입한 href를
  // loadedHrefs(compile 단위)로 기억해 매번 head를 querySelector로 훑지 않는다
  // (인스턴스가 많으면 그 비용이 지배적). dedup 범위가 compile이라 새 렌더 세션은 깨끗하다.
  loadResource = (resId: number) => {
    const url = this.resources[resId];
    if (url && !this.loadedHrefs.has(url)) {
      this.loadedHrefs.add(url);
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      document.head.appendChild(link);
    }
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
    for (const active of walkStacks.activeContexts) {
      active.fields ??= this.contextFieldsOf(active.compId, active.contextIndex, active.scope);
      contextLeaves ??= {};
      contextLeaves[active.name] = active.fields;
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
}
