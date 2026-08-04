# Quble

UI 컴포넌트를 선언하면 **바이트코드(qubb)로 컴파일**되는 프론트엔드 언어. Rust 컴파일러가
`.qubc`를 바이트코드로 내고, JS 런타임이 그걸 디코드해 렌더한다.

## Playground

[**Quble Playground**](https://power3xz.github.io/quble/)

## 문법 예시

### 최소 컴포넌트

```
component Greeting {
  props { name: string }
  template {
    div(class="card") {
      h3(class="name") { "안녕하세요, " {name} "님" }
      img(src="wave.png" alt="인사" /)
    }
  }
}
```

`template`만 필수고 나머지 블록은 선택이다. props는 타입 표기가 필수이며, `{name}`으로
그 값을 보간한다 - 문자열과는 별개 노드라 위처럼 나란히 놓아 잇는다.

자식이 없는 요소는 self-close로 닫는다 - `img(... /)`, `br( /)`. `/` 앞 공백은 필수고,
속성이 없어도 `()`는 생략하지 않는다.

### 반복과 이벤트

```
use "./todo_list.css"

component TodoList {
  props { todos: { text: string, done: string }[] }
  events {
    ADD({ todos })
    DEL({ todos })
  }
  template {
    div(class="todo") {
      button(class="todo__add" @click:ADD) { "+ 추가" }
      ul(class="todo__list") {
        @for (todo, i of todos) {
          li(class="todo__item") {
            span(class="todo__num") { {i} }
            span(class="todo__text") { {todo.text} }
            button(class="todo__del" @click:DEL) { "삭제" }
          }
        }
      }
    }
  }
}
```

`@for (todo, i of todos)`의 둘째 변수는 회차 인덱스다.

### 합성, 별칭, 컨텍스트

```
use Card from "./card.qubc"

component Column {
  props {
    name: string,
    accent: string,
    position: number,
    cards: { title: string, assignee: string }[]
  }
  contexts {
    LaneArea { lane: name, position: position }
  }
  events {
    CLICK_HEADING({ lane: name, position })
    CLICK_REMOVE_CARD({ lane: name })
  }
  template {
    div(class="col") {
      h2(class="col__name" @click:CLICK_HEADING) { {name} }

      @with LaneArea {
        @for (card, seat of cards) {
          div(class="col__slot") {
            Ticket: Card(title={card.title} assignee={card.assignee} seat={seat} /)
            button(class="col__remove" @click:CLICK_REMOVE_CARD) { "x" }
          }
        }
      }
    }
  }
}
```

```
component Card {
  props { title: string, assignee: string, seat: number }
  events {
    CLICK_CARD({ title, seat })
    CLICK_OWNER({ title, assignee })
  }
  template {
    article(class="ticket" @click:CLICK_CARD) {
      h3(class="ticket__title") { {title} }
      button(class="ticket__who" @click:CLICK_OWNER) { {assignee} }
    }
  }
}
```

- `Ticket: Card(...)`의 `Ticket`이 **별칭**이고, 이게 이벤트 경로의 마디가 된다.
  별칭을 안 붙이면 타입명(`Card`)이 마디다.
- `@with LaneArea`는 블록 안 이벤트에 컨텍스트 메타데이터를 주입한다.
  컨텍스트는 경로 마디가 되지 않는다 - 위치와 상황은 별개 축이다.

### 핸들러

`Card`는 `CLICK_OWNER`만 선언했지 자기가 어디 놓일지는 모른다. 그 자리를 정하는 건
Column이고, 컴파일러가 use-site에서 경로를 누적해 키를 만든다:

```
Ticket[$0].CLICK_OWNER
^^^^^^^^^^ ^^^^^^^^^^^
    |           |
    |           +-- Card가 선언한 이벤트
    +-------------- 쓰인 자리: 별칭 Ticket, @for 회차 $0
```

핸들러는 그 키로 잡는다.

```ts
export const handlers = {
  // @for 밖에서 쏜 이벤트라 회차 세그먼트가 없다
  CLICK_HEADING: (data) => {
    console.log("컬럼 제목:", data.lane, "/ 자리:", data.position);
  },

  // @for 직속 element는 이름 마디 없이 익명 세그먼트만 붙는다
  "[$0].CLICK_REMOVE_CARD": (data, { props, removeAt, $0 }) => {
    removeAt(props.cards, $0);
  },

  // $0으로 몇 번째 회차인지, context로 @with가 주입한 값을 받는다
  "Ticket[$0].CLICK_CARD": (data, { $0, context }) => {
    console.log(`${context.LaneArea.lane} ${$0}번째: ${data.title}`);
  },

  // set으로 그 카드의 props를 바꾸면 해당 DOM만 갱신된다
  "Ticket[$0].CLICK_OWNER": (data, { props, set }) => {
    set(props.assignee, data.assignee === "지현" ? "민수" : "지현");
  },
};
```
