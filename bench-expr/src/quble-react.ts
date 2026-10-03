// orders.qubc를 quble-react로 컴파일한 React 컴포넌트(gen/orders.tsx, bench-expr.sh가 만든다).
// 핸들러는 quble 대상과 같은 표를 쓴다.
import { QubleRoot, type THandlers } from "quble-react";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Orders } from "../gen/orders.tsx";
import { runTarget } from "./harness.ts";
import { handlers } from "./quble-handlers.ts";

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
