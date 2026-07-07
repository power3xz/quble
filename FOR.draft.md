# @for (draft)

> 상태: `array-type` 브랜치 진행 중 논의. **확정 아님.** 머지 전 SYNTAX.md /
> BYTECODE.md / DESIGN.md에 반영하고 이 draft는 정리한다.
> 값 출처 분리(VALUE-SOURCES.draft.md)의 STACK/런타임값 소비처가 여기다.

## 범위 (이번)

`@for (item of nums)` - nums 회 반복 렌더. `nums`는:

- **리터럴 정수** (`@for (x of 3)`)
- **store 숫자값** (`@for (x of count)`, count는 prop 참조)

둘 다 **초기값 고정, 구독 X** (반응 안 함 - 값이 변해도 반복 개수 안 바뀜).
동적 인스턴스 추가/제거, 배열 요소 순회(`item` 요소값), key는 범위 밖.
`item` 식별자는 파싱만, 몸체 참조는 다음 단계.

## 문법

    @for (IDENT of EXPR) { body }

- `of` 사용 (기존 SYNTAX.md의 `in` -> `of`로 교체, 의미 차이 없음).
- **별칭 금지** - `@for`는 경로 세그먼트를 만들지 않는다(아래 "이름 없음" 참고).
- 몸체 **자식 여러 개 허용** (단일 자식 제한 안 함).

## fullname / 인덱스

### @for는 이름이 없다 (세그먼트를 안 만든다)

@for에 별칭을 붙이면 이벤트 이름이 필요 이상으로 복잡해진다:

    List() {
      Items: @for (item of items) { VideoItem(...) {} }
    }
    -> List.Items[$0].VideoItem.CLICK    // Items와 VideoItem이 중복(1:1)

`Items`(@for 별칭)와 `VideoItem`(몸체 자식)이 사실상 같은 반복을 두 번 이름
붙인 것. 인덱스 `[$0]`이 어디 붙는지도 모호. 그래서 **@for는 무명**:

    List() {
      @for (item of items) { VideoItem(...) {} }
    }
    -> List.VideoItem[$0].CLICK

@for는 세그먼트를 추가하지 않고 회차 인덱스만 관리한다.

### 인덱스 세그먼트 - 자식 컴포넌트에 접미, 없으면 익명 세그먼트

`[$n]`의 n = 그 세그먼트를 감싼 @for의 **중첩 깊이**(바깥 0, 안쪽 1...).
핸들러가 받는 `{ $0, $1 }`이 곧 바깥/안쪽 루프 인덱스와 1:1.

붙는 자리는 @for 몸체 최상위가 무엇이냐로 갈린다:

- **합성 자식 컴포넌트가 있으면** 그 이름에 접미:

      @for (item of items) { VideoItem(@click:CLICK) {} }
      -> List.VideoItem[$0].CLICK

- **없으면(element 직속)** 익명 세그먼트 `[$n]`:

      @for (item of items) { li(@click:SELECT) { {item} } }
      -> Menu.[$0].SELECT

접미 vs 분리(`[$0].VideoItem`)를 검토해 접미 채택 - fullname은 사람이 읽는
핸들러 키라 인덱스가 대상 뒤(`VideoItem[$0]`)에 와야 읽힌다(분리는 인덱스가 앞에 떠
안 읽힘). 대가로 컴포넌트/element 두 케이스가 생기지만 가독성을 택했다.

@for는 이름(별칭)을 안 만든다 - `Items:` 같은 세그먼트를 두면 `Items.VideoItem`이
"아이템 안에 아이템"으로 읽혀 가짜 계층이 생긴다.

자식 여러 개 허용 - 각자 제 이벤트 이름이라 충돌 없다:

    @for (item of items) {
      VideoItem(@click:CLICK) {}
      DeleteButton(@click:DELETE) {}
    }
    -> List.VideoItem[$0].CLICK
       List.DeleteButton[$0].DELETE

중첩은 각 세그먼트가 자기 @for 깊이의 인덱스를 이음. 깊이는 use-site에서 누적된다 -
@for가 서로 다른 컴포넌트에 있어도 이어받는다(리셋 X, fullname이 use-site 결정이므로):

    @for (row of rows) { Row() { @for (cell of row) { Cell(@click:PICK) {} } } }
    -> List.Row[$0].Cell[$1].PICK

    @for (x of xs) { div() { @for (y of ys) { span(@click:C) {} } } }
    -> Menu.[$0].[$1].C

### 이름은 정적 템플릿 하나 - 인덱스값은 분리 전달

fullname은 `List.VideoItem[$0].CLICK` **템플릿 그대로 하나**다. 회차마다
이름을 굳히지 않는다(100행 = 100개 이벤트 이름 = 핸들러 100개는 말이 안 됨).
핸들러도 하나. "어느 이벤트냐"(정적 이름)와 "몇 번째냐"(런타임 인덱스)를 분리:

- 발화 시점에 실제 인덱스를 `loopIndexStack`으로 따로 전달.
- 핸들러 시그니처 `(data, { $0, $1 })` - context/set과 같은 둘째 인자 객체에
  `$0`(바깥)/`$1`(안쪽) 분구. 기존 `(data, { set, context })` 결.

우리 fullname 철학(정적 예측가능성)과 맞는다.

### 전체 index vs 표시 index - 지금은 구분 안 함

전체 인덱스(데이터 위치)와 표시 인덱스(렌더된 위치)는 필터(`@if` 스킵)/
윈도우(가상 스크롤)/페이지네이션이 있을 때만 갈린다. 현재 @for는 count만큼
빠짐없이 순차라 둘이 항상 같다. `loopIndexStack` 엔트리를 단일 정수로 두되,
그 자리가 미래에 `{data, render}` 쌍이 될 수 있는 좌표임만 인지한다.
지금 미리 나누는 건 speculation.

## 실행 모델

### 반복 호출 (바이트코드 루프백 아님)

몸체를 count회 **반복 interpret**한다. FOR_END가 pc를 되감는 루프백이 아니라
`for (i=0; i<count; i++) interpret(body범위, ...)`. 중첩은 재귀 interpret이
JS 콜스택으로 처리해 별도 루프 프레임 불필요.

### loopIndexStack (activeContexts 동형)

`interpret`에 `loopIndexStack`을 **copy**해서 넘긴다(회차 격리 - 회차 간 오염 방지).

- FOR 진입: 회차 인덱스를 스택에 push (0부터).
- 각 회차: 그 회차 값을 담은 스택 사본으로 몸체 interpret.
- 종료: pop.
- BIND_EVENT: 현재 loopIndexStack을 리스너 클로저에 캡처 -> 발화 시 그 회차
  인덱스로 핸들러 인자(`$0`, `$1`) 구성. 회차마다 새 interpret이라 리스너도
  회차마다 새로 BIND, 각자 제 인덱스 캡처(자연스러움).

### 반응 안 함의 메모리 이점

count 구독을 안 하므로, 반응형 프레임워크가 회차마다 지는 구독/이펙트/fiber
오버헤드가 0이다. 우리 고유 비용은 리스너가 캡처하는 회차 인덱스 배열 N개뿐.
진짜 성능 변수는 메모리가 아니라 "회차마다 재해석"의 CPU 비용 - 노드 재사용
풀(IDEAS.md)은 그 CPU를 캐시 메모리와 맞바꾸는 별개 축. 단순한 재해석으로
먼저 구현하고 실측 후 판단.

## opcode

- `FOR_RAW <count:u16>` - 리터럴 count. operand에 값 직접(pool 안 거침).
- `FOR_SCOPE_INDEX <offset:u16>` - 숫자 prop. operand는 count의 scope index
  (슬롯 offset). 런타임이 그 슬롯 값을 횟수로(STORE면 store 값, CONST면 pool -
  @if 조건과 동형 위임). 종류는 이 둘로 고정(FOR_CONST 불필요).
- `FOR_END` - 몸체 끝 마커(IF_END 동형).

워킹 스택 opcode(PUSH_SCOPE/PUSH_RAW/POP_*)는 도입 검토했으나 폐기 -
FOR가 출처별로 갈리면(FOR_RAW/FOR_SCOPE_INDEX) operand로 값 출처를 직접 들어
스택 경유가 불필요. @if가 조건 슬롯 offset을 operand로 직접 드는 것과 같은 구조.

## 인덱스 세그먼트 - codegen이 굳힌다

세그먼트에 `[$n]`을 접미하는 건 codegen이 한다(런타임 분기 제거). @for 깊이 d를
알고:

- 몸체 자식 컴포넌트: 세그먼트 상수를 `VideoItem[$0]`으로 굳혀 PushPathSegment.
  (@for 밖 같은 컴포넌트는 `VideoItem` - use-site 의존적이나 codegen이 확정.)
- 몸체가 element 직속(세그먼트 만드는 컴포넌트 없음): 익명 세그먼트 `[$0]`을
  PushPathSegment로 낸다.

깊이는 use-site 누적 - 자식 컴포넌트로 내려가도 이어진다(dts와 동일 규칙).

## 닫힌 결정

- **이번 커밋 = 한 덩어리** - count 반복 + loopIndexStack + fullname `[$0]` 접미까지.
  이벤트 네이밍이 인덱스를 요구하므로 쪼개지 않는다.
- **`item` 요소값은 다음 단계** - nums가 숫자면 의미 없다. 배열 순회 착수 때.
  `item` 식별자는 파싱만, 몸체 참조는 미구현.
- **FieldValue::Raw는 자리만 유지** - @for 인덱스는 이름 분리 전달이라 payload/context
  정의(leaf 축)엔 안 들어간다. 그래도 인코딩 자리는 이미 구현돼 있어 유지 -
  향후 쓰일 가능성 대비. 존속/제거 재판단은 실제 미사용이 굳어질 때.
