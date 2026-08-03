const OWNERS = ["지현", "민수", "연희", "도윤"];
const POINTS = ["1", "2", "3", "5", "8", "13"];

const next = (list, current) => list[(list.indexOf(current) + 1) % list.length];

let made = 0;

export const handlers = {
  CLICK_ADD_CARD: (data, { props, push }) => {
    made += 1;
    push(props.cards, {
      title: `새 카드 ${made}`,
      assignee: OWNERS[made % OWNERS.length],
      points: "1",
      urgent: false,
    });
    console.log("카드 추가:", data.lane);
  },

  // @for 직속 element라 익명 세그먼트가 붙는다. 배열(props.cards)을 가진 Column이 쏜다.
  "[$0].CLICK_REMOVE_CARD": (data, { props, removeAt, $0 }) => {
    removeAt(props.cards, $0);
    console.log(`카드 제거: ${data.lane} ${$0}번째`);
  },

  CLICK_HEADING: (data) => {
    console.log("컬럼 제목:", data.lane, "/ 자리:", data.position);
  },

  "Ticket[$0].CLICK_CARD": (data, { $0, context }) => {
    console.log(`카드: ${data.title} (${$0}번째)`);
    console.log("  레인:", context.LaneArea.lane);
  },

  "Ticket[$0].CLICK_OWNER": (data, { props, set }) => {
    const owner = next(OWNERS, data.assignee);
    set(props.assignee, owner);
    console.log("담당자:", data.assignee, "->", owner);
  },

  "Ticket[$0].Flag.CLICK_BADGE": (data) => {
    console.log("긴급 배지:", data.text);
  },

  "Ticket[$0].Points.CLICK_BADGE": (data, { props, set }) => {
    const points = next(POINTS, data.text);
    set(props.text, points);
    console.log("포인트:", data.text, "->", points);
  },
};
