# 컨텍스추얼 이벤트 컴포넌트 언어 - 설계 문서 (v0)

> 컴포넌트를 선언하고, 컴파일러가 **합성 맥락(어디에 어떤 이름으로 쓰였는지)**을 정적 분석해
> 이벤트 식별자를 자동 생성하는 프론트엔드 컴파일 언어.

이 문서는 **합의된 설계의 지금 상태**를 기록한다 - 무엇이 어떻게 동작하기로 되어 있는가.
그렇게 정한 이유와 **택하지 않은 대안**은 DECISIONS.md에 있다.

---

## 1. 설계 철학

### 1.1 핵심 아이디어 - 맥락이 이벤트의 정체를 결정한다

컴포넌트는 자기가 어디에 어떤 이름으로 쓰일지 모른 채, **추상적인 이벤트**만 선언하고 발생시킨다.

```
// 컴포넌트 내부: 자기 이름을 모른다
Button -> @click:TOGGLE   // "TOGGLE 이벤트를 위임한다"
```

이벤트의 **구체적인 정체**는 그 컴포넌트가 _쓰이는 순간_ 결정된다. 컴파일러가 합성 트리를
정적 분석해, 별칭과 합성 경로를 누적한 **풀네임 이벤트 식별자**를 생성한다.

```
// 사용처: 별칭이 정체를 부여한다
CompleteButton: Button(@click:TOGGLE)
  -> 'MyTodoCard.TodoItem.CompleteButton.TOGGLE'
```

핸들러는 이 풀네임으로 이벤트를 잡는다.

```ts
'MyTodoCard.TodoItem.CompleteButton.TOGGLE': (data, { context, get, set }) => { ... }
```

### 1.2 두 개의 직교하는 축

이벤트에 실리는 정보는 서로 독립적인 두 축으로 나뉜다.

- **경로 (누가 쐈는가)** - 별칭/타입명을 누적한 합성 경로. 이벤트 식별자(풀네임)를 이룬다.
- **컨텍스트 (어떤 맥락에서 쐈는가)** - `@with` 블록이 주입하는 메타데이터. 경로에 끼지 않고
  `context`를 통해 컨텍스트명으로 구분되어 전달된다.

이 둘을 섞지 않는 것이 설계 전반의 일관성을 만든다.

### 1.3 명시성 우선 - 분리는 항상 능동적 선택

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

### 2.1 컴포넌트 가져오기 - `use`

다른 파일에 정의한 컴포넌트를 `use`로 가져와 `template`에서 합성에 쓴다. 한 소스 파일(`.qubc`)은
최상위 `use` 선언과 컴포넌트 정의로 구성된다.

```
use Thumbnail from "./thumbnail.qubc"
use Stat, Badge from "./parts.qubc"

component ProfileCard {
  template {
    Thumbnail(...) {}
    Stat(...) {}
    Badge(...) {}
  }
}
```

- 가져올 이름을 **명시적으로 나열**한다(`use A, B from "..."`). 무엇이 들어오는지 선언이 분명해야
  한다(#1.3 명시성 우선).
- 경로는 가져오는 파일 기준 **상대경로**이며 `./`로 시작한다(빌트인 이름 여지를 남긴다).
- 가져온 이름이 대상 파일에 없으면, 같은 이름이 서로 다른 파일에 정의돼 있으면, `use` 그래프에
  순환이 있으면 컴파일 에러다.

> 파일을 어떻게 쪼개든 결과는 같다 - 컴파일러가 `use` 그래프를 따라 하나의 모듈로 합치므로,
> 한 파일에 모아 쓴 것과 **동일한 산출물**이 나온다. 파일 분리는 산출물에 영향을 주지 않는 구성
> 수단이다. (런타임에 모듈을 따로 전송/연결하는 동적 링크는 미결.)

### 2.2 컴포넌트 정의

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

- **`props`** - 컴포넌트가 받는 데이터. 각 prop은 `이름: 타입`으로 타입이 필수다(문법은
  SYNTAX.md #2.1). 타입은 quble이 소유하는 재귀 구조(원시 `bool`/`number`/`string` +
  배열/객체)로, d.ts가 TS 타입으로 매핑한다. 명명 타입은 아직 없다(인라인만).
- **`contexts`** - `@with`로 활성화되는 메타데이터 묶음. 각 컨텍스트는 자기 이름공간을 가진다.
- **`events`** - 이벤트명 + 페이로드 스키마 선언. `@click:TOGGLE`은 여기의 `TOGGLE`을 참조해
  데이터를 만들고 위임한다.
- **`template`** - 렌더 트리.

### 2.3 템플릿 디렉티브

| 문법                               | 의미                                             |
| ---------------------------------- | ------------------------------------------------ |
| `Alias: Component(...)`            | 합성 + 별칭 바인딩. 별칭이 경로 마디가 된다.     |
| `@with Context { ... }`            | 블록 내 이벤트에 컨텍스트 메타데이터를 주입한다. |
| `@if (cond) { ... } @else { ... }` | 조건부 렌더링.                                   |
| `@for (item in list) { ... }`      | 반복 렌더링.                                     |
| `@click:EVENT`                     | DOM 이벤트를 컴포넌트 이벤트로 위임한다.         |
| `@slot [name]`                     | 슬롯 정의. 자식 콘텐츠가 들어갈 자리. 한 컴포넌트는 무기명 하나 **또는** 기명 여럿 - 섞을 수 없다. |
| `Name << 노드`                     | 기명 슬롯에 콘텐츠 주입. 무기명은 합성 블록(`Comp(...) { ... }`)이 그대로 들어간다. |
| `{expr}`                           | 표현식 보간.                                     |

### 2.4 이벤트 위임 흐름

```
자식의 DOM 이벤트 (@click)
  -> 컴포넌트 이벤트 (events.TOGGLE 스키마로 데이터 생성)
  -> 사용처로 위임 (풀네임으로 핸들러가 잡음)
```

### 2.5 핸들러 시그니처

```ts
type TEventHandler<TStore> = (
  data: <events 스키마에서 추론된 페이로드>,
  params: {
    context: <@with로 주입된 컨텍스트 - 컨텍스트명별 메타데이터>,
    $0, $1, ...: number,  // @for 회차 인덱스(바깥 $0, 안쪽 $1). 안정적 key는 미결
    get: () => TStore,
    set: (store: Partial<TStore> | ((s: TStore) => Partial<TStore>)) => void,
  }
) => { goTo: string; newPage?: boolean } | void | Promise<...>;
```

- 핸들러는 단순 콜백이 아니라 **상태 변경(`get`/`set`) + 네비게이션(`goTo`)의 단일 진입점**이다.
- `data`와 `context`의 타입은 컴파일러가 풀네임에 묶어 자동 생성한다.
- **`context`** - `@with Area { ... }`로 주입한 메타데이터를 컨텍스트명별로 받는다
  (`context.Area.userId`). 값은 `data`와 같은 처리(leafIndex로 바인딩 시점 고정, 발생 시점에
  현재값). 인스턴스 식별과는 성격이 달라 별도 슬롯으로 둔다. (구현: BYTECODE.md `ENTER_CONTEXT`.)

---

## 3. 풀네임 이벤트 식별자 - 확정 규칙

이벤트 식별자는 합성 경로 전체를 반영한 **풀네임으로만** 생성/등록한다.

### 3.1 경로 마디(segment) 규칙

1. **별칭 우선, 없으면 타입명** - `CompleteButton: Button(...)`은 `CompleteButton`,
   별칭 없는 `TodoItem(...)`은 `TodoItem`이 마디가 된다.
2. **누적 순서는 바깥(사용처) -> 안쪽** - `MyTodoCard.TodoItem.CompleteButton.TOGGLE`.
3. **컨텍스트는 경로에 포함하지 않는다** - `@with ActionArea` 안이라도 경로에 `ActionArea`는 끼지 않는다.

### 3.2 같은 풀네임 = 의도적 공유

별칭 없는 같은 타입을 형제로 두 번 쓰면 풀네임이 같아진다. 이는 충돌이 아니라
**같은 의도로 설계된 컴포넌트를 같은 핸들러로 처리하겠다는 선언**이다.

- 구분이 필요했다면 별칭을 줬을 것이다. 별칭을 주지 않은 것이 "묶겠다"는 의사 표현이다.
- 따라서 "같은 이름, 여러 개"의 구분은 핸들러 이름이 아니라 별도 식별 슬롯이 담당한다.

### 3.3 배열로 펼쳐진 같은 요소를 핸들러에서 어떻게 구분하나

`@for`로 todo 100개를 그리면 그 안의 삭제 버튼 100개가 **전부 같은 풀네임**이다. 3번째를
눌렀을 때 핸들러는 하나인데, 어느 항목인지 어떻게 아나? 풀네임 **템플릿**은 하나로 두고
(`List.VideoItem[$n].CLICK` - 회차마다 이름을 굳히지 않는다), 실제 회차는 **인덱스로 분리 전달**한다.

- 풀네임에 `[$n]` 자리를 두되 `n`은 그 세그먼트를 감싼 `@for`의 중첩 깊이(바깥 `$0`, 안쪽 `$1`).
- 발화 시점 회차 인덱스를 핸들러 둘째 인자로 준다: `(data, { $0, $1 })` - context/set과 같은 결.

"어느 이벤트냐"(정적 이름)와 "몇 번째냐"(런타임 인덱스)를 분리해 우리 풀네임 철학(정적
예측가능성)을 지킨다. 컨텍스트 메타데이터(`context`)와는 성격이 달라 섞지 않는다.

**남은 것 - 항목 식별자(key).** 인덱스는 리스트가 재정렬되면 딴 항목을 가리킨다. 위치가 아니라
항목 정체로 짚으려면 항목에 붙는 안정적 식별자가 필요한데, 문법/필요 여부가 미결이다(#4).

---

## 4. 미결 사항 (다음 논의)

### 배열 항목 식별자 (key)

핸들러가 같은 풀네임의 배열 요소를 구분하는 **인덱스**는 결정/구현됐다(#3.3 - `[$n]` 풀네임 +
핸들러 `{ $0, $1 }`). 남은 건 **항목 식별자(key)** - 인덱스는 재정렬 시 딴 항목을 가리키므로,
위치가 아니라 항목 정체로 짚는 식별자다(React `key`, Svelte `(id)`에 해당). `@for`에 지정 문법을
둘지, 반응성의 리스트 갱신 추적과 어떻게 엮을지가 미결.

### 핸들러 문법 (아이디어)

핸들러는 컴포넌트와 분리된 선언이다(사용처에 묶이고, `get`/`set`이 부수효과라
순수 컴포넌트의 위치 독립성을 깨므로).

**지금:** 짝 TypeScript 파일에 객체 리터럴로 쓴다(`card.qubc` <-> `card.qubc.handlers.ts`).
fullname은 따옴표 안 문자열 키다.

    export const handlers = {
      'MyTodoCard.TodoItem.CompleteButton.TOGGLE': (data, params) => { ... },
    };

문자열이라 언어 차원의 자동완성/검증이 안 되는 자리를, 편집기 확장이 타입을 주입해 메우고
있다(짝 `.qubc`를 컴파일해 얻은 타입).

**종착점(아이디어):** quble 자체 문법을 둔다. 수렴 중인 형태:

    handle MyTodoCard.TodoItem.CompleteButton.TOGGLE (data) {
      <본문 - JS 위임>
    }

- **fullname을 문자열이 아니라 코드로 쓴다** - 점으로 잇는 식별자다. 점마다 컴파일러가
  합성 트리에서 실재하는 다음 마디만 자동완성하고, 없는 경로는 컴파일 에러로 잡는다.
  편집기 확장 없이 언어가 직접 하는 것이 지금과 다른 점이다.
- **본문은 JS 위임** - `{ }` 안은 JS 비슷한 표현식, quble는 깊이 파싱하지 않는다.
  quble의 책임은 fullname 생성과 본문 진입 시 스코프 주입(`data`, `params`, `get`, `set`).
  위임의 경계는 아직 정하지 않았다 - 본문을 그대로 토해낼지, `set` 같은 키워드만 인식할지.

탈락한 대안(경로 블록 중첩, 객체 리터럴을 quble 문법으로 삼기)과 그 이유는
DECISIONS.md "핸들러 선언 문법".

---

## 부록 A. 예시 - TodoItem.comp

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

## 부록 B. 예시 - Card.comp (슬롯)

```
import styles from "./Card.module.css"

component Card {
  props { title, variant, priority }

  template {
    div(class=["card", styles.variant, styles.priority]) {
      h2(class=["title"]) { {title} }
      div(class=["card-body"]) {
        @slot   // 무기명 슬롯 - children이 들어온다
      }
    }
  }
}
```

## 부록 C. 예시 - 사용처 + 핸들러

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
    // data: { id, completed, timestamp }  <- events 스키마에서 추론
    set((s) => ({ todos: toggle(s.todos, data.id) }));
  },
  "MyTodoCard.TodoItem.TagBadge.TAG_CLICK": (data, { provided }) => {
    // provided: 어느 TagBadge 인스턴스인지 (인덱스/key)
  },
};
```
