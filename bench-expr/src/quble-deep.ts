import { compile } from "@quble-web/runtime.ts";
import { runTarget, type TData } from "./harness.ts";
import { handlers } from "./quble-handlers.ts";

// 값 자리 사이에 정적 하위 트리, 깊은 값 자리, 정적 형제 줄이 낀 행(quble/orders-deep.qubc). 값 자리를 찾는
// 방식(템플릿 복제의 경로 캐시)을 견주려고 quble 페이지와 따로 둔다 - 결과도 따로 쌓인다.
runTarget({
  id: "quble-deep",
  label: "quble (deep)",
  prepare: () => fetch("./orders-deep.qubb").then((r) => r.arrayBuffer()),
  mount: (root, data: TData, qubb: ArrayBuffer) => {
    const inst = compile(new Uint8Array(qubb))(0)(data, handlers as never);
    root.replaceChildren(...inst.nodes);
  },
});
