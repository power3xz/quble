import { compile } from "@quble-web/runtime.ts";
import { runTarget, type TData } from "./harness.ts";
import { handlers } from "./quble-handlers.ts";

runTarget({
  id: "quble",
  label: "quble",
  prepare: () => fetch("./orders.qubb").then((r) => r.arrayBuffer()),
  mount: (root, data: TData, qubb: ArrayBuffer) => {
    const inst = compile(new Uint8Array(qubb))(0)(data, handlers as never);
    root.replaceChildren(...inst.nodes);
  },
});
