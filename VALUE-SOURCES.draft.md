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
3진으로 확장. leaf 인코딩의 CONST_BIT(store/const 구분)와 같은 결의 확장.

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

바뀔 방향: `paths[offset]`이 (해석방법, 참조) 슬롯이 되고, 해석방법에 따라
store(leafOf/get + 구독) / const(pool 직접, 구독 스킵) / stack(top, 구독 스킵)으로 분기.
앞단 `paths` 채우는 쪽(PUSH_ARG 계열, seedLitPath ~291)도 해석방법을 싣도록 바뀐다.

## 작업 순서

1. **`$lit` 제거** - 상수를 store seed에서 빼내 pool 직접 참조. 소비 지점(bindVar)이
   const 해석방법을 읽는 경로 신설. store/const 2진. seed 중복 해소.
2. **`@for` 런타임값** - 스택 해석방법을 3진으로 추가. `n`은 스택에만.

상수(값이 컴파일타임에 확정, 가장 단순)로 경로를 먼저 뚫어 런타임값의 디딤돌로 삼는다.

## 미해결

- 해석방법 인코딩 자리 - scope 슬롯 구조를 (해석방법, 참조)로 어떻게. leaf CONST_BIT와
  같은 공간인가 별개인가(bindVar의 offset operand vs leaf 인코딩).
- 3진 확장 시 비트 배치(2비트 vs CONST_BIT + 새 비트).
