# Quble 문법 레퍼런스 (v0)

DESIGN.md에 흩어진 문법을 한곳에 정리한다. 이 문서는 **표층 문법(surface syntax)**만
다룬다. 실행 위치·타입·반응성 같은 의미론은 DESIGN.md와 process.md를 따른다.

> 표기: `EXPR`=표현식 슬롯, `IDENT`=식별자, `…`=반복, `[ ]`=선택적.

---

## 1. 파일 구조

```
use Button from "./Button"          // 다른 컴포넌트 import (여러 개: use A, B from "…")
use "./Card.module.css"             // 에셋 - 이름 없이 경로만

component IDENT {
  props    { … }   // 선택
  contexts { … }   // 선택
  events   { … }   // 선택
  template { … }   // 필수
}
```

한 파일에 `use …`들과 컴포넌트 선언(들). 블록 순서는 위 관례를 따른다.

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

원시 3종(`bool`/`number`/`string`)이 잎이고, 배열·객체로 재귀 조합한다. d.ts가 TS
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

`ContextName { key: EXPR, … }`. 각 컨텍스트는 자기 이름공간을 가진다. 값에는 리터럴과
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

> 의미론 주의: events 페이로드 식은 **이벤트 발생(클라이언트) 시점에 평가**된다. template
> 보간식(§4)과 실행 위치가 다르다. (process.md A-2 참조.)

---

## 3. template - 요소 문법

### 3.1 요소

```
tag(attr=VALUE …) { … children … }
```

```
div(class="todo-item") { … }
h3(@click:EDIT) { {title} }
p() { {description} }                       // 속성 없으면 빈 ()
span() { "담당자: {assignee}" }             // 문자열 안 보간 허용
```

- 속성은 공백 구분: `Badge(text={tag} variant="outline" @click:TAG_CLICK)`
- 속성 값: 문자열 `"…"`, 표현식 `{EXPR}`, 배열 `[…]`
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

- **`/` 앞 공백 필수** - 속성 유무와 무관하게 예외 없다(`img(… /)`, `br( /)`). 괄호 안은
  공백 구분이라(`attr @event` 사이 공백처럼) `/`도 한 토큰이라 앞 공백으로 가른다. (처음엔
  엄격하게 강제하고, 필요가 생기면 나중에 완화 - DESIGN §4.5.)
- **축약 없음** - 속성이 없어도 `()`를 생략하지 않는다(`br(/)`가 아니라 `br( /)`).
- `/`는 여는 태그(괄호) 안 마지막 토큰이다. 속성은 `이름=값`/`@event:NAME` 형태라 단독
  `/`와 안 겹쳐 파싱 모호성이 없다.

**자식이 없으면 self-close가 필수** - 요소·컴포넌트 모두. 빈 블록(`div() {}`,
`Comp() {}`)은 **컴파일 에러**다(처음엔 엄격하게, 필요가 생기면 나중에 완화 - DESIGN §4.5).
자식이 있으면 `{}`를 쓴다. **void 요소**(`area base br col embed hr img input link meta source
track wbr`)는 애초에 자식을 못 가지므로 항상 self-close이고, 자식 블록을 쓰면 컴파일
에러(컴파일러가 void 집합을 안다).

### 3.2 컴포넌트 합성 / 별칭

```
Component( /)                // 별칭 없음 → 타입명이 경로 마디
Alias: Component( /)         // 별칭 바인딩 → Alias가 경로 마디

CompleteButton: Button(text="완료" variant="primary" @click:TOGGLE /)
TagBadge: Badge(text={tag} variant="outline" @click:TAG_CLICK /)
```

자식(슬롯) 없는 합성은 self-close로 닫는다(§3.1.1). 자식 블록을 가질 수도 있다(슬롯으로 들어감):

```
MyTodoCard: Card(title="할일 목록" variant="primary") {
  p(class=["description"]) { "오늘 완료해야 할 작업들" }
  TodoItem(id="1" title="문서 작성" completed=false)
}
```

### 3.3 슬롯

```
>>     // 자식 콘텐츠가 들어갈 자리 (Card 내부)
```

---

## 4. template - 디렉티브

| 문법 | 의미 |
|---|---|
| `@with Context { … }` | 블록 내 이벤트에 컨텍스트 메타데이터 주입 |
| `@if (EXPR) { … }` | 조건부 렌더링 |
| `@if (EXPR) { … } @else { … }` | 조건부 + 대체 |
| `@for (IDENT of EXPR) { … }` | 반복 렌더링 (EXPR = 정수, 숫자 prop, 또는 배열) |
| `@click:EVENT` | DOM 이벤트 → 컴포넌트 이벤트 위임 (속성 위치) |
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

> 의미론 주의: `@if`/`@for`의 조건·이터러블과 `{EXPR}` 보간은 **서버·클라 양쪽에서
> 평가**된다(SSR). 따라서 결정적·부수효과 없는 식이어야 한다 - 미확정 해석, process.md A-2.

---

## 5. 표현식 슬롯 요약

문법상 EXPR이 등장하는 위치:

1. `{EXPR}` - template 자식 보간
2. `"… {EXPR} …"` - 문자열 리터럴 내 보간
3. `attr={EXPR}` - 속성 값
4. `@if (EXPR)` / `@for (_ of EXPR)` - 디렉티브 조건/이터러블
5. `key: EXPR` - contexts 값, events 페이로드 값

관찰된 식 형태: prop 참조(`title`), 멤버 접근(`styles.variant`, `tags.length`),
단항(`!completed`), 비교(`tags.length > 0`), 호출(`Date.now()`).
**어디까지 허용할지(부분집합 정의)는 A-2 미결.**

---

## 6. 핸들러 (별도 .ts)

```ts
const handlers: TEventHandlers<
  | "MyTodoCard.TodoItem.CompleteButton.TOGGLE"
  | "MyTodoCard.TodoItem.TagBadge.TAG_CLICK",
  TStore
> = {
  "MyTodoCard.TodoItem.CompleteButton.TOGGLE": (data, { context, get, set }) => {
    set((s) => ({ todos: toggle(s.todos, data.id) }));
  },
};
```

- 키는 **풀네임**(use-site에서 바깥->안쪽 경로 누적, 컨텍스트는 경로에 안 낌).
- `(data, { context, get, set })` 시그니처. `context`는 `@with`로 주입된 컨텍스트(`context.Area.userId`).
  배열 요소 식별 슬롯은 미결(DESIGN.md §5.1). 반환 `{ goTo, newPage? } | void | Promise`.
- 핸들러 본문은 **클라이언트 전용** - 호스트 JS에 위임 가능.

---

## 미정 (문법에 영향)

- **타입 표기** - props는 타입 필수(§2.1). events 페이로드 타입 표기와 명명 타입(재사용
  이름 붙은 타입)은 아직 없음 (A-3).
- **표현식 부분집합** - 허용 식 범위 (A-2).
- **`@for` key** - 안정적 key 문법 필요 여부 (DESIGN.md §5.1).
- 그 외 `@with` 외 디렉티브, 주석 문법, 이벤트명/별칭 명명 규칙 등 미관찰.
```