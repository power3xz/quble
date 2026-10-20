// orders-toggle 앱(quble/orders-toggle.qubc)의 이벤트 핸들러. 켜고 끄는 값과 환율만 바꾼다.
type TCtx = {
  set: (leafIndex: number, value: unknown) => void;
  store: { showA: number; showB: number; rate: number };
};

export const handlers = {
  SHOW_A: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.showA, true);
  },
  HIDE_A: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.showA, false);
  },
  SHOW_B: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.showB, true);
  },
  HIDE_B: (_data: unknown, ctx: TCtx) => {
    ctx.set(ctx.store.showB, false);
  },
  RATE: (data: { nextRate: number }, ctx: TCtx) => {
    ctx.set(ctx.store.rate, data.nextRate);
  },
};
