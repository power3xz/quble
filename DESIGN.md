# 컨텍스추얼 이벤트 컴포넌트 언어 — 설계 문서 (v0)

> 컴포넌트를 선언하고, 컴파일러가 **합성 맥락(어디에 어떤 이름으로 쓰였는지)**을 정적 분석해
> 이벤트 식별자를 자동 생성하는 프론트엔드 컴파일 언어.

이 문서는 프로젝트 초기 합의 사항을 기록한다. 확정된 결정, 그 결정의 근거,
그리고 **택하지 않은 대안과 그 이유**를 함께 남겨 이후 논의의 기준점으로 삼는다.

---

## 1. 설계 철학

### 1.1 핵심 아이디어 — 맥락이 이벤트의 정체를 결정한다

컴포넌트는 자기가 어디에 어떤 이름으로 쓰일지 모른 채, **추상적인 이벤트**만 선언하고 발생시킨다.

```
// 컴포넌트 내부: 자기 이름을 모른다
Button → @click:TOGGLE   // "TOGGLE 이벤트를 위임한다"
```

이벤트의 **구체적인 정체**는 그 컴포넌트가 _쓰이는 순간_ 결정된다. 컴파일러가 합성 트리를
정적 분석해, 별칭과 합성 경로를 누적한 **풀네임 이벤트 식별자**를 생성한다.

```
// 사용처: 별칭이 정체를 부여한다
CompleteButton: Button(@click:TOGGLE)
  → 'MyTodoCard.TodoItem.CompleteButton.TOGGLE'
```

핸들러는 이 풀네임으로 이벤트를 잡는다.

```ts
'MyTodoCard.TodoItem.CompleteButton.TOGGLE': (data, { provided, get, set }) => { ... }
```

### 1.2 두 개의 직교하는 축

이벤트에 실리는 정보는 서로 독립적인 두 축으로 나뉜다.

- **경로 (누가 쐈는가)** — 별칭/타입명을 누적한 합성 경로. 이벤트 식별자(풀네임)를 이룬다.
- **컨텍스트 (어떤 맥락에서 쐈는가)** — `@with` 블록이 주입하는 메타데이터. 경로에 끼지 않고
  `provided`를 통해 컨텍스트명으로 구분되어 전달된다.

이 둘을 섞지 않는 것이 설계 전반의 일관성을 만든다.

### 1.3 명시성 우선 — 분리는 항상 능동적 선택

- 풀네임만 허용하고 축약을 허용하지 않는다. 이름은 항상 트리상의 위치를 완전히 반영한다.
- 별칭을 주는 것은 "분리하겠다"는 명시적 행위다. 별칭을 주지 않는 것은 "묶겠다"는 명시적 행위다.
- 이름이 길어지는 것은 버그가 아니라 **분리 신호(린트 시그널)** 로 해석한다.

### 1.4 왜 새 컴파일 언어인가

이 모델을 TypeScript 타입만으로 구현하면, 컴포넌트가 한 겹 중첩될 때마다 개발자가
경로 누적 타입(`TContainedEvents<...>`)을 손으로 감싸 올려야 한다. 트리가 깊어질수록
이 래핑이 폭증한다. 합성 트리 정보는 이미 템플릿에 적혀 있는데 타입 시스템이 그것을
모르기 때문에 같은 정보를 두 번 적는 것이다.

> 컴파일러가 템플릿의 합성 트리를 읽어 풀네임 이벤트 타입과 페이로드 타입을 자동 생성하면,
> 개발자는 경로 누적을 한 번도 손으로 쓰지 않는다. 이 보일러플레이트 제거가 새 언어의 정당성이다.

---

## 2. 문법

### 2.1 컴포넌트 정의

```
component TodoItem {
  props { id, title, description, completed, priority, tags, dueDate, assignee }

  contexts {
    ActionArea  { section: "actions", tracking: "todo_action", userId: assignee }
    ContentArea { section: "content", priority: priority, completed: completed }
    MetaArea    { section: "meta", dueDate: dueDate }
  }

  events {
    TOGGLE({ id, completed: !completed, timestamp: Date.now() })
    EDIT({ id, title })
    DELETE({ id, title, confirmRequired: true })
    TAG_CLICK({ tagName, todoId: id })
  }

  template { ... }
}
```

- **`props`** — 컴포넌트가 받는 데이터.
- **`contexts`** — `@with`로 활성화되는 메타데이터 묶음. 각 컨텍스트는 자기 이름공간을 가진다.
- **`events`** — 이벤트명 + 페이로드 스키마 선언. `@click:TOGGLE`은 여기의 `TOGGLE`을 참조해
  데이터를 만들고 위임한다.
- **`template`** — 렌더 트리.

### 2.2 템플릿 디렉티브

| 문법                               | 의미                                             |
| ---------------------------------- | ------------------------------------------------ |
| `Alias: Component(...)`            | 합성 + 별칭 바인딩. 별칭이 경로 마디가 된다.     |
| `@with Context { ... }`            | 블록 내 이벤트에 컨텍스트 메타데이터를 주입한다. |
| `@if (cond) { ... } @else { ... }` | 조건부 렌더링.                                   |
| `@for (item in list) { ... }`      | 반복 렌더링.                                     |
| `@click:EVENT`                     | DOM 이벤트를 컴포넌트 이벤트로 위임한다.         |
| `>>`                               | 슬롯. 자식 콘텐츠가 들어갈 자리.                 |
| `{expr}`                           | 표현식 보간.                                     |

### 2.3 이벤트 위임 흐름

```
자식의 DOM 이벤트 (@click)
  → 컴포넌트 이벤트 (events.TOGGLE 스키마로 데이터 생성)
  → 사용처로 위임 (풀네임으로 핸들러가 잡음)
```

### 2.4 핸들러 시그니처

```ts
type TEventHandler<TStore> = (
  data: <events 스키마에서 추론된 페이로드>,
  params: {
    provided: <인스턴스 식별 + 컨텍스트 메타데이터>,
    get: () => TStore,
    set: (store: Partial<TStore> | ((s: TStore) => Partial<TStore>)) => void,
  }
) => { goTo: string; newPage?: boolean } | void | Promise<...>;
```

- 핸들러는 단순 콜백이 아니라 **상태 변경(`get`/`set`) + 네비게이션(`goTo`)의 단일 진입점**이다.
- `data`와 `provided`의 타입은 컴파일러가 풀네임에 묶어 자동 생성한다.

---

## 3. 풀네임 이벤트 식별자 — 확정 규칙

이벤트 식별자는 합성 경로 전체를 반영한 **풀네임으로만** 생성·등록한다.

### 3.1 경로 마디(segment) 규칙

1. **별칭 우선, 없으면 타입명** — `CompleteButton: Button(...)`은 `CompleteButton`,
   별칭 없는 `TodoItem(...)`은 `TodoItem`이 마디가 된다.
2. **누적 순서는 바깥(사용처) → 안쪽** — `MyTodoCard.TodoItem.CompleteButton.TOGGLE`.
3. **컨텍스트는 경로에 포함하지 않는다** — `@with ActionArea` 안이라도 경로에 `ActionArea`는 끼지 않는다.

### 3.2 같은 풀네임 = 의도적 공유

별칭 없는 같은 타입을 형제로 두 번 쓰면 풀네임이 같아진다. 이는 충돌이 아니라
**같은 의도로 설계된 컴포넌트를 같은 핸들러로 처리하겠다는 선언**이다.

- 구분이 필요했다면 별칭을 줬을 것이다. 별칭을 주지 않은 것이 "묶겠다"는 의사 표현이다.
- 따라서 "같은 이름, 다른 인스턴스"의 구분은 핸들러 이름이 아니라 `provided`가 담당한다.

### 3.3 인스턴스 식별은 `provided`로 일원화

다음 세 경우가 모두 "같은 풀네임을 공유하는 서로 다른 인스턴스"라는 **하나의 문제**로 수렴한다.

- `@for` 반복으로 생성된 항목들
- 별칭 없이 중복된 형제 컴포넌트
- (그 외 같은 풀네임을 공유하는 모든 인스턴스)

이들의 구분은 전부 `provided`를 통해 이루어진다. (구체 구조는 §5 미결 사항)

---

## 4. 의사결정 기록 — 택하지 않은 대안과 이유

### 4.1 짧은 꼬리 이름 매칭 — 채택하지 않음

**대안:** `CompleteButton.TOGGLE`처럼 풀네임의 꼬리만으로 핸들러를 등록하고, 모호할 때만
더 긴 경로를 요구.

**기각 이유:** 같은 짧은 이름이 트리의 다른 상태에 따라 유효해지거나 무효해진다.
같은 핸들러 이름이 어떤 파일에선 되고 어떤 파일에선 안 되는 상황이 생겨 **예측 가능성을
해친다.** 정적 컴파일로 이름을 만든다는 전제의 최대 장점(컴파일 타임 확정)을 스스로 깎는다.
→ **풀네임 강제**를 택했다. 유일성이 공짜로 보장되고, 이름이 곧 위치 정보이며,
리팩토링 시 깨짐이 조용히 숨지 않고 컴파일 에러로 드러난다.

> DX(긴 이름의 불편)는 언어 규칙이 아니라 **툴링**(자동완성, 이벤트 카탈로그, 미처리 이벤트 경고)으로
> 해결한다. 이는 풀네임 강제와 충돌하지 않는다. 자동완성은 필수 기능으로 전제한다.

### 4.2 컨텍스트를 경로 마디에 포함 — 채택하지 않음

**대안:** `MyTodoCard.TodoItem.ActionArea.CompleteButton.TOGGLE`처럼 `@with` 컨텍스트도
경로에 넣기.

**기각 이유:** 경로(누가 쐈나)와 컨텍스트(어떤 맥락에서 쐈나)는 직교하는 두 축이다.
이를 섞으면 이름이 불필요하게 길어지고 두 축의 독립성이 무너진다.
→ 컨텍스트는 경로에서 빼고, `provided`에 **컨텍스트명을 키로** 주입한다(`provided.ActionArea.userId`).
중첩된 컨텍스트도 각자 이름공간을 가지므로 병합/덮어쓰기 고민 자체가 사라진다.

### 4.3 별칭 중복을 충돌 에러로 처리 — 채택하지 않음

**대안:** 같은 풀네임이 두 번 생성되면 컴파일 에러, 또는 자동 인덱스(`TodoItem#0`) 부여.

**기각 이유:** 자동 인덱스는 순서에 의존해 리팩토링에 취약하고, 에러 처리는 "같은 의도의
컴포넌트를 함께 다루고 싶다"는 정당한 사용을 막는다.
→ 같은 풀네임을 **의도적 공유**로 재정의했다(§3.2). 분리는 별칭으로 명시한다.

### 4.4 페이로드를 `any`로 방치 — 채택하지 않음(컴파일 언어로 해소)

**대안:** 핸들러의 `data`/`provided`를 `any`로 둠.

**기각 이유:** 풀네임은 강타입인데 페이로드가 `any`면 절반만 타입세이프하다.
→ `events` 블록의 페이로드 스키마가 이미 있으므로, 컴파일러가 이를 풀네임에 묶어
각 이벤트의 `data` 타입을 자동 추론한다. 컴파일 언어로 통합되면 자연스레 해결되는 영역으로 본다.

---

## 5. 미결 사항 (다음 논의)

### 5.1 `provided`의 구조 — 최우선

`provided`가 식별해야 하는 것이 셋이다.

- **동적 리스트 항목** — 인덱스, 그리고/또는 안정적 key (리스트 재정렬 시 흔들리지 않도록)
- **정적 중복 형제** — 같은 풀네임을 공유하는 인스턴스 중 어느 것인지
- **컨텍스트 메타데이터** — 컨텍스트명별 데이터(`provided.ActionArea.userId`)

이 셋을 `provided` 하나의 구조에 어떻게 담을지 결정 필요.
(관련: `@for`에 안정적 key를 받게 할지 — 반응성의 리스트 갱신 추적과 직결된다.)

### 5.2 반응성 설계

`get` / `set` / `TStore`로 윤곽은 잡혔으나 구체 모델 미정. 동적 리스트의 항목 단위
갱신 추적이 §5.1의 key 결정과 맞물린다.

### 5.3 직렬화/실행 포맷 (장기)

바이너리 컴파일 산출물과 런타임 실행 모델(VM vs JS 코드 생성)은 별도 트랙으로 둔다.
프론트엔드 워크로드 특성상 JS 코드 생성 경로가 유력하나, 추후 결정.

---

## 부록 A. 예시 — TodoItem.comp

```
import Button from "./Button"
import Icon from "./Icon"
import Badge from "./Badge"
import Card from "./Card"

component TodoItem {
  props { id, title, description, completed, priority, tags, dueDate, assignee }

  contexts {
    ActionArea  { section: "actions", tracking: "todo_action", userId: assignee }
    ContentArea { section: "content", priority: priority, completed: completed }
    MetaArea    { section: "meta", dueDate: dueDate }
  }

  events {
    TOGGLE({ id, completed: !completed, timestamp: Date.now() })
    EDIT({ id, title })
    DELETE({ id, title, confirmRequired: true })
    TAG_CLICK({ tagName, todoId: id })
  }

  template {
    div(class="todo-item") {
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

      @with MetaArea {
        @if (dueDate) {
          div(class="due-date") {
            DueDateIcon: Icon(name="calendar")
            span() { {dueDate} }
          }
        }
        @if (assignee) {
          div(class="assignee") { span() { "담당자: {assignee}" } }
        }
      }

      @with ActionArea {
        div(class="actions") {
          @if (completed) {
            UndoButton: Button(text="되돌리기" variant="secondary" @click:TOGGLE)
          } @else {
            CompleteButton: Button(text="완료" variant="primary" @click:TOGGLE)
          }
          DeleteButton: Button(text="삭제" variant="danger" @click:DELETE)
        }
      }
    }
  }
}
```

## 부록 B. 예시 — Card.comp (슬롯)

```
import styles from "./Card.module.css"

component Card {
  props { title, variant, priority }

  template {
    div(class=["card", styles.variant, styles.priority]) {
      h2(class=["title"]) { {title} }
      div(class=["card-body"]) {
        >>   // 슬롯 — children이 들어온다
      }
    }
  }
}
```

## 부록 C. 예시 — 사용처 + 핸들러

```
MyTodoCard: Card(title="할일 목록" variant="primary" priority="high") {
  p(class=["description"]) { "오늘 완료해야 할 작업들" }
  TodoItem(id="1" title="문서 작성" completed=false)
  div(class=["card-footer"]) { span() { "총 3개 항목" } }
}
```

```ts
const handlers: TEventHandlers<
  | "MyTodoCard.TodoItem.CompleteButton.TOGGLE"
  | "MyTodoCard.TodoItem.DeleteButton.DELETE"
  | "MyTodoCard.TodoItem.TagBadge.TAG_CLICK",
  TStore
> = {
  "MyTodoCard.TodoItem.CompleteButton.TOGGLE": (data, { provided, set }) => {
    // data: { id, completed, timestamp }  ← events 스키마에서 추론
    set((s) => ({ todos: toggle(s.todos, data.id) }));
  },
  "MyTodoCard.TodoItem.TagBadge.TAG_CLICK": (data, { provided }) => {
    // provided: 어느 TagBadge 인스턴스인지 (인덱스/key)
  },
};
```
