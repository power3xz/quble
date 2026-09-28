import { compile } from "@quble-web/runtime.ts";
import { nextRate, nextThreshold, runTarget, type TData } from "./harness.ts";

type TCtx = {
  get: (leafIndex: number) => number;
  set: (leafIndex: number, value: unknown) => void;
  store: { rows: { qty: number }[]; rate: number; threshold: number };
  $0: number;
};

const handlers = {
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
};

runTarget({
  id: "quble",
  label: "quble",
  prepare: () => fetch("./orders.qubb").then((r) => r.arrayBuffer()),
  mount: (root, data: TData, qubb: ArrayBuffer) => {
    const inst = compile(new Uint8Array(qubb))(0)(data, handlers as never);
    root.replaceChildren(...inst.nodes);
  },
});
