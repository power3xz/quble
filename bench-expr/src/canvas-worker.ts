// canvas 실험 - quble 런타임을 Worker에서 돌려 Orders를 OffscreenCanvas에 그린다. Worker에는 document가
// 없어서 장면 트리(SDocument)를 전역 document 자리에 넣을 수 있다. 런타임은 고치지 않는다.
//
// 메인 스레드(canvas.ts)와 주고받는 메시지
//   받음  init { canvas, n, base, width, height, dpr }, resize { width, height, dpr }, click { x, y },
//         scroll { dy }
//   보냄  mounted { mountMs }, frame { layoutMs, drawMs, sinceClickMs }

import { compile } from "@quble-web/runtime.ts";
import type { TStyle } from "@quble-web/canvas/layout.ts";
import { createRenderer, type TRenderer } from "@quble-web/canvas/render.ts";
import { SDocument, type SElement } from "@quble-web/canvas/scene.ts";
import { handlers } from "./quble-handlers.ts";

const doc = new SDocument();
(globalThis as { document?: unknown }).document = doc;

// style.css의 주문 목록 스타일을 옮긴 것(밝은 테마).
const C = { bg: "#f6f7f9", surface: "#ffffff", line: "#e3e6eb", text: "#1c2026", dim: "#6b7380", warn: "#dc2626" };
const BUTTON: TStyle = { padding: [4, 10, 4, 10], border: C.line, radius: 6, background: C.surface };
const BY_CLASS: Record<string, TStyle> = {
  orders: { display: "block" },
  orders__bar: { display: "row", gap: 8, marginBottom: 8 },
  orders__info: { color: C.dim },
  orders__list: { display: "block", border: C.line, radius: 8, background: C.surface },
  row: { display: "grid", columns: [64, 80, 48, 0, 64, 72, 24, 48], gap: 8, padding: [2, 10, 2, 10], borderBottom: C.line },
  row__id: { color: C.dim },
  row__amount: { align: "right" },
  row__diff: { align: "right" },
  row__inc: { ...BUTTON, padding: [0, 8, 0, 8] },
};
const BODY: TStyle = { display: "block", padding: [12, 16, 48, 16] };
const WARN_SHOWN: TStyle = { color: C.warn, bold: true, align: "center" };
const WARN_HIDDEN: TStyle = { ...WARN_SHOWN, hidden: true };

const styleOf = (el: SElement): TStyle => {
  if (el === doc.body) {
    return BODY;
  }
  const cls = el.getAttribute("class");
  if (cls === "row__warn") {
    return el.getAttribute("data-warn") === "true" ? WARN_SHOWN : WARN_HIDDEN;
  }
  const byClass = cls === null ? undefined : BY_CLASS[cls];
  if (byClass !== undefined) {
    return byClass;
  }
  if (el.localName === "button") {
    return BUTTON;
  }
  return el.localName === "div" ? BY_CLASS.orders : {};
};

let renderer: TRenderer | null = null;
let clickAt = -1;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    const ctx = (msg.canvas as OffscreenCanvas).getContext("2d") as OffscreenCanvasRenderingContext2D;
    renderer = createRenderer(doc, ctx, {
      styleOf,
      fontOf: (bold) => `${bold ? "700 " : ""}14px ui-sans-serif, system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif`,
      lineHeight: 21,
      background: C.bg,
      color: C.text,
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
    doc.body.append(...(inst.nodes as unknown as SElement[]));
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
