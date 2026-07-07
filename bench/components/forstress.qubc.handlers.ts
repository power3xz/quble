import type { Handlers } from "./forstress.qubc.d.ts";

const handlers: Handlers = {
  "Row[$0].Col[$1].Card[$2].PICK": (data, { $0, $1, $2 }) => {
    console.log("card clicked", { $0, $1, $2 });
  },
};

export default handlers;
