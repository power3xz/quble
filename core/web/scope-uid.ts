// scope(컴포넌트 RENDER 한 번, @for 회차 하나)를 구별하는 scopeUid. vm이 TScopeParentPool로 할당하고 반납한다.
// 칸에 부모 scope의 scopeUid를 두어, 그리기가 끝나 scope 스택이 없어진 뒤에도 부모를 따라 조상 scope를 찾는다.
//
// 자식 scope는 부모 scope를 연 가지 아래 region에서만 생기고, freeBranchTree(region.ts)가 자식 region을 먼저
// 반납한다. 그래서 부모 scopeUid를 반납할 때 그 scopeUid를 부모로 가진 scope는 이미 모두 반납되어 있다.

import type { Pool } from "./pool-allocator.ts";

// 칸 번호가 scopeUid이고 칸 값이 그 scope의 부모 scopeUid인 Pool.
export type TScopeParentPool = Pool<number>;

// 따라 올라갈 부모가 없는 scope(컴포넌트 RENDER)의 칸에 둔다.
export const NO_PARENT_SCOPE_UID = -1;

// scopeUid에서 부모를 steps번 따라 올라간 scope의 scopeUid.
export const ancestorScopeUid = (scopeParentPool: TScopeParentPool, scopeUid: number, steps: number): number => {
  let ancestor = scopeUid;
  for (let step = 0; step < steps; step++) {
    ancestor = scopeParentPool.entries[ancestor];
  }
  return ancestor;
};
