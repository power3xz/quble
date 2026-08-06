const OWNERS = ["지현", "민수", "연희", "도윤"];
const POINTS = ["1", "2", "3", "5", "8", "13"];

const next = (list, current) => list[(list.indexOf(current) + 1) % list.length];

let madeColumns = 0;
let madeCards = 0;

// 드래그로 집은 카드 - GRAB_FROM이 적고 DROP_AT_END가 읽는다. 집은 컬럼의 cards(cardsLeaf)를
// 함께 들고 있어야 다른 컬럼에 놓을 때 원래 자리에서 빼낼 수 있다.
let grabbed = null;

// 컬럼의 카드들을 store에서 값으로 읽는다 - 재배열은 배열 전체를 setArray해야 하므로 지금 값이
// 필요하다. 요소를 값 객체로 한 번에 주는 것은 없어 필드마다 get한다.
const cardsOf = (cards, { get }) =>
  Array.from({ length: cards.length }, (_, i) => ({
    title: get(cards[i].title),
    assignee: get(cards[i].assignee),
    points: get(cards[i].points),
    urgent: get(cards[i].urgent),
  }));

// from번째 카드를 to번째 자리로 옮긴다. 제자리면 false.
const reorder = (cards, from, to) => {
  const at = Math.min(to, cards.length);
  if (from === at || from === at - 1) {
    return false;
  }
  const [moved] = cards.splice(from, 1);
  cards.splice(at > from ? at - 1 : at, 0, moved);
  return true;
};

// 커서를 따라다니는 고스트 - 그리는 건 템플릿(@if ghost.isDragging)이고 여기서는 위치만 set한다.
// mousemove를 quble 이벤트로 받지 않는 이유: 위임 리스너는 드래그 중이 아닐 때도 늘 돌고,
// 카드를 빠르게 끌면 커서가 카드를 벗어나 추적이 끊긴다. 집는 순간 document에 직접 달고 뗀다.
const startGhost = (card, event, { store, set }) => {
  const box = card.getBoundingClientRect();
  // 집은 지점과 카드 좌상단의 차이 - 이걸 빼야 고스트가 커서에 붙어 따라온다.
  const dx = event.clientX - box.left;
  const dy = event.clientY - box.top;
  const move = (e) => {
    set(store.ghost.style, `width: ${box.width}px; transform: translate(${e.clientX - dx}px, ${e.clientY - dy}px)`);
  };
  move(event);
  document.addEventListener("mousemove", move);

  return () => {
    document.removeEventListener("mousemove", move);
    set(store.ghost.isDragging, false);
  };
};

// 컬럼 밖에 놓으면 DROP_AT_END가 안 불린다 - 고스트가 남지 않게 여기서 거둔다.
// 이 리스너는 모듈 평가 시점(마운트 전)에 달려 quble의 위임보다 먼저 돈다. 그대로 치우면
// 드롭을 가로채므로, 한 틱 미뤄 quble 핸들러가 grabbed를 소비할 기회를 먼저 준다.
document.addEventListener("mouseup", () => {
  setTimeout(() => {
    if (grabbed) {
      grabbed.release();
      grabbed = null;
    }
  }, 0);
});

export const handlers = {
  CLICK_ADD_COLUMN: (data, { props, push }) => {
    madeColumns += 1;
    push(props.columns, {
      name: `새 컬럼 ${madeColumns}`,
      accent: "background: #eae6ff",
      cards: [],
    });
    console.log("컬럼 추가:", data.title);
  },

  "Lane[$0].CLICK_ADD_CARD": (data, { props, push, $0 }) => {
    madeCards += 1;
    push(props.cards, {
      title: `새 카드 ${madeCards}`,
      assignee: OWNERS[madeCards % OWNERS.length],
      points: "1",
      urgent: false,
    });
    console.log(`카드 추가: ${data.lane} (${$0}번 컬럼)`);
  },

  // 제거 버튼은 @for 직속 element라 익명 세그먼트 [$N]이 붙는다(SYNTAX.md #6).
  // 배열을 가진 쪽에서 쏴야 removeAt이 그 배열을 짚는다 - Card 안에 두면 부모 cards를 모른다.
  "[$0].CLICK_REMOVE_COLUMN": (_data, { props, removeAt, $0 }) => {
    removeAt(props.columns, $0);
    console.log(`컬럼 제거: ${$0}번`);
  },

  "Lane[$0].[$1].CLICK_REMOVE_CARD": (data, { props, removeAt, $1 }) => {
    removeAt(props.cards, $1);
    console.log(`카드 제거: ${data.lane} ${$1}번째`);
  },

  "Lane[$0].CLICK_HEADING": (data, { context }) => {
    console.log("컬럼 제목:", data.lane, "/ 보드:", context.BoardArea.board);
  },

  "Lane[$0].Ticket[$1].CLICK_CARD": (data, { $0, $1, context }) => {
    console.log(`카드: ${data.title}`);
    console.log(`  자리: ${$0}번 컬럼 ${$1}번째`);
    console.log(`  레인: ${context.LaneArea.lane}`);
  },

  "Lane[$0].Ticket[$1].CLICK_OWNER": (data, { props, set }) => {
    const owner = next(OWNERS, data.assignee);
    set(props.assignee, owner);
    console.log("담당자:", data.assignee, "->", owner);
  },

  "Lane[$0].Ticket[$1].Flag.CLICK_BADGE": (data) => {
    console.log("긴급 배지:", data.text);
  },

  "Lane[$0].Ticket[$1].Points.CLICK_BADGE": (data, { props, set }) => {
    const points = next(POINTS, data.text);
    set(props.text, points);
    console.log("포인트:", data.text, "->", points);
  },

  // 집기 - 카드가 아니라 컬럼이 받는다. 빼낼 때 그 컬럼의 cards를 짚어야 하는데(removeAt)
  // 카드 쪽 핸들러는 자기 값만 알기 때문이다. 어느 카드인지는 mousedown의 target으로 되짚는다.
  "Lane[$0].GRAB_FROM": (_data, ctx) => {
    const { props, store, get, set, event, $0 } = ctx;
    const card = event.target.closest(".ticket");
    if (!card) {
      return; // 카드 사이 여백을 눌렀다
    }
    // 어느 자리를 눌렀는지는 커서 위치라 DOM으로만 안다 - 그 자리의 값은 store에서 읽는다.
    const slot = card.closest(".column__slot");
    const seat = [...slot.parentNode.children].indexOf(slot);
    const picked = {
      title: get(props.cards[seat].title),
      assignee: get(props.cards[seat].assignee),
      points: get(props.cards[seat].points),
      urgent: get(props.cards[seat].urgent),
    };

    // 고스트에 실을 값 - 끌고 있는 카드 그대로다. style은 startGhost가 커서를 따라 계속 set하므로
    // 여기서 건드리지 않는다(setObject로 통째 교체하면 그 값이 날아간다).
    set(store.ghost.title, picked.title);
    set(store.ghost.assignee, picked.assignee);
    set(store.ghost.points, picked.points);
    set(store.ghost.urgent, picked.urgent);
    set(store.ghost.isDragging, true);
    // 집힌 카드를 흐리게 - quble이 그리는 data-dragging과 겹치지 않게 클래스로 얹는다.
    card.classList.add("ticket--grabbed");

    const stopGhost = startGhost(card, event, ctx);
    grabbed = {
      lane: $0,
      seat,
      card: picked,
      cardsLeaf: props.cards,
      release: () => {
        stopGhost();
        card.classList.remove("ticket--grabbed");
      },
    };
    console.log(`집음: ${picked.title} (${$0}번 컬럼 ${seat}번째)`);
  },

  // 놓기 - 놓는 컬럼이 받는다. 같은 컬럼이면 순서만 바꾸고, 다른 컬럼이면 집은 쪽에서 빼고
  // 이쪽에 끼운다. 두 배열 모두 필요한데 집은 쪽 cards는 GRAB_FROM이 기억해 둔 것을 쓴다.
  "Lane[$0].DROP_AT_END": (_data, ctx) => {
    const { props, setArray, removeAt, event, $0 } = ctx;
    if (!grabbed) {
      return;
    }
    const { lane, seat, card, cardsLeaf, release } = grabbed;
    grabbed = null;
    release();

    const cards = cardsOf(props.cards, ctx);

    if (lane === $0) {
      if (!reorder(cards, seat, dropSeat(event, cards.length))) {
        return;
      }
      setArray(props.cards, cards);
      console.log(`옮김: ${$0}번 컬럼 안에서 ${seat}번째 카드`);
      return;
    }

    // 컬럼 간 - 넣는 쪽을 먼저 그리고 빼는 쪽을 지운다. 순서를 바꾸면 빼는 순간 화면이
    // 한 번 줄었다 늘어난다.
    cards.splice(Math.min(dropSeat(event, cards.length), cards.length), 0, card);
    setArray(props.cards, cards);
    removeAt(cardsLeaf, seat);
    console.log(`옮김: ${lane}번 컬럼 ${seat}번째 -> ${$0}번 컬럼`);
  },
};

// 놓은 자리 - 커서가 어느 카드 위인지 DOM으로 되짚는다. 위쪽 절반이면 그 앞, 아래쪽이면 그 뒤.
// 카드 밖(컬럼 여백)이면 맨 끝이다.
const dropSeat = (event, count) => {
  const slot = event.target.closest(".column__slot");
  if (!slot) {
    return count;
  }
  const seat = [...slot.parentNode.children].indexOf(slot);
  const box = slot.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? seat : seat + 1;
};
