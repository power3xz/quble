// quble 대상의 이벤트 핸들러. quble 페이지(quble.ts)가 쓰고, 같은 앱을 다른 방식으로 그리는 실험
// (experiments/)도 가져다 쓴다.

type TCtx = {
  get: (leafIndex: number) => number;
  set: (leafIndex: number, value: unknown) => void;
  store: { rows: { qty: number; price: number }[]; rate: number; tax: number; threshold: number; pivot: number };
  $0: number;
};

export const handlers = {
  "[$0].INC": (_data: unknown, ctx: TCtx) => {
    const qty = ctx.store.rows[ctx.$0].qty;
    ctx.set(qty, ctx.get(qty) + 1);
  },
  RATE: (data: { nextRate: number }, ctx: TCtx) => {
    ctx.set(ctx.store.rate, data.nextRate);
  },
  THRESHOLD: (data: { nextThreshold: number }, ctx: TCtx) => {
    ctx.set(ctx.store.threshold, data.nextThreshold);
  },
  PIVOT: (data: { nextPivot: number }, ctx: TCtx) => {
    ctx.set(ctx.store.pivot, data.nextPivot);
  },
  PIVOT_PRICE: (data: { nextPrice: number }, ctx: TCtx) => {
    ctx.set(ctx.store.rows[ctx.get(ctx.store.pivot)].price, data.nextPrice);
  },
  RATE_AND_TAX: (data: { nextRate: number; nextTax: number }, ctx: TCtx) => {
    ctx.set(ctx.store.rate, data.nextRate);
    ctx.set(ctx.store.tax, data.nextTax);
  },
  RATE_BURST: (data: { first: number; second: number; third: number }, ctx: TCtx) => {
    ctx.set(ctx.store.rate, data.first);
    ctx.set(ctx.store.rate, data.second);
    ctx.set(ctx.store.rate, data.third);
  },
};
