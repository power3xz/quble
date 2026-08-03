import type { Handlers } from "./forstress.qubc.d.ts";

export const handlers: Handlers = {
  "Row[$0].Col[$1].Card[$2].PICK": (data, { $0, $1, $2 }) => {
    console.log("card clicked", { $0, $1, $2 });
  },
  ADD: (data, { get, set, props }) => {
    // 최상위 @for count(rows)를 +1 -> Depth2 서브트리(50x100=5,000 카드) 한 행 추가.
    // rows는 payload(n)로 실어 props.n(leafIndex)로 온다 - 런타임 props가 payload 기반이라
    // 컴포넌트 prop을 직접 못 가리키는 미결 이슈(ISSUES.md)의 우회다.
    const t0 = performance.now();
    set(props.n, get(props.n) + 1);
    requestAnimationFrame(() => {
      const inst = (window as any).__quble.inst;
      const live = inst.branchPool.filter((b: any) => b !== null).length; // null=제거된 회차 칸
      console.log(`[quble] 행 추가(+5,000) ${(performance.now() - t0).toFixed(1)}ms, regions=${inst.regionPool.length}, branches=${live}/${inst.branchPool.length}`);
    });
  },
  REMOVE: (data, { get, set, props }) => {
    // 최상위 @for count(rows)를 -1 -> 꼬리 회차(5,000 카드) 제거. 0 하한.
    const cur = get(props.n);
    if (cur <= 0) {
      return;
    }
    const t0 = performance.now();
    set(props.n, cur - 1);
    requestAnimationFrame(() => {
      const inst = (window as any).__quble.inst;
      const live = inst.branchPool.filter((b: any) => b !== null).length; // null=제거된 회차 칸
      console.log(`[quble] 행 제거(-5,000) ${(performance.now() - t0).toFixed(1)}ms, regions=${inst.regionPool.length}, branches=${live}/${inst.branchPool.length}`);
    });
  },
};
