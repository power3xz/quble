// 인덱스 접근 데모의 핸들러 - cursor를 옮기고, cursor가 가리키는 행을 고친다.

// 헬퍼가 받는 ctx의 타입. ts-plugin이 `handlers`에 짝 .qubc의 타입을 붙이므로 거기서 역산한다
// (core/playground/playground.qubc.handlers.ts와 같은 방식).
type TCtx = Parameters<NonNullable<(typeof handlers)[keyof typeof handlers]>>[1];

const move = (ctx: TCtx, step: number) => {
  const n = ctx.store.rows.length;
  const cursor = ctx.get(ctx.store.cursor);
  ctx.set(ctx.store.cursor, (cursor + step + n) % n);
};

export const handlers = {
  PREV: (_data, ctx) => move(ctx, -1),
  NEXT: (_data, ctx) => move(ctx, 1),
  EDIT_TITLE: (_data, ctx) => {
    const title = ctx.store.rows[ctx.get(ctx.store.cursor)].title;
    ctx.set(title, `${ctx.get(title)}!`);
  },
  ADD_SCORE: (_data, ctx) => {
    const score = ctx.store.rows[ctx.get(ctx.store.cursor)].score;
    ctx.set(score, ctx.get(score) + 1);
  },
  TOGGLE: (_data, ctx) => {
    ctx.set(ctx.store.show, !ctx.get(ctx.store.show));
  },
  // cursor는 그대로 두고 앞 행을 뺀다 - 같은 cursor가 당겨진 행을 읽는다. 지운 뒤 cursor가 범위를
  // 벗어나지 않도록 먼저 줄인다.
  REMOVE_FIRST: (_data, ctx) => {
    const n = ctx.store.rows.length;
    if (n === 1) {
      return;
    }
    if (ctx.get(ctx.store.cursor) === n - 1) {
      ctx.set(ctx.store.cursor, n - 2);
    }
    ctx.removeAt(ctx.store.rows, 0);
    ctx.removeAt(ctx.store.labels, 0);
  },
};
