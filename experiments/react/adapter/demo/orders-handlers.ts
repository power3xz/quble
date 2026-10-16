// orders.qubc의 이벤트 핸들러. React 상태를 거치지 않고 quble 스토어를 바로 고친다(bench-expr/src/quble-handlers.ts와 같은 동작).
import type { THandlers } from "../../../../core/web/runtime-entry.ts";
import type { TRow } from "./orders-data.ts";

type TCtx = {
  get: (leafIndex: number) => number;
  set: (leafIndex: number, value: unknown) => void;
  setArray: (array: unknown, elems: unknown[]) => void;
  store: { rows: { qty: number; price: number }[]; rate: number; tax: number; threshold: number; pivot: number };
  $0: number;
};

// 전체 행 일괄 갱신이 번갈아 넘길 두 배열. 데이터를 만들 때 정한다.
export const bulk: { base: TRow[]; bumped: TRow[] } = { base: [], bumped: [] };

export const ordersHandlers = {
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
  BULK_UPDATE: (data: { firstPrice: number }, ctx: TCtx) => {
    ctx.setArray(ctx.store.rows, data.firstPrice === bulk.base[0].price ? bulk.bumped : bulk.base);
  },
} as unknown as THandlers;
