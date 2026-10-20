import { compile } from "@quble-web/runtime.ts";
import { runTarget, type TToggleData } from "./harness.ts";
import { handlers } from "./quble-toggle-handlers.ts";

// 켰다 끄는 두 목록(quble/orders-toggle.qubc). 꺼졌다 다시 켜질 때 가지가 놓친 값을 따라잡는 비용을 재려고
// quble 페이지와 따로 둔다 - 다른 대상에는 이 동작이 없어 견줄 대상이 없다.
runTarget<ArrayBuffer, TToggleData>({
  id: "quble-toggle",
  label: "quble (toggle)",
  dataUrl: "./data-toggle.json",
  prepare: () => fetch("./orders-toggle.qubb").then((r) => r.arrayBuffer()),
  mount: (root, data, qubb) => {
    const inst = compile(new Uint8Array(qubb))(0)(data, handlers as never);
    root.replaceChildren(...inst.nodes);
  },
});
