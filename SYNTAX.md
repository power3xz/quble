# Quble 문법 레퍼런스 (v0)

DESIGN.md에 흩어진 문법을 한곳에 정리한다. 이 문서는 **표층 문법(surface syntax)**만
다룬다. 실행 위치/타입/반응성 같은 의미론은 DESIGN.md와 process.md를 따른다.

> 표기: `EXPR`=표현식 슬롯, `IDENT`=식별자, `...`=반복, `[ ]`=선택적.

---

## 1. 파일 구조

```
use Button from "./Button"          // 다른 컴포넌트 import (여러 개: use A, B from "...")
use "./Card.module.css"             // 에셋 - 이름 없이 경로만

component IDENT {
  props    { ... }   // 선택
  contexts { ... }   // 선택
  events   { ... }   // 선택
  template { ... }   // 필수
}
```

한 파일에 `use ...`들과 컴포넌트 선언(들). 블록 순서는 위 관례를 따른다.

---

## 2. 선언 블록

### 2.1 `props`

```
props {
  title: string,
  completed: bool,
  priority: number,
  tags: string[],
  assignee: { name: string, id: number }
}
```

쉼표로 구분된 `이름: 타입` 목록. 타입은 **필수**(표기 강제). 구분자 쉼표는 필드 사이에
**필수**이나 마지막 필드 뒤는 생략 가능하고 trailing 쉼표도 허용한다(TS 규칙). 객체 타입의
필드도 같다.

타입은 quble이 온전히 소유하는 재귀 문법이다:

```
Type   = Prim | Array | Object | Ref | Util
Prim   = "bool" | "number" | "string"
Array  = Type "[]"                              // string[], number[][]
Object = "{" (이름 ":" Type ("," 이름 ":" Type)* ","?)? "}"
Ref    = 컴포넌트이름                            // 그 컴포넌트의 props를 객체로 참조
Util   = ("Omit" | "Pick") "<" Type "," 키 ("|" 키)* ">"   // 키는 '작은따옴표'
```

원시 3종(`bool`/`number`/`string`)이 잎이고, 배열/객체로 재귀 조합한다. d.ts가 TS
타입으로 매핑한다(`bool`->`boolean`, `T[]`->`T[]`, 객체->`{...}`).

**명명 타입 참조(Ref)** - 다른 컴포넌트 이름을 타입으로 쓰면 그 컴포넌트의 props를
객체로 참조한다(`sec: Section`). 순환 참조는 컴파일 에러.

**유틸 타입(Omit/Pick)** - 안쪽 타입(객체로 환원되는 것)의 필드를 키로 가감한다.
`Omit<Section, 'title'>`은 Section props에서 `title`을 뺀 것, `Pick<Section, 'title' | 'on'>`은
나열한 키만 고른 것(유니온 키). 키는 **작은따옴표**로 쓴다(값 리터럴과 자리가 다르다).
나열한 키가 안쪽에 없으면 컴파일 에러.

### 2.2 `contexts`

```
contexts {
  ActionArea  { section: "actions", tracking: "todo_action", userId: assignee }
  ContentArea { section: "content", priority: priority, completed: completed }
  MetaArea    { section: "meta", dueDate: dueDate }
}
```

`ContextName { key: EXPR, ... }`. 각 컨텍스트는 자기 이름공간을 가진다. 값에는 리터럴과
props 참조(`assignee`, `priority`)가 오며, **객체 prop을 통째로** 넘길 수도 있다(events
페이로드와 같음 - `PlanContext { plan, general }`의 `general`이 객체면 핸들러가
`context.PlanContext.general`을 중첩 객체로 받는다). `@with`로 활성화된다.

### 2.3 `events`

```
events {
  TOGGLE({ id, completed: !completed, timestamp: Date.now() })
  EDIT({ id, title })
  DELETE({ id, title, confirmRequired: true })
  TAG_CLICK({ tagName, todoId: id })
}
```

`EVENT_NAME({ 페이로드 스키마 })`. 페이로드는 객체 리터럴 형태:
- 단축 `id` (= `id: id`)
- `key: EXPR` (`completed: !completed`, `timestamp: Date.now()`)
- 리터럴 `confirmRequired: true`

페이로드 값은 **스칼라뿐 아니라 객체 prop을 통째로** 넘길 수 있다 - `SAVE({ heading, general })`에서
`general`이 객체 prop(`{ open, a, b }`)이면 핸들러는 `data.general`을 그 중첩 객체로 받는다. 값 자리에
객체가 오면 핸들러에 조립된 객체가, 스칼라면 스칼라가 간다.

이벤트명은 대문자 스네이크 관례. `@click:TOGGLE`이 이 `TOGGLE`을 참조한다.

> 의미론 주의: events 페이로드 값은 **이벤트 발생(클라이언트) 시점에 읽는다**. template
> 보간과 실행 위치가 다르다.

---

## 3. template - 요소 문법

### 3.1 요소

```
tag(attr=VALUE ...) { ... children ... }
```

```
div(class="todo-item") { ... }
h3(@click:EDIT) { {title} }
p() { {description} }                       // 속성 없으면 빈 ()
span() { "담당자: {assignee}" }             // 문자열 안 보간 허용
```

- 속성은 공백 구분: `Badge(text={tag} variant="outline" @click:TAG_CLICK)`
- 속성 값: 문자열 `"..."`, 표현식 `{EXPR}`, 배열 `[...]`
- 클래스 배열: `div(class=["card", styles.variant, styles.priority])`

### 3.1.1 self-close (자식 없는 요소)

자식이 없는 요소는 여는 태그 안 끝에 `/`를 두어 self-close로 닫는다. 자식 블록(`{}`)을
쓰지 않는다.

```
img(src="a.png" alt="사진" /)
input(type="text" @input:EDIT /)
br( /)                                      // 속성 없어도 ( /)
hr( /)
```

- **`/` 앞 공백 필수** - 속성 유무와 무관하게 예외 없다(`img(... /)`, `br( /)`). 괄호 안은
  공백 구분이라(`attr @event` 사이 공백처럼) `/`도 한 토큰이라 앞 공백으로 가른다. (처음엔
  엄격하게 강제하고, 필요가 생기면 나중에 완화 - DESIGN #4.5.)
- **축약 없음** - 속성이 없어도 `()`를 생략하지 않는다(`br(/)`가 아니라 `br( /)`).
- `/`는 여는 태그(괄호) 안 마지막 토큰이다. 속성은 `이름=값`/`@event:NAME` 형태라 단독
  `/`와 안 겹쳐 파싱 모호성이 없다.

**자식이 없으면 self-close가 필수** - 요소/컴포넌트 모두. 빈 블록(`div() {}`,
`Comp() {}`)은 **컴파일 에러**다(처음엔 엄격하게, 필요가 생기면 나중에 완화 - DESIGN #4.5).
자식이 있으면 `{}`를 쓴다. **void 요소**(`area base br col embed hr img input link meta source
track wbr`)는 애초에 자식을 못 가지므로 항상 self-close이고, 자식 블록을 쓰면 컴파일
에러(컴파일러가 void 집합을 안다).

### 3.2 컴포넌트 합성 / 별칭

```
Component( /)                // 별칭 없음 -> 타입명이 경로 마디
Alias: Component( /)         // 별칭 바인딩 -> Alias가 경로 마디

CompleteButton: Button(text="완료" variant="primary" @click:TOGGLE /)
TagBadge: Badge(text={tag} variant="outline" @click:TAG_CLICK /)
```

자식(슬롯) 없는 합성은 self-close로 닫는다(#3.1.1). 슬롯을 정의한 컴포넌트는 자식 블록을
가질 수 있다(#3.3):

```
MyTodoCard: Card(title="할일 목록" variant="primary") {
  p(class=["description"]) { "오늘 완료해야 할 작업들" }
  TodoItem(id="1" title="문서 작성" completed=false /)
}
```

### 3.3 슬롯

**정의**(컴포넌트 안) - `@slot`은 자식 콘텐츠가 들어갈 자리다.

```
@slot()          // 무기명
@slot(Header)    // 기명
```

괄호는 **필수**다. 렉서가 개행을 토큰으로 내지 않아, 괄호가 없으면 `@slot` 다음 줄의 형제
노드를 슬롯 이름으로 먹는지 아닌지 가릴 수 없다.

한 컴포넌트는 **무기명 하나 또는 기명 여럿** 중 하나만 쓴다 - 섞으면 컴파일 에러.
둘을 섞지 않으므로 "이름 없는 노드가 어디로 가는가"라는 암묵 규칙이 없다.
같은 자리를 두 번 선언하는 것(`@slot()` 둘, 같은 이름 둘)도 에러다 - 콘텐츠는 한 덩이라
어느 자리로 갈지 정할 수 없다.

**사용**(합성처) - 정의 쪽이 무기명이냐 기명이냐에 따라 갈린다.

```
// 무기명 - 합성 블록이 통째로 그 자리에 들어간다
MyTodoCard: Card(title="할일 목록") {
  p(class=["description"]) { "오늘 완료해야 할 작업들" }
  TodoItem(id="1" title="문서 작성" /)
}

// 기명 - `이름 << 노드`로 슬롯을 지목한다
MyCard: Card(title="...") {
  Header << h1(class="hd") { {title} }
  Body   << TodoList( /)
}
```

`<<` 오른쪽은 노드 하나, 또는 블록(`Name << { ... }`)으로 여러 노드.

정의된 슬롯을 **안 채워도 된다**(props와 다르다 - props는 전부 필수). 안 채운 자리는 비어서
렌더된다. 채우는 순서는 무관하다 - `Header << ... Body << ...`와 `Body << ... Header << ...`는
같은 결과다(방출 순서는 정의 쪽 선언 순서로 정규화된다).

슬롯 콘텐츠는 **쓰는 쪽 컨텍스트로 해석된다** - 코드는 합성 블록 안에 있지만 보간
(`{title}`)은 정의한 컴포넌트가 아니라 **쓰는 쪽 props**를 본다. 이벤트 fullname의 경로도
쓰는 쪽 기준이다(콘텐츠를 쓴 자리가 곧 그 노드의 트리 위치 - DESIGN #1.2 path 축).

---

## 4. template - 디렉티브

| 문법 | 의미 |
|---|---|
| `@with Context { ... }` | 블록 내 이벤트에 컨텍스트 메타데이터 주입 |
| `@if (EXPR) { ... }` | 조건부 렌더링 |
| `@if (EXPR) { ... } @else { ... }` | 조건부 + 대체 |
| `@for (IDENT [, IDENT] of EXPR) { ... }` | 반복 렌더링 (EXPR = 정수, 숫자 prop, 또는 배열). 둘째 IDENT = 회차 인덱스변수 |
| `@click:EVENT` | DOM 이벤트 -> 컴포넌트 이벤트 위임 (속성 위치) |
| `{EXPR}` | 표현식 보간 (자식 위치 또는 문자열 내부) |

예시:

```
@with ContentArea {
  div(class="todo-content") {
    h3(@click:EDIT) { {title} }
    @if (description) { p() { {description} } }
    @if (tags.length > 0) {
      div(class="tags") {
        @for (tag of tags) {
          TagBadge: Badge(text={tag} variant="outline" @click:TAG_CLICK)
        }
      }
    }
  }
}

@with ActionArea {
  @if (completed) {
    UndoButton: Button(text="되돌리기" variant="secondary" @click:TOGGLE)
  } @else {
    CompleteButton: Button(text="완료" variant="primary" @click:TOGGLE)
  }
}
```

`@for`의 선택적 둘째 변수는 **회차 인덱스**다 - `@for (tag, i of tags)`의 `i`는 몸체에서
`{i}`로 쓰거나 그냥 회차 번호로 참조한다. 배열을 중간에서 제거하면 뒤 회차의 인덱스가 당겨져
`{i}` 표시가 자동 갱신된다(요소는 안 움직이고 인덱스만 재정렬 - "값 고정, 위치 이동"). 인덱스변수
없이도(`@for (tag of tags)`) 이벤트 핸들러는 회차 인덱스를 `$0`(중첩이면 안쪽 `$1`)로 늘 받는다
(#6) - 인덱스변수는 그 회차 번호에 몸체용 이름을 붙이는 것뿐이다.

---

## 5. 값 자리 요약

값(EXPR)이 등장하는 위치:

1. `{EXPR}` - template 자식 보간
2. `"... {EXPR} ..."` - 문자열 리터럴 내 보간
3. `attr={EXPR}` - 속성 값
4. `@if (EXPR)` / `@for (_ of EXPR)` - 디렉티브 조건/이터러블
5. `key: EXPR` - contexts 값, events 페이로드 값

쓸 수 있는 형태는 **prop 참조(`title`)와 경로 접근(`assignee.name`)** 뿐이다. 연산자/호출 같은
표현식은 지원하지 않는다. 값 자리에는 leaf(원시값)만 올 수 있다 - 객체/배열을 통째로 두면
컴파일 에러다(합성 인자로 넘기는 것만 예외).

---

## 6. 핸들러 (별도 .ts)

```ts
const handlers = {
  "MyTodoCard.TodoItem.CompleteButton.TOGGLE": (data, { get, set, context }) => {
    set(leafIndex, value);
  },
  // @for 안에서 발화하면 fullname에 회차 세그먼트가 붙고, 회차 번호는 $N으로 들어온다.
  "Item[$0].PICK": (data, { $0 }) => { ... },
  // 이름 세그먼트를 만드는 컴포넌트 없이 @for 직속 element면 익명 세그먼트.
  "[$0].SELECT": (data, { $0 }) => { ... },
};
```

- 키는 **풀네임**(use-site에서 바깥->안쪽 경로 누적, 컨텍스트는 경로에 안 낌).
  `@for` 안이면 `[$N]`이 접미되고, `N`은 중첩까지 누적된 깊이다(`Mid.Col[$0].Card[$1].PICK`).
- 시그니처는 `(data, ctx)`. `data`는 events 선언대로 조립된 payload.
- `ctx`가 담는 것:
  - `get(leafIndex)` / `set(leafIndex, value)` - 상태 읽기/쓰기.
  - `setObject(objectNode, values)` - 객체 노드 통째 교체(안 준 필드는 `undefined`).
  - `setArray(arrayLeafIndex, elems)` - 배열 내용 통째 교체(겹치는 앞자리는 회차 DOM을 유지).
  - `push(...)` / `removeAt(...)` - 배열 요소 추가/제거.
  - `props` - 발화한 컴포넌트 기준 상대 props. `store` - 루트 기준 절대 상태 트리.
  - `context` - `@with`로 주입된 컨텍스트(`context.Area.userId`).
  - `event` - 발화시킨 DOM 이벤트 객체(`event.target.value`로 입력값).
  - `$0`, `$1`, ... - `@for` 회차 인덱스(깊이별).
- 핸들러 본문은 **클라이언트 전용** - 호스트 JS에 위임 가능.