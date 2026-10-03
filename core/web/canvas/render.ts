// canvas 실험의 렌더러. 장면 트리가 바뀌면 다음 프레임에 한 번 레이아웃(layout.ts)하고 그린다. 화면에
// 보이는 상자만 그리고, 스크롤과 클릭(hit test 뒤 document.dispatch)을 받는다.
//
// 2D 컨텍스트만 받으므로 일반 canvas와 Worker의 OffscreenCanvas 어느 쪽에서도 돈다.

import { hitTest, layout, markDirty, placeLazyText, type TBox, type TStyle } from "./layout.ts";
import { ELEMENT_NODE, type SDocument, type SElement, type SNode, type SText, TEXT_NODE } from "./scene.ts";

type TContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type TRenderOptions = {
  styleOf: (el: SElement) => TStyle;
  // 굵기를 받아 canvas font 문자열을 돌려준다.
  fontOf: (bold: boolean) => string;
  lineHeight: number;
  // body 바탕색과 글자 기본색
  background: string;
  color: string;
  // 프레임을 그린 뒤 불린다. 레이아웃과 그리기에 든 시간(ms)을 받는다.
  onFrame?: (layoutMs: number, drawMs: number) => void;
};

export type TRenderer = {
  resize: (width: number, height: number, dpr: number) => void;
  scrollBy: (dy: number) => void;
  // 화면 좌표(CSS px)의 요소에 click을 보낸다.
  click: (x: number, y: number) => void;
};

export const createRenderer = (doc: SDocument, ctx: TContext2D, opts: TRenderOptions): TRenderer => {
  let width = 0;
  let height = 0;
  let dpr = 1;
  let scrollY = 0;
  let scheduled = false;
  // 굵기별 글자 폭. 같은 문자열은 한 번만 잰다.
  const widths = [new Map<string, number>(), new Map<string, number>()];
  const measure = (text: string, bold: boolean): number => {
    const cache = widths[bold ? 1 : 0];
    let w = cache.get(text);
    if (w === undefined) {
      ctx.font = opts.fontOf(bold);
      w = ctx.measureText(text).width;
      cache.set(text, w);
    }
    return w;
  };
  const env = { styleOf: opts.styleOf, measure, lineHeight: opts.lineHeight };
  const now = () => performance.now();
  const raf: (fn: () => void) => void =
    typeof requestAnimationFrame === "function" ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);

  const drawNode = (node: SNode, ox: number, oy: number, color: string, bold: boolean) => {
    const box = node.layout as TBox | null;
    if (box === null) {
      return;
    }
    const x = ox + box.x;
    const y = oy + box.y;
    if (y > scrollY + height || y + box.h < scrollY) {
      return;
    }
    if (node.nodeType === TEXT_NODE) {
      const data = (node as SText).data;
      if (data !== "") {
        ctx.font = opts.fontOf(bold);
        ctx.fillStyle = color;
        ctx.fillText(data, x, y + box.h / 2);
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) {
      return;
    }
    const style = box.style as TStyle;
    if (style.hidden) {
      return;
    }
    if (style.background !== undefined || style.border !== undefined) {
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, box.w - 1, box.h - 1, style.radius ?? 0);
      if (style.background !== undefined) {
        ctx.fillStyle = style.background;
        ctx.fill();
      }
      if (style.border !== undefined) {
        ctx.strokeStyle = style.border;
        ctx.stroke();
      }
    }
    if (style.borderBottom !== undefined) {
      ctx.fillStyle = style.borderBottom;
      ctx.fillRect(x, y + box.h - 1, box.w, 1);
    }
    const childColor = style.color ?? color;
    const childBold = style.bold ?? bold;
    if (box.lazyText) {
      placeLazyText(env, node as SElement, bold);
    }
    for (let c = node.firstChild; c !== null; c = c.nextSibling) {
      drawNode(c, x, y, childColor, childBold);
    }
  };

  const frame = () => {
    scheduled = false;
    const t0 = now();
    const root = layout(env, doc.body, width, false);
    const t1 = now();
    scrollY = Math.max(0, Math.min(scrollY, root.h - height));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = "middle";
    ctx.translate(0, -scrollY);
    drawNode(doc.body, 0, 0, opts.color, false);
    opts.onFrame?.(t1 - t0, now() - t1);
  };

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      raf(frame);
    }
  };

  doc.onChange = (node) => {
    markDirty(node);
    schedule();
  };

  return {
    resize: (w, h, d) => {
      width = w;
      height = h;
      dpr = d;
      ctx.canvas.width = Math.round(w * d);
      ctx.canvas.height = Math.round(h * d);
      markDirty(doc.body);
      schedule();
    },
    scrollBy: (dy) => {
      scrollY += dy;
      schedule();
    },
    click: (x, y) => {
      const target = hitTest(doc.body, x, y + scrollY, 0, 0);
      if (target !== null) {
        doc.dispatch("click", target);
      }
    },
  };
};
