import { compile } from "@quble-web/runtime.ts";
import { runTarget, type TData } from "./harness.ts";
import { handlers } from "./quble-handlers.ts";

// 행마다 props만 읽는 식 열 개(rate * 2, rate + tax 등)가 든 행(quble/orders-shared.qubc). 같은
// 식을 행들이 인스턴스 하나로 공유하는 비용과 이득을 재려고 quble 페이지와 따로 둔다 - 다른 대상에는 이 동작이
// 없어 견줄 대상이 없다.
runTarget({
  id: "quble-shared",
  label: "quble (shared)",
  prepare: () => fetch("./orders-shared.qubb").then((r) => r.arrayBuffer()),
  mount: (root, data: TData, qubb: ArrayBuffer) => {
    const inst = compile(new Uint8Array(qubb))(0)(data, handlers as never);
    root.replaceChildren(...inst.nodes);
  },
});
