// 표현식 층 - 식 인스턴스(식 하나가 한 스코프에서 읽는 leaf들과 결과)를 풀에 두고, 구독 층(leaf-store.ts)에 입력
// leaf마다 파생 구독을 건다. 가지는 인스턴스 번호만 들고 붙고 떼고 반납할 때 이 층을 부른다(region.ts).
//
// 파생 구독 함수는 식 인스턴스마다 하나다. `(a + b) * (c - d)`면 a~d 네 leaf에 같은 함수를 건다. leaf마다
// 함수를 만들면 1만 행 목록에서 함수가 수만 개 늘어, 메모리가 CPU 캐시를 넘쳐 다시 세기가 오히려 느려진다.
// 함수는 바뀐 leaf를 받아 식을 다시 세어 값을 돌려주고 store에 쓰지 않는다 - 돌려준 값을 결과 leaf에 write하는
// 것은 구독 층이다(결과 leaf는 bindResultLeaf로 연결한다).

import { type ExprEvaluator, SKIP_NOTHING } from "./expr-eval.ts";
import { instrSize } from "./expr-opcode.ts";
import { buildSkipPastOpsOfVars, type TExprSkipTable } from "./expr-skip-table.ts";
import type { LeafStoreSubject, TDeriveSubscriber } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import type { TScope } from "./scope.ts";

export type TExprInstance = {
  expr: Uint8Array;
  pairs: TScope;
  // 건너뛸 부분식이 있는 식만 갖는다. 없는 식은 table과 cache가 null이다.
  table: TExprSkipTable | null;
  cache: unknown[] | null;
  // 식이 읽은 leaf이자 구독할 입력 leaf. 건너뛸 부분식이 있는 식은 변수마다 읽는 leafIndex(중복과 -1 포함)고, 없는
  // 식은 중복 없는 목록이다. evaluate가 채우고, READ_LEAF 구독을 다시 걸 때 고친다.
  readLeaves: number[];
  // 직전에 돌려준 값. 바뀐 입력이 이 식의 변수가 아니면(다시 걸며 이미 뺀 leaf) 이것을 그대로 돌려준다.
  lastValue: unknown;
  // 구독 층에 거는 함수.
  derive: TDeriveSubscriber;
  // 이 식 인스턴스를 든 가지 수와, 그중 붙어 있는 가지 수.
  refCount: number;
  attachedCount: number;
  // 공유 맵에 올린 키(식 표 번호와 스코프 인스턴스 번호). 공유하지 않는 인스턴스는 둘 다 NOT_SHARED다.
  sharedExprIndex: number;
  sharedScopeUid: number;
};

// 공유 맵에 없다는 뜻. 식 인스턴스 번호를 돌려주는 findShared와 인스턴스의 공유 키 자리에 쓴다.
export const NOT_SHARED = -1;

// derive를 인스턴스 객체에 담기 전에 쓰는 자리 표시 함수. 인스턴스를 가리키는 함수는 인스턴스가 있어야 지을 수 있다.
const noopDerive: TDeriveSubscriber = () => undefined;

export class ExprInstancePool {
  pool: Pool<TExprInstance> = new Pool();
  evaluator: ExprEvaluator;
  store: LeafStoreSubject;
  // 공유 중인 식 인스턴스. shared[exprIndex].get(scopeUid)가 식 인스턴스 번호다.
  private shared: Array<Map<number, number>> = [];

  constructor(evaluator: ExprEvaluator, store: LeafStoreSubject) {
    this.evaluator = evaluator;
    this.store = store;
  }

  // 식 인스턴스를 짓는다. refCount는 1이고 식은 아직 세지 않았으며 구독도 걸지 않는다 - evaluate가 세고, 가지가
  // 붙을 때 attach가 건다.
  //
  // 건너뛸 부분식이 있는 식과 없는 식을 나눈다. 없는 식은 cache도 건너뛰기 표도 두지 않고 leaf가 바뀌면 처음부터
  // 센다. 같은 flush에서 읽는 leaf 여럿이 바뀌어도 구독 층이 함수당 한 번만 부르므로 한 번이면 된다.
  create = (expr: Uint8Array, pairs: TScope): number => {
    const { evaluator } = this;
    const table = evaluator.skipTable(expr);
    const instance: TExprInstance = {
      expr,
      pairs,
      table,
      cache: table === null ? null : new Array(table.opCount),
      readLeaves: [],
      lastValue: undefined,
      derive: noopDerive,
      refCount: 1,
      attachedCount: 0,
      sharedExprIndex: NOT_SHARED,
      sharedScopeUid: NOT_SHARED,
    };
    // `${big > 50}`에서 big이 100 -> 200이면 true 그대로라 결과 leaf의 값이 같아 구독 층이 쓰지 않는다.
    instance.derive =
      table === null
        ? () => evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, null)
        : (changedLeaves) => this.runPartial(instance, changedLeaves);
    return this.pool.alloc(instance);
  };

  // 식을 처음부터 세어 값을 돌려주고, 읽은 leaf(readLeaves)와 값(lastValue)을 인스턴스에 기록한다. 몇 번을 불러도
  // 같은 결과다. 구독을 건 채로 부르지 않는다 - 구독 대상(readLeaves)이 바뀌는데 구독은 그대로다.
  evaluate = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { expr, pairs, table, cache } = instance;
    let value: unknown;
    if (table === null || cache === null) {
      const reads: number[] = [];
      value = this.evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, reads);
      // push로 채운 배열은 V8이 늘어날 몫까지 잡아 둔다(원소 하나를 push하면 용량이 17). 길이만큼의 사본으로 바꾼다.
      const readLeaves: number[] = [];
      for (let i = 0; i < reads.length; i += 2) {
        if (!readLeaves.includes(reads[i])) {
          readLeaves.push(reads[i]);
        }
      }
      instance.readLeaves = readLeaves.slice();
    } else {
      const evaluated = this.evaluator.evalExpr(expr, pairs, table, cache);
      value = evaluated.value;
      instance.readLeaves = evaluated.leafOfVar;
    }
    instance.lastValue = value;
    return value;
  };

  // 식이 돌려준 값을 쓸 결과 leaf를 연결한다.
  bindResultLeaf = (exprInstanceIndex: number, resultLeafIndex: number): void => {
    this.store.bindDeriveResult(this.pool.entries[exprInstanceIndex].derive, resultLeafIndex);
  };

  // 스코프 인스턴스(scopeUid)에서 식(exprIndex)을 이미 공유 중이면 그 식 인스턴스 번호, 없으면 NOT_SHARED.
  findShared = (exprIndex: number, scopeUid: number): number => this.shared[exprIndex]?.get(scopeUid) ?? NOT_SHARED;

  // 식 인스턴스를 (exprIndex, scopeUid)로 공유 맵에 올린다. 참조 수가 0이 될 때 release가 지운다.
  markShared = (exprInstanceIndex: number, exprIndex: number, scopeUid: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.sharedExprIndex = exprIndex;
    instance.sharedScopeUid = scopeUid;
    const byScopeUid = this.shared[exprIndex] ?? new Map<number, number>();
    byScopeUid.set(scopeUid, exprInstanceIndex);
    this.shared[exprIndex] = byScopeUid;
  };

  // 식 인스턴스의 결과를 쓰는 leaf. bindResultLeaf 전에는 undefined다. 공유한 인스턴스를 두 번째로 든 자리가 같은
  // 결과 leaf를 구독하려고 읽는다.
  resultLeafOf = (exprInstanceIndex: number): number | undefined =>
    this.pool.entries[exprInstanceIndex].derive.resultLeafIndex;

  retain = (exprInstanceIndex: number): void => {
    this.pool.entries[exprInstanceIndex].refCount++;
  };

  // refCount를 하나 줄이고, 0이면 구독을 풀고 결과 leaf와 풀 번호를 반납한다.
  release = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.refCount--;
    if (instance.refCount > 0) {
      return;
    }
    if (instance.attachedCount > 0) {
      this.unsubscribeInputs(instance);
      instance.attachedCount = 0;
    }
    if (instance.sharedExprIndex !== NOT_SHARED) {
      this.shared[instance.sharedExprIndex].delete(instance.sharedScopeUid);
    }
    this.store.freeDeriveResult(instance.derive);
    this.pool.release(exprInstanceIndex);
  };

  // 붙은 가지를 하나 더한다. 처음 붙으면 입력 leaf마다 파생 구독을 건다. catchUp이면 입력 leaf마다 지금 한 번 불러
  // 놓친 입력을 따라잡는다.
  attach = (exprInstanceIndex: number, catchUp: boolean): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.attachedCount++;
    if (instance.attachedCount > 1) {
      return;
    }
    const { derive, readLeaves } = instance;
    for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
      if (this.isInputLeaf(instance, readLeafPosition)) {
        this.store.subscribeDerive(readLeaves[readLeafPosition], derive);
      }
    }
    if (catchUp) {
      // 건너뛸 부분식이 없는 식은 바뀐 leaf를 보지 않고 처음부터 세므로 입력 leaf 하나로 한 번만 부르면 된다.
      const refreshOnce = instance.table === null;
      // 따라잡는 호출이 READ_LEAF 구독을 다시 걸면 readLeaves가 바뀌므로 길이를 매번 다시 읽는다.
      for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
        if (this.isInputLeaf(instance, readLeafPosition)) {
          this.store.refreshDerive(derive, readLeaves[readLeafPosition]);
          if (refreshOnce) {
            break;
          }
        }
      }
    }
  };

  // 붙은 가지를 하나 줄인다. 마지막 가지가 떼지면 파생 구독을 푼다.
  detach = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.attachedCount--;
    if (instance.attachedCount === 0) {
      this.unsubscribeInputs(instance);
    }
  };

  clear = (): void => {
    this.pool.clear();
    this.shared = [];
  };

  private unsubscribeInputs = (instance: TExprInstance): void => {
    const { derive, readLeaves } = instance;
    for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
      if (this.isInputLeaf(instance, readLeafPosition)) {
        this.store.unsubscribeDerive(readLeaves[readLeafPosition], derive);
      }
    }
  };

  // readLeaves[readLeafPosition]이 구독할 입력 leaf인가 - 유효하고(0 이상) 같은 leaf를 앞에서 이미 읽지 않았다.
  // 건너뛸 부분식이 없는 식의 readLeaves는 evaluate가 중복 없이 채우므로 앞 검사를 하지 않는다.
  private isInputLeaf = (instance: TExprInstance, readLeafPosition: number): boolean => {
    const { readLeaves } = instance;
    return (
      readLeaves[readLeafPosition] >= 0 &&
      (instance.table === null || readLeaves.indexOf(readLeaves[readLeafPosition]) === readLeafPosition)
    );
  };

  // 건너뛸 부분식이 있는 식을 다시 센다. 칸이 바뀌면 그 칸과 무관한 부분식은 건너뛰며 센다. 구독 층이 한 flush에서
  // 함수를 한 번만 불러 바뀐 leaf 전체를 넘기므로, 그중 이 식이 읽는 변수를 모아 바뀐 변수 전체로 건너뛰기 표를
  // 골라 한꺼번에 센다. leaf마다 따로 세면 먼저 센 쪽이 다른 부분식의 cache에 든 옛 값을 섞어 쓴다.
  private runPartial = (instance: TExprInstance, changedLeaves: ReadonlySet<number>): unknown => {
    const { expr, pairs, readLeaves: leafOfVar } = instance;
    const table = instance.table as TExprSkipTable;
    const cache = instance.cache as unknown[];
    // 다시 걸기가 leafOfVar를 고치므로 바뀐 leaf를 읽는 변수를 먼저 번호의 비트로 모은다.
    //   ${nums[nums[0]]}, nums = [0, 7]에서 두 READ_LEAF가 nums[0]을 읽는다.
    //   nums[0]에 1을 쓰면 안쪽 차례에 바깥을 nums[1]로 옮겨, leafOfVar로는 바깥이 안 보인다.
    let changedVarMask = 0;
    if (changedLeaves.size < leafOfVar.length) {
      // 바뀐 leaf가 변수보다 적으면 바뀐 leaf를 훑어 정수로 비교한다(1000행이 읽는 기준값 하나가 바뀐 경우).
      for (const leafIndex of changedLeaves) {
        for (let n = 0; n < leafOfVar.length; n++) {
          if (leafOfVar[n] === leafIndex) {
            changedVarMask |= 1 << n;
          }
        }
      }
    } else {
      // 바뀐 leaf가 많으면 변수를 훑어 Set에 묻는다(바뀐 leaf가 수천 개인 batch).
      for (let n = 0; n < leafOfVar.length; n++) {
        if (changedLeaves.has(leafOfVar[n])) {
          changedVarMask |= 1 << n;
        }
      }
    }
    // 구독을 다시 걸며 이미 뺀 leafIndex다. 가지를 다시 붙일 때 다시 걸기 전 사본으로 따라잡으면 온다 -
    // 다시 건 그 호출이 이미 다시 셌으므로 할 일이 없다.
    if (changedVarMask === 0) {
      return instance.lastValue;
    }
    // 변수 하나만 바뀌면 식 정의가 공유하는 표를 쓴다. 둘 이상이면 그 변수들을 모두 품지 않은 부분식의
    // 표를 만든다(부모가 같은 칸을 두 prop으로 넘긴 경우도 여기다).
    const skipPastOps =
      (changedVarMask & (changedVarMask - 1)) === 0
        ? table.skipPastOpsByVar[31 - Math.clz32(changedVarMask)]
        : buildSkipPastOpsOfVars(table, expr, changedVarMask);
    const value = this.evaluator.reevalExpr(expr, pairs, table, cache, skipPastOps);
    if (table.hasIndexAccess) {
      for (let varNumber = 0; varNumber < leafOfVar.length; varNumber++) {
        if (changedVarMask & (1 << varNumber)) {
          this.resubscribeReadLeavesDependingOn(instance, varNumber);
        }
      }
    }
    instance.lastValue = value;
    return value;
  };

  // 변수 varNumber가 바뀌어 READ_LEAF가 읽을 leafIndex가 달라졌으면 그 READ_LEAF의 구독을 다시 건다.
  // READ_LEAF에 leafIndex를 넘긴 연산의 cache 값이 방금 읽은 leafIndex다.
  private resubscribeReadLeavesDependingOn = (instance: TExprInstance, varNumber: number): void => {
    const { expr } = instance;
    const table = instance.table as TExprSkipTable;
    const cache = instance.cache as unknown[];
    for (const op of table.readLeafIndexOpsByVar[varNumber]) {
      const readLeafVar = table.varAt[op + instrSize(expr[op])];
      const newLeafIndex = cache[table.cacheIndex[op]] as number;
      this.resubscribeReadLeaf(instance, readLeafVar, newLeafIndex);
    }
  };

  // READ_LEAF 변수(varNumber) 하나가 읽는 leafIndex를 newLeafIndex로 옮긴다. 옛 leafIndex를 읽는 변수가
  // 더 없으면 구독을 풀고, 새 leafIndex를 읽던 변수가 없었으면 구독한다. leafIndex가 그대로면 아무것도 하지 않는다.
  //
  // `${rows[cursor].score + rows[0].score}`에서 cursor가 1 -> 0이면 두 변수가 rows[0].score를 읽게 돼
  // 구독은 그대로 하나다.
  private resubscribeReadLeaf = (instance: TExprInstance, varNumber: number, newLeafIndex: number): void => {
    const { readLeaves: leafOfVar, derive } = instance;
    const oldLeafIndex = leafOfVar[varNumber];
    if (oldLeafIndex === newLeafIndex) {
      return;
    }
    const newAlreadyRead = leafOfVar.includes(newLeafIndex);
    leafOfVar[varNumber] = newLeafIndex;
    if (oldLeafIndex >= 0 && !leafOfVar.includes(oldLeafIndex)) {
      this.store.unsubscribeDerive(oldLeafIndex, derive);
    }
    if (!newAlreadyRead) {
      this.store.subscribeDerive(newLeafIndex, derive);
    }
  };
}
