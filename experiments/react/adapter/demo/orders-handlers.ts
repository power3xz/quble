// orders.qubc의 이벤트 핸들러. React 상태를 거치지 않고 quble 스토어를 바로 고친다(bench-expr/src/quble-handlers.ts와 같은 동작).
// 루트 prop은 컨텍스트의 update로 갱신한다. 배열 요소의 필드(INC, PIVOT_PRICE)는 루트 prop이 아니라 set으로 고친다.
import type { THandlers } from "../../../../core/web/runtime-entry.ts";
import type { TRow } from "./orders-data.ts";

type TCtx = {
  get: (leafIndex: number) => number;
  set: (leafIndex: number, value: unknown) => void;
  update: (values: Record<string, unknown>) => void;
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
    ctx.update({ rate: data.nextRate });
  },
  THRESHOLD: (data: { nextThreshold: number }, ctx: TCtx) => {
    ctx.update({ threshold: data.nextThreshold });
  },
  PIVOT: (data: { nextPivot: number }, ctx: TCtx) => {
    ctx.update({ pivot: data.nextPivot });
  },
  PIVOT_PRICE: (data: { nextPrice: number }, ctx: TCtx) => {
    ctx.set(ctx.store.rows[ctx.get(ctx.store.pivot)].price, data.nextPrice);
  },
  RATE_AND_TAX: (data: { nextRate: number; nextTax: number }, ctx: TCtx) => {
    ctx.update({ rate: data.nextRate, tax: data.nextTax });
  },
  RATE_BURST: (data: { first: number; second: number; third: number }, ctx: TCtx) => {
    ctx.update({ rate: data.first });
    ctx.update({ rate: data.second });
    ctx.update({ rate: data.third });
  },
  BULK_UPDATE: (data: { firstPrice: number }, ctx: TCtx) => {
    ctx.update({ rows: data.firstPrice === bulk.base[0].price ? bulk.bumped : bulk.base });
  },
} as unknown as THandlers;
