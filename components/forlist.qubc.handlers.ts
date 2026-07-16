import type { Handlers } from "./forlist.qubc.d.ts";

const handlers: Handlers = {
  "Row[$0].CLICK": (data, { $0 }) => {
    alert("클릭한 회차 인덱스: $0 = " + $0);
  },
};

export default handlers;
