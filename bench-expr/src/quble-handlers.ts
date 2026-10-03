// quble 대상의 이벤트 핸들러. DOM 페이지(quble.ts)와 canvas 실험(canvas-worker.ts)이 함께 쓴다.
import { nextPivot, nextRate, nextThreshold } from "./harness.ts";

type TCtx = {
  get: (leafIndex: number) => number;
  set: (leafIndex: number, value: unknown) => void;
  store: { rows: { qty: number; price: number }[]; rate: number; threshold: number; pivot: number };
  $0: number;
};

export const handlers = {
  "[$0].INC": (_data: unknown, ctx: TCtx) => {
    const qty = ctx.store.rows[ctx.$0].qty;
    ctx.set(qty, ctx.get(qty) + 1);
  },
  RATE: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.rate, nextRate(ctx.get(ctx.store.rate)));
  },
  THRESHOLD: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.threshold, nextThreshold(ctx.get(ctx.store.threshold)));
  },
  PIVOT: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.pivot, nextPivot(ctx.get(ctx.store.pivot), ctx.store.rows.length));
  },
  PIVOT_PRICE: (_data: unknown, ctx: TCtx) => {
    const price = ctx.store.rows[ctx.get(ctx.store.pivot)].price;
    ctx.set(price, ctx.get(price) + 1);
  },
};
