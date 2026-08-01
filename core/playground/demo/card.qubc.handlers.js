const OWNERS = ["지현", "민수", "연희", "도윤"];
const POINTS = ["1", "2", "3", "5", "8", "13"];

const next = (list, current) => list[(list.indexOf(current) + 1) % list.length];

export default {
  CLICK_CARD: (data) => {
    console.log("카드:", data.title, "/ 자리:", data.seat);
  },

  CLICK_OWNER: (data, { props, set }) => {
    const owner = next(OWNERS, data.assignee);
    set(props.assignee, owner);
    console.log("담당자:", data.assignee, "->", owner);
  },

  "Flag.CLICK_BADGE": (data) => {
    console.log("긴급 배지:", data.text, data.tone);
  },

  "Points.CLICK_BADGE": (data, { props, set }) => {
    const points = next(POINTS, data.text);
    set(props.text, points);
    console.log("포인트:", data.text, "->", points);
  },
};
