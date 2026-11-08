// 식 바이트만으로 식 인스턴스 풀을 만든다(컴파일러 없이). 식은 모두 입력이 없는 계산 식이고 level 0이라 정적
// 그래프에 간선이 없다.

import { ExprEvaluator } from "../expr-eval.ts";
import { ExprInstancePool } from "../expr-layer.ts";
import type { LeafStoreSubject } from "../leaf-store.ts";
import { Pool } from "../pool-allocator.ts";

export const exprPoolOf = (store: LeafStoreSubject, exprBytes: Uint8Array[]): ExprInstancePool =>
  new ExprInstancePool(
    new ExprEvaluator([], exprBytes, store, new Pool()),
    store,
    exprBytes.map(() => ({ kind: "calc", inputs: [] })),
    exprBytes.map(() => 0),
    new Pool<number>(),
  );
