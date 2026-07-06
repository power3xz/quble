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

### CONST_BIT(MSB)는 제거된다

leaf 인코딩의 `FIELD_CONST_BIT`(MSB로 store/const 구분)는 **없어진다**. 그 비트가 하던
일 - "소비 지점에서 store냐 const냐 판별" - 을 슬롯의 해석방법(kind)이 흡수하기 때문.
지금은 MSB로 갈라놓고 `leafToIndex`가 도로 `store.leafOf`로 합치는 모순 구조인데,
슬롯이 해석방법을 이고 나르면 leaf가 그 짐을 대신 질 이유가 사라진다. "leaf CONST_BIT와
같은 결의 확장"이 아니라 **CONST_BIT를 슬롯 kind로 흡수(그래서 제거)**.

### 부수 이득 - 구독은 store 값만

해석방법이 실리면 소비 지점이 "이건 store가 아니다"를 알 수 있어 **구독을 스킵**한다.
상수·런타임값은 안 변하니 구독은 죽은 구독이었다. 별도 최적화가 아니라 해석방법 분리의
자연 귀결 - 소비 경로에서 "const/스택이면 구독 안 검" 한 줄로 떨어진다.

## 착지점 (코드)

`proto/web/runtime.js`의 **`bindVar`(~556)** 가 모든 변수 소비의 심장이다
(TEXT_VAR / ATTR_G_VAR / ATTR_L_VAR 전부 통과). 지금:

    const bindVar = (offset, update) => {
      const path = paths[offset];            // offset → path
      const leafIndex = store.leafOf(path);  // 무조건 store로 수렴
      const initial = store.get(leafIndex);
      branch.leafIndices.push(leafIndex);    // 무조건 구독
      branch.updateFns.push(update);
      return initial;
    };

바뀔 방향: `paths`가 인터리브 평탄 배열이 되어 `paths[2*offset]`(해석방법) /
`paths[2*offset+1]`(참조)로 읽고, 해석방법에 따라 store(leafOf/get + 구독) / const(pool
직접, 구독 스킵) / stack(top, 구독 스킵)으로 분기. 앞단 `paths` 채우는 쪽(PUSH_ARG 계열,
seedLitPath ~291)도 해석방법을 싣도록 바뀐다.

## 작업 순서

1. **`$lit` 제거** - 상수를 store seed에서 빼내 pool 직접 참조. 소비 지점(bindVar)이
   const 해석방법을 읽는 경로 신설. store/const 2진. seed 중복 해소.
2. **`@for` 런타임값** - 스택 해석방법을 3진으로 추가. `n`은 스택에만.

상수(값이 컴파일타임에 확정, 가장 단순)로 경로를 먼저 뚫어 런타임값의 디딤돌로 삼는다.

## 미해결

- 슬롯 배열 이름 - 지금 `paths`는 더는 path만 담지 않는다(STORE=path, CONST=pool index,
  STACK=스택 참조). 이름이 내용을 배신하나 당장은 `paths` 유지, 코드 만질 때 적절한
  이름으로 교체(no-resolve-naming 결). 후보 args는 기존 임시 인자 버퍼(PUSH_ARG가 밀고
  RENDER가 비움)와 충돌 - 그건 상주 슬롯 배열과 생명주기가 다르다.
- STACK 참조(`@for` 인덱스)의 실제 형태 - 스택 top을 어떻게 가리키나. `n` 생성 의미가
  아직 미정이라(작업 순서 2) 그때 확정.
- 작은 컴포넌트가 다수인 실사용에서 flat의 상주 이득이 체감되는 절대 규모 - 측정은 극단
  부하(총 50만 슬롯) 기준이라 상대 비율만 신뢰. 실물 렌더로 재확인 여지.

## 닫힌 결정

- 슬롯 표현: 인터리브 평탄 배열(위 "슬롯 표현" 절). 속도 무승부 → 메모리 기준 → flat.
- leaf `FIELD_CONST_BIT`(MSB): 제거. 해석방법을 슬롯 kind가 흡수(위 "CONST_BIT" 절).
