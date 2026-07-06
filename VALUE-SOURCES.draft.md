# 값 출처 분리 (draft)

> 상태: `array-type` 브랜치 진행 중 논의. **확정 아님.** 머지 전 REACTIVITY.md /
> BYTECODE.md / DESIGN.md에 반영하고 이 draft는 정리한다. `@for` 구현의 선행 작업.

## 문제 - store 단일 축이 깨졌다

값이 세 종류인데 지금은 다 store로 우회한다:

1. **반응값** - 구독·갱신 대상. store가 원래 맞다.
2. **상수(`$lit`)** - 불변, 컴파일타임에 값 확정. 지금은 store에 **seed로 심어**
   leafIndex로 읽는다(소비를 한 길로 하려는 우회). 대가는 인스턴스마다 중복(IDEAS.md).
3. **런타임 생성값(`n` = `@for` 인덱스)** - 반복이 회차마다 만든다. 비반응, 반복 블록 로컬.

초기엔 1·2만 있었고, 상수를 store에 seed하니 소비가 분기 없이 한 길이라 "다 store"가
성립했다. 그러나 3이 등장하며 깨진다 - `n`을 store에 넣으면 회차마다 write =
**동적 leaf + 반응성 오염**(no-compiletime-leafindex). 2처럼 미리 심어둘 수도 없다
(값이 런타임에야 생김). 즉 **3의 등장이 "다 store" 전략의 한계를 드러냈다.**

이건 초기 설계에서 3(런타임값)을 안 보고 축을 2범주로 정한 결정이 `@for` 구현
시점에 만기된 것. `@for`는 committed라 이제 축을 셋으로 나누는 건 투기가 아니다.

## 도달한 방향

**값 출처를 세 범주로 분리한다** - 저장소도 셋:

| 범주 | 저장소 | 구독 |
| --- | --- | --- |
| 반응값 | store | O |
| 상수 | 컴포넌트 상수풀(pool) 직접 | X |
| 런타임값 | 해석기 스택 | X |

소비 지점은 **어느 출처인지 보고 해당 데서 읽는다.** store로 강제 수렴하지 않는다.

### 해석방법은 scope 슬롯에 실린다 (필연)

핵심 제약: **자식은 자기 prop이 리터럴로 왔는지 변수로 왔는지 모른다**
(`Comp(theme="light")` vs `Comp(theme={x})` - use-site마다 다름). 그래서 해석방법을
컴파일타임에 슬롯 위치로 고정할 수 없다. **값이 scope로 들어갈 때 해석방법도 함께**
실려야 한다 - 부모가 push할 때 결정(리터럴→const, 변수→store; 부모는 앎), 자식 소비는
슬롯의 해석방법대로 읽는다(자식은 몰라도 됨).

즉 scope 슬롯 = **(해석방법, 참조)** 쌍. store/const 2진으로 시작, 런타임값에서 스택
3진으로 확장.

### 슬롯 표현 - 인터리브 평탄 배열 (확정)

슬롯 컬렉션(`paths`)을 **인터리브 단일 배열** `[kind0, ref0, kind1, ref1, …]`로 담는다.
슬롯 offset은 `paths[2*offset]`(해석방법) / `paths[2*offset+1]`(참조)로 읽는다.
`kind ∈ {STORE, CONST, STACK}`.

대안(튜플 배열 `[[k,ref]]`, 객체 배열 `[{kind,ref}]`, 병렬배열 SoA, Map)과 비교 측정
결과: **속도는 표현 간 사실상 무승부**(실제 소비 비용은 store 접근이 지배, 슬롯 읽기
차이는 먼지). **메모리가 유일한 유의미 축** - 슬롯은 인스턴스 수명 내내 상주(업데이트
때 `bindVar`가 다시 참조)하므로 렌더마다 지고 가는 비용이다. flat이 전 구간(슬롯
2~100개) 최경량 - object의 약 1/3, tuple의 약 1/2. SoA는 큰 컴포넌트만 유리하고 작은
컴포넌트에서 두 배열 헤더 고정비로 최악이 되어 탈락. (측정 스크립트는 남기지 않음.)

### 두 축은 각자 남는다 - CONST_BIT는 leaf 축의 표지로 존속

값 출처를 판별하는 축이 **둘**이고, 서로 섞지 않는다:

- **슬롯 축**(`paths`의 kind) - use-site에서 부모가 전달하는 값. Scope leaf가 이 슬롯을
  읽는다. 부모가 리터럴로 준 prop은 슬롯이 CONST kind를 이므로 소비가 pool 직접.
- **leaf 축**(`FIELD_CONST_BIT`, MSB) - 컴포넌트 **자기** payload/context에 직접 박은
  리터럴(`@emit CLICK { label: "clicks" }`). 부모를 안 거치므로 슬롯이 아니라 leaf가
  pool 인덱스를 직접 든다.

애초 예상("MSB가 슬롯 kind에 흡수돼 사라진다")은 **틀렸다**. 흡수된 건 슬롯 경유
const(Scope가 가리킨 CONST 슬롯)뿐이고, payload 직접 리터럴은 슬롯 축에 없다. Const는
슬롯을 **읽을 이유가 없으니**(값이 leaf에 이미 있음) 슬롯에 넣을 이유도 없다 - 억지로
슬롯화하면 "컴포넌트가 자기 리터럴을 자기 슬롯에 까는" self-seed 진입 로직만 새로 생겨
과하다. 그러므로 **leaf 축(MSB)은 본질적으로 남는다**.

풀린 것은 MSB가 아니라 **모순**이다. 전에는 MSB로 const를 갈라놓고 `leafToIndex`가 도로
`store.leafOf`로 합쳤다(다 store 수렴). 지금은 `leavesToSources`가 leaf를 flat
`(kind, ref)`로 정규화해 CONST는 pool 직접·STORE는 store로 **갈래를 끝까지 유지**한다.
MSB(`isConst`)는 `readFields`에서 태어나 `leavesToSources`에서 소비·소멸하고, `assemble`은
정규화된 `(kind, ref)`만 본다.

### leaf 인코딩 - 비대칭 kind(다음 작업, FieldValue)

런타임값(STACK, `@for` 인덱스)이 leaf 축으로도 실리면 leaf가 Scope/Const/Stack 3진을
구분해야 해 MSB 1비트로 부족하다. u16 한 칸을 **비대칭**으로 나눈다 - 상한 리스크가 큰
Const(상수풀은 문자열 전반을 공유해 큰 컴포넌트에서 예상보다 빨리 찬다)에 15비트를 온전히
주고, 여유 있는 Scope/Stack에서 1비트 깎는다:

    0 xxxxxxxxxxxxxxx   Const  (index 15비트, 0x7fff)
    1 0 xxxxxxxxxxxxxx  Scope  (index 14비트, 0x3fff)
    1 1 xxxxxxxxxxxxxx  Stack  (index 14비트, 0x3fff)

leaf 크기(u16) 유지 + 리스크 큰 Const 상한 유지. `Leaf`를 `FieldValue::Scope/Const/Stack`로
개명·재정의하는 작업에서 함께. (상한 가드는 ISSUES.md - 발급 지점에서 축별 상한 검사.)

### 부수 이득 - 구독은 store 값만

해석방법이 실리면 소비 지점이 "이건 store가 아니다"를 알 수 있어 **구독을 스킵**한다.
상수·런타임값은 안 변하니 구독은 죽은 구독이었다. 별도 최적화가 아니라 해석방법 분리의
자연 귀결 - 소비 경로에서 "const/스택이면 구독 안 검" 한 줄로 떨어진다.

## 작업 순서

1. **`$lit` 제거** (완료) - 상수를 store seed에서 빼내 pool 직접 참조. 슬롯 store/const
   2진. seed 중복 해소.
2. **`@for` 런타임값** - 스택 해석방법을 3진으로. `n`은 스택에만.

## 1단계 착지 결과 (완료, runtime.js)

`bindVar`가 무조건 `store.leafOf`로 수렴하던 소비의 심장을 flat 슬롯 분기로 바꿨다.
codegen·bytecode는 무변경(부모 push의 store/const 구분은 이미 `PUSH_ARG`/`PUSH_ARG_LIT`
opcode로 방출됨) - 런타임만 바뀌었다.

- `STORE`/`CONST` 상수 도입. `paths`가 인터리브 평탄 배열 `[kind, ref, …]`.
- `bindVar`/`IF`: `paths[2*offset]` 보고 STORE(leafOf/get + 구독) / CONST(pool 직접, 구독
  스킵)로 분기. IF 조건도 CONST(부모가 리터럴로 준 prop)를 만나면 구독 없이 가지 고정.
- `PUSH_ARG`: 부모 슬롯의 (kind, ref)를 그대로 전파(CONST 슬롯이 여러 단계 아래로 흐름).
- `PUSH_ARG_LIT`: `seedLitPath` 제거 → `(CONST, pool_idx)` 슬롯. store seed 없음.
- payload/context 조립 flat-aware: `leavesToSources`(leaf → flat `(kind, ref)`), `assemble`이
  kind 보고 store/pool 분기. props(set/get 노출)는 STORE 스칼라만.
- 루트 진입: 외부 계약(path 문자열 배열)은 유지, 경계에서 `[STORE, path, …]`로 감쌈.
- `store.seed` 제거(죽은 코드).

## 닫힌 결정

- 슬롯 표현: 인터리브 평탄 배열(위 "슬롯 표현" 절). 속도 무승부 → 메모리 기준 → flat.
- 슬롯 배열 이름: `paths` → `argumentSourcePairs`로 개명 완료(더는 path만 담지 않음 -
  STORE=leafIndex, CONST=pool index). 임시 인자 버퍼(PUSH_ARG가 밀고 RENDER가 비움)와
  구분되는 상주 슬롯 배열.
- 작은 컴포넌트 flat 이득: 측정이 극단 부하(총 50만 슬롯) 기준이라 상대 비율만 신뢰하되,
  전 구간(2~100 슬롯) flat이 최경량이라 실물 재측정 없이 flat으로 확정.
- leaf 축(`FIELD_CONST_BIT`)은 남는다. slot 경유 const는 슬롯 kind가 흡수했지만 payload
  직접 리터럴은 leaf가 pool을 직접 든다(위 "두 축은 각자 남는다"). 다음 작업(FieldValue)은
  MSB 제거가 아니라 비대칭 kind 인코딩으로의 확장.
