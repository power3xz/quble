// canvas 실험의 레이아웃. 장면 트리(scene.ts)의 노드마다 상자(TBox)를 계산해 node.layout에 붙인다.
// CSS를 쓰지 않고, 요소마다 styleOf가 돌려주는 스타일(TStyle)만 본다. 글자 폭은 measure로 받아 canvas를
// 모른다.
//
// 배치 방식(display)은 넷이다.
//   block   자식을 세로로 쌓는다. 너비는 받은 너비를 다 쓴다.
//   inline  자식을 가로로 잇는다. 너비는 내용만큼이다.
//   row     자식을 가로로 잇고 gap을 둔다. 넘치면 다음 줄로 넘긴다(flex-wrap).
//   grid    자식을 columns의 고정 폭 칸에 하나씩 놓는다. 폭 0인 칸은 남은 폭을 나눠 가진다(1fr).
// 줄바꿈 없는 한 줄 텍스트만 다룬다.
//
// 바뀐 곳만 다시 계산한다. markDirty가 바뀐 노드와 그 조상을 표시하고, layout은 표시가 없고 받은 너비가
// 같은 상자를 그대로 쓴다. 1만 행 목록에서 한 행이 바뀌면 그 행과 조상만 다시 재고, 목록은 행 상자들의
// 위치만 다시 쌓는다.

import { COMMENT_NODE, ELEMENT_NODE, type SElement, type SNode, type SText, TEXT_NODE } from "./scene.ts";

export type TStyle = {
  display?: "block" | "inline" | "row" | "grid";
  columns?: number[];
  gap?: number;
  // 위, 오른쪽, 아래, 왼쪽
  padding?: [number, number, number, number];
  marginBottom?: number;
  // 테두리 색. 두께는 1px이다.
  border?: string;
  borderBottom?: string;
  radius?: number;
  background?: string;
  color?: string;
  bold?: boolean;
  // 받은 너비가 내용보다 넓을 때 내용을 어디에 둘지
  align?: "left" | "right" | "center";
  // 자리는 차지하되 그리지 않는다(visibility: hidden)
  hidden?: boolean;
};

// 노드 하나의 상자. x, y는 부모 상자의 왼쪽 위 기준이다.
export type TBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  dirty: boolean;
  // 이 상자를 계산할 때 받은 너비. 같으면 다시 계산하지 않는다(-1은 내용만큼).
  availW: number;
  style: TStyle | null;
};

export type TLayoutEnv = {
  styleOf: (el: SElement) => TStyle;
  // 글자 폭(px). 굵기에 따라 다르다.
  measure: (text: string, bold: boolean) => number;
  lineHeight: number;
};

const NO_PADDING: [number, number, number, number] = [0, 0, 0, 0];

// node와 조상의 상자에 다시 계산하라고 표시한다. 이미 표시된 노드에서 멈춘다 - 표시된 노드의 조상은
// 늘 표시돼 있다.
export const markDirty = (node: SNode): void => {
  for (let n: SNode | null = node; n !== null; n = n.parentNode) {
    const box = n.layout as TBox | null;
    if (box === null) {
      continue;
    }
    if (box.dirty) {
      return;
    }
    box.dirty = true;
  }
};

const boxOf = (node: SNode): TBox => {
  let box = node.layout as TBox | null;
  if (box === null) {
    box = { x: 0, y: 0, w: 0, h: 0, dirty: true, availW: Number.NaN, style: null };
    node.layout = box;
  }
  return box;
};

// node의 상자를 계산해 돌려준다. availW는 줄 수 있는 너비이고 -1이면 내용만큼이다. bold는 조상에게서
// 물려받은 굵기다.
export const layout = (env: TLayoutEnv, node: SNode, availW: number, bold: boolean): TBox => {
  const box = boxOf(node);
  if (!box.dirty && box.availW === availW) {
    return box;
  }
  box.availW = availW;
  box.dirty = false;
  if (node.nodeType === TEXT_NODE) {
    const data = (node as SText).data;
    box.w = data === "" ? 0 : env.measure(data, bold);
    box.h = data === "" ? 0 : env.lineHeight;
    return box;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    // 주석(region anchor)은 자리를 차지하지 않는다.
    box.w = 0;
    box.h = 0;
    return box;
  }
  const el = node as SElement;
  const style = env.styleOf(el);
  box.style = style;
  const childBold = style.bold ?? bold;
  const [pt, pr, pb, pl] = style.padding ?? NO_PADDING;
  const bw = style.border === undefined ? 0 : 1;
  const bbw = style.borderBottom === undefined ? 0 : 1;
  const left = pl + bw;
  const top = pt + bw;
  const display = style.display ?? "inline";
  const innerAvail = availW < 0 ? -1 : Math.max(0, availW - pl - pr - 2 * bw);
  let contentW = 0;
  let contentH = 0;

  if (display === "block") {
    let y = 0;
    for (let c = el.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType === COMMENT_NODE) {
        continue;
      }
      const cb = layout(env, c, innerAvail, childBold);
      cb.x = left;
      cb.y = top + y;
      y += cb.h + (cb.style?.marginBottom ?? 0);
      contentW = Math.max(contentW, cb.w);
    }
    contentH = y;
  } else if (display === "grid") {
    const cols = style.columns ?? [];
    const gap = style.gap ?? 0;
    const fixed = cols.reduce((s, c) => s + c, 0) + gap * Math.max(0, cols.length - 1);
    const fills = cols.filter((c) => c === 0).length;
    const fillW = fills === 0 ? 0 : Math.max(0, (innerAvail < 0 ? 0 : innerAvail) - fixed) / fills;
    let x = 0;
    let i = 0;
    for (let c = el.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType !== ELEMENT_NODE) {
        continue;
      }
      const colW = cols[i] === 0 ? fillW : (cols[i] ?? 0);
      const cb = layout(env, c, colW, childBold);
      cb.x = left + x;
      contentH = Math.max(contentH, cb.h);
      x += colW + gap;
      i++;
    }
    contentW = Math.max(0, x - gap);
    // 칸 안에서 세로 가운데(align-items: center)
    for (let c = el.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType === ELEMENT_NODE) {
        const cb = c.layout as TBox;
        cb.y = top + (contentH - cb.h) / 2;
      }
    }
  } else {
    // inline과 row - 가로로 잇는다. row는 gap을 두고 넘치면 줄을 넘긴다.
    const gap = display === "row" ? (style.gap ?? 0) : 0;
    const wrap = display === "row" && innerAvail >= 0;
    let x = 0;
    let y = 0;
    let lineH = 0;
    let lineStart = el.firstChild;
    const finishLine = (end: SNode | null) => {
      // 줄 안에서 세로 가운데
      for (let c = lineStart; c !== end; c = (c as SNode).nextSibling) {
        const cb = (c as SNode).layout as TBox;
        cb.y = top + y + (lineH - cb.h) / 2;
      }
    };
    for (let c = el.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType === COMMENT_NODE) {
        boxOf(c);
        continue;
      }
      const cb = layout(env, c, -1, childBold);
      if (wrap && x > 0 && x + cb.w > innerAvail) {
        finishLine(c);
        contentW = Math.max(contentW, x - gap);
        y += lineH + gap;
        x = 0;
        lineH = 0;
        lineStart = c;
      }
      cb.x = left + x;
      x += cb.w + gap;
      lineH = Math.max(lineH, cb.h);
    }
    finishLine(null);
    contentW = Math.max(contentW, x - gap);
    contentH = y + lineH;
  }

  const naturalW = contentW + pl + pr + 2 * bw;
  box.w = availW < 0 ? naturalW : availW;
  box.h = contentH + pt + pb + 2 * bw + bbw;
  // 받은 너비가 내용보다 넓으면 정렬대로 내용을 민다(block은 받은 너비를 다 쓰므로 뺀다).
  const shift =
    display === "block"
      ? 0
      : style.align === "right"
        ? box.w - naturalW
        : style.align === "center"
          ? (box.w - naturalW) / 2
          : 0;
  if (shift > 0) {
    for (let c = el.firstChild; c !== null; c = c.nextSibling) {
      (boxOf(c) as TBox).x += shift;
    }
  }
  return box;
};

// (px, py)에 있는 가장 깊은 요소. ox, oy는 node 부모의 원점이다. 없으면 null.
export const hitTest = (node: SNode, px: number, py: number, ox: number, oy: number): SElement | null => {
  const box = node.layout as TBox | null;
  if (box === null || node.nodeType !== ELEMENT_NODE) {
    return null;
  }
  const x = ox + box.x;
  const y = oy + box.y;
  if (px < x || px >= x + box.w || py < y || py >= y + box.h) {
    return null;
  }
  for (let c = node.lastChild; c !== null; c = c.previousSibling) {
    const hit = hitTest(c, px, py, x, y);
    if (hit !== null) {
      return hit;
    }
  }
  return node as SElement;
};
