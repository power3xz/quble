import { compile } from "../../../core/web/runtime.ts";
import qubb from "../dist/app.qubb";

type TRow = { id: number; label: string; cls: string };
type TRowNode = { id: number; label: number; cls: number };
type TRowsNode = { [i: number]: TRowNode; length: number };

type TCtx = {
  get: (leafIndex: number) => unknown;
  set: (leafIndex: number, value: unknown) => void;
  setArray: (array: TRowsNode, elems: TRow[]) => void;
  push: (array: TRowsNode, elem: TRow) => void;
  removeAt: (array: TRowsNode, i: number) => void;
  swapAt: (array: TRowsNode, i: number, j: number) => void;
  store: { rows: TRowsNode };
  $0: number;
};

const adjectives = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy",
];
const colours = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"];
const nouns = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard",
];

let nextId = 1;
// 선택된 행의 cls leafIndex. removeAt은 남은 요소의 leaf를 옮기지 않아 다른 행이 지워져도 그대로 맞다.
let selectedClsLeaf: number | undefined;

const random = (max: number): number => Math.round(Math.random() * 1000) % max;

const buildRows = (count: number): TRow[] => {
  const rows = new Array<TRow>(count);
  for (let i = 0; i < count; i++) {
    const label = `${adjectives[random(adjectives.length)]} ${colours[random(colours.length)]} ${nouns[random(nouns.length)]}`;
    rows[i] = { id: nextId++, label, cls: "" };
  }
  return rows;
};

const replaceRows = (ctx: TCtx, count: number): void => {
  selectedClsLeaf = undefined;
  ctx.setArray(ctx.store.rows, buildRows(count));
};

const handlers = {
  RUN: (_data: unknown, ctx: TCtx) => {
    replaceRows(ctx, 1000);
  },
  RUNLOTS: (_data: unknown, ctx: TCtx) => {
    replaceRows(ctx, 10000);
  },
  ADD: (_data: unknown, ctx: TCtx) => {
    for (const row of buildRows(1000)) {
      ctx.push(ctx.store.rows, row);
    }
  },
  UPDATE: (_data: unknown, ctx: TCtx) => {
    const rows = ctx.store.rows;
    const length = rows.length;
    for (let i = 0; i < length; i += 10) {
      const label = rows[i].label;
      ctx.set(label, `${ctx.get(label)} !!!`);
    }
  },
  CLEAR: (_data: unknown, ctx: TCtx) => {
    selectedClsLeaf = undefined;
    ctx.setArray(ctx.store.rows, []);
  },
  SWAP: (_data: unknown, ctx: TCtx) => {
    if (ctx.store.rows.length <= 998) {
      return;
    }
    const first = ctx.store.rows[1].cls;
    const second = ctx.store.rows[998].cls;
    ctx.swapAt(ctx.store.rows, 1, 998);
    // swapAt은 leaf 자리는 두고 값을 맞바꾸므로 "danger"가 반대편 leaf로 간다.
    if (selectedClsLeaf === first) {
      selectedClsLeaf = second;
    } else if (selectedClsLeaf === second) {
      selectedClsLeaf = first;
    }
  },
  "[$0].SELECT": (_data: unknown, ctx: TCtx) => {
    if (selectedClsLeaf !== undefined) {
      ctx.set(selectedClsLeaf, "");
    }
    selectedClsLeaf = ctx.store.rows[ctx.$0].cls;
    ctx.set(selectedClsLeaf, "danger");
  },
  "[$0].REMOVE": (_data: unknown, ctx: TCtx) => {
    // 지운 행의 leaf는 회수돼 다음 push가 다시 쓸 수 있다 - 선택을 먼저 끊는다.
    if (selectedClsLeaf === ctx.store.rows[ctx.$0].cls) {
      selectedClsLeaf = undefined;
    }
    ctx.removeAt(ctx.store.rows, ctx.$0);
  },
};

const inst = compile(qubb)(0)({ rows: [] }, handlers as never);
document.getElementById("main")?.replaceChildren(...inst.nodes);
