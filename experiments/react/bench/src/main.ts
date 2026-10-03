// bench-expr의 주문 목록(orders.qubc)을 quble-react로 컴파일해 같은 하네스로 잰다. 핸들러, 스타일,
// 데이터는 bench-expr의 것을 그대로 쓴다. 산출 orders.tsx는 bench.sh가 만든다.
import "../../../../bench-expr/src/style.css";
import { QubleRoot, type THandlers } from "quble-react";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { runTarget } from "../../../../bench-expr/src/harness.ts";
import { handlers } from "../../../../bench-expr/src/quble-handlers.ts";
import { Orders } from "../../dist/bench/orders.tsx";

runTarget({
  id: "quble-react",
  label: "quble -> React",
  mount: (root, data) => {
    flushSync(() =>
      createRoot(root).render(
        createElement(QubleRoot, { component: Orders, initial: data, handlers: handlers as unknown as THandlers }),
      ),
    );
  },
});
