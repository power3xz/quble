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
props { id, title, description, completed, priority, tags, dueDate, assignee }
```

쉼표로 구분된 이름 목록. (현재 타입 표기는 없음 - A-3 미결.)

### 2.2 `contexts`

```
contexts {
  ActionArea  { section: "actions", tracking: "todo_action", userId: assignee }
  ContentArea { section: "content", priority: priority, completed: completed }
  MetaArea    { section: "meta", dueDate: dueDate }
}
```

`ContextName { key: EXPR, … }`. 각 컨텍스트는 자기 이름공간을 가진다. 값에는 리터럴과
props 참조(`assignee`, `priority`)가 온다. `@with`로 활성화된다.

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

이벤트명은 대문자 스네이크 관례. `@click:TOGGLE`이 이 `TOGGLE`을 참조한다.

> 의미론 주의: events 페이로드 식은 **이벤트 발화(클라이언트) 시점에 평가**된다. template
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

### 3.2 컴포넌트 합성 / 별칭

```
Component(…)                 // 별칭 없음 → 타입명이 경로 마디
Alias: Component(…)          // 별칭 바인딩 → Alias가 경로 마디

CompleteButton: Button(text="완료" variant="primary" @click:TOGGLE)
TagBadge: Badge(text={tag} variant="outline" @click:TAG_CLICK)
```

합성된 컴포넌트도 자식 블록을 가질 수 있다(슬롯으로 들어감):

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
| `@for (IDENT in EXPR) { … }` | 반복 렌더링 |
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
        @for (tag in tags) {
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
4. `@if (EXPR)` / `@for (_ in EXPR)` - 디렉티브 조건/이터러블
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
  "MyTodoCard.TodoItem.CompleteButton.TOGGLE": (data, { provided, get, set }) => {
    set((s) => ({ todos: toggle(s.todos, data.id) }));
  },
};
```

- 키는 **풀네임**(use-site에서 바깥→안쪽 경로 누적, 컨텍스트는 경로에 안 낌).
- `(data, { provided, get, set })` 시그니처. 반환 `{ goTo, newPage? } | void | Promise`.
- 핸들러 본문은 **클라이언트 전용** - 호스트 JS에 위임 가능.

---

## 미정 (문법에 영향)

- **타입 표기** - props/events 페이로드에 타입 문법이 없음 (A-3).
- **표현식 부분집합** - 허용 식 범위 (A-2).
- **`@for` key** - 안정적 key 문법 필요 여부 (DESIGN.md §5.1).
- 그 외 `@with` 외 디렉티브, 주석 문법, 이벤트명/별칭 명명 규칙 등 미관찰.
```