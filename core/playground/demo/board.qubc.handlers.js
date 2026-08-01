const OWNERS = ["지현", "민수", "연희", "도윤"];
const POINTS = ["1", "2", "3", "5", "8", "13"];

const next = (list, current) => list[(list.indexOf(current) + 1) % list.length];

let madeColumns = 0;
let madeCards = 0;

export default {
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
};
