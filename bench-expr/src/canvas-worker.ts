// canvas 실험 - quble 런타임을 Worker에서 돌려 Orders를 OffscreenCanvas에 그린다. Worker에는 document가
// 없어서 장면 트리(SDocument)를 전역 document 자리에 넣을 수 있다. 런타임은 고치지 않는다.
//
// 스타일은 DOM 페이지와 같은 style.css를 받아 해석한다(core/web/canvas/css.ts). 마크업도 DOM 페이지처럼
// body > main#app 안에 둔다.
//
// 메인 스레드(canvas.ts)와 주고받는 메시지
//   받음  init { canvas, n, base, css, dark, width, height, dpr }, resize { width, height, dpr },
//         click { x, y }, scroll { dy }
//   보냄  mounted { mountMs }, frame { layoutMs, drawMs, sinceClickMs }

import { compile } from "@quble-web/runtime.ts";
import { createStyleOf, parseCss } from "@quble-web/canvas/css.ts";
import { createRenderer, type TRenderer } from "@quble-web/canvas/render.ts";
import { SDocument, type SElement } from "@quble-web/canvas/scene.ts";
import { handlers } from "./quble-handlers.ts";

const doc = new SDocument();
(globalThis as { document?: unknown }).document = doc;

let renderer: TRenderer | null = null;
let clickAt = -1;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    const styleOf = createStyleOf(parseCss(msg.css, msg.dark));
    const app = doc.createElement("main");
    app.setAttribute("id", "app");
    doc.body.append(app);
    const bodyStyle = styleOf(doc.body);
    const ctx = (msg.canvas as OffscreenCanvas).getContext("2d") as OffscreenCanvasRenderingContext2D;
    renderer = createRenderer(doc, ctx, {
      styleOf,
      // style.css의 body font(14px/1.5)
      fontOf: (bold) => `${bold ? "700 " : ""}14px ui-sans-serif, system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`,
      lineHeight: 21,
      background: bodyStyle.background ?? "#ffffff",
      color: bodyStyle.color ?? "#000000",
      onFrame: (layoutMs, drawMs) => {
        const sinceClickMs = clickAt < 0 ? -1 : performance.now() - clickAt;
        clickAt = -1;
        self.postMessage({ type: "frame", layoutMs, drawMs, sinceClickMs });
      },
    });
    renderer.resize(msg.width, msg.height, msg.dpr);
    const [qubb, data] = await Promise.all([
      fetch(new URL("./orders.qubb", msg.base)).then((r) => r.arrayBuffer()),
      fetch(new URL(`./data-${msg.n}.json`, msg.base)).then((r) => r.json()),
    ]);
    const t0 = performance.now();
    const inst = compile(new Uint8Array(qubb))(0)(data, handlers as never);
    app.append(...(inst.nodes as unknown as SElement[]));
    self.postMessage({ type: "mounted", mountMs: performance.now() - t0 });
  } else if (msg.type === "resize") {
    renderer?.resize(msg.width, msg.height, msg.dpr);
  } else if (msg.type === "click") {
    clickAt = performance.now();
    renderer?.click(msg.x, msg.y);
  } else if (msg.type === "scroll") {
    renderer?.scrollBy(msg.dy);
  }
};
