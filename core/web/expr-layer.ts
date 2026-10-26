// 표현식 층 - 식 인스턴스(식 하나가 한 스코프에서 읽는 leaf들과 결과)를 풀에 두고, 입력 leaf마다 파생 구독을
// 건다. 가지는 인스턴스 번호만 들고 붙고 떼고 반납할 때 이 층을 부른다(region.ts).
//
// 파생 구독은 식 인스턴스 번호로 건다. `(a + b) * (c - d)`면 a~d 네 leaf에 같은 번호를 건다. 구독 층(leaf-store.ts)은
// 파생 구독을 모르고, flush마다 바뀐 leaf 모음을 이 층의 flush(통지 전 단계)에 넘긴다. flush는 그 leaf를 읽는
// 인스턴스를 다시 세어 결과 leaf에 write하고, 통지할 leaf 모음을 돌려준다.

import { type ExprEvaluator, SKIP_NOTHING } from "./expr-eval.ts";
import { instrSize } from "./expr-opcode.ts";
import { buildSkipPastOpsOfVars, type TExprSkipTable } from "./expr-skip-table.ts";
import type { LeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import type { TScope } from "./scope.ts";

export type TExprInstance = {
  globalExprIndex: number;
  pairs: TScope;
  // 건너뛸 부분식이 있는 식만 갖는다. 없는 식은 cache가 null이다.
  cache: unknown[] | null;
  // 식이 읽은 leaf이자 구독할 입력 leaf. 건너뛸 부분식이 있는 식은 변수마다 읽는 leafIndex(중복과 -1 포함)고, 없는
  // 식은 중복 없는 목록이다. evaluate가 채우고, READ_LEAF 구독을 다시 걸 때 고친다.
  readLeaves: number[];
  // 직전에 돌려준 값. 바뀐 입력이 이 식의 변수가 아니면(다시 걸며 이미 뺀 leaf) 이것을 그대로 돌려준다.
  lastValue: unknown;
  // 식의 값을 write할 leaf. bindResultLeaf 전에는 undefined고, 없으면 센 값을 쓰지 않는다.
  resultLeaf: number | undefined;
  // 이 식 인스턴스를 든 가지 수와, 그중 붙어 있는 가지 수.
  refCount: number;
  attachedCount: number;
  // 입력 leaf에 파생 구독을 한 번이라도 걸었나. 참인데 attachedCount가 0이면 구독이 풀린 동안 입력이 바뀌어 결과
  // leaf가 낡았을 수 있다.
  everAttached: boolean;
  // 공유 맵에 올린 키(globalExprIndex와 스코프 인스턴스 번호). 공유하지 않는 인스턴스는 둘 다 NOT_SHARED다.
  sharedGlobalExprIndex: number;
  sharedScopeUid: number;
};

// 공유 맵에 없다는 뜻. 식 인스턴스 번호를 돌려주는 findShared와 인스턴스의 공유 키 자리에 쓴다.
export const NOT_SHARED = -1;

// leaf마다 파생 구독(식 인스턴스 번호)을 담는 슬롯. 구독이 하나뿐인 leaf가 대부분이라 하나면 번호 그대로, 둘째가
// 들어오면 Set으로 바꾼다.
type TDeriveSlot = number | Set<number> | undefined;

export class ExprInstancePool {
  pool: Pool<TExprInstance> = new Pool();
  evaluator: ExprEvaluator;
  store: LeafStoreSubject;
  // 공유 중인 식 인스턴스. shared[globalExprIndex].get(scopeUid)가 식 인스턴스 번호다.
  private shared: Array<Map<number, number>> = [];
  // 입력 leafIndex -> 그 leaf를 읽는 식 인스턴스 번호들. 번호 하나가 입력 leaf 여러 개의 슬롯에 들 수 있다.
  // 배열을 바꾸지 않고 비우기만 한다 - 인스턴스가 테스트용으로 이 배열을 내놓는다(vm.ts instanceOf).
  readonly deriveSubscribers: TDeriveSlot[] = [];
  // 따라잡을 때 입력 leaf를 모아 파생 구독에 넘기는 Set. 가지를 켤 때 행마다 Set을 만들면 그 할당이 GC로 드러나
  // 비우고 채우며 재사용한다. 함수가 끝난 뒤에는 쓰지 않으므로 통지가 이어서 다른 인스턴스를 붙여도 안전하다.
  private catchUpLeaves = new Set<number>();

  constructor(evaluator: ExprEvaluator, store: LeafStoreSubject) {
    this.evaluator = evaluator;
    this.store = store;
    store.setDeriveStage(this.flush);
  }

  // 식 인스턴스를 짓는다. refCount는 1이고 식은 아직 세지 않았으며 구독도 걸지 않는다 - evaluate가 세고, 가지가
  // 붙을 때 attach가 건다.
  //
  // 건너뛸 부분식이 있는 식과 없는 식을 나눈다. 없는 식은 cache도 건너뛰기 표도 두지 않고 leaf가 바뀌면 처음부터
  // 센다. 같은 flush에서 읽는 leaf 여럿이 바뀌어도 flush가 인스턴스당 한 번만 세므로 한 번이면 된다.
  create = (globalExprIndex: number, pairs: TScope): number => {
    const table = this.evaluator.skipTable(globalExprIndex);
    const instance: TExprInstance = {
      globalExprIndex,
      pairs,
      cache: table === null ? null : new Array(table.opCount),
      readLeaves: [],
      lastValue: undefined,
      resultLeaf: undefined,
      refCount: 1,
      attachedCount: 0,
      everAttached: false,
      sharedGlobalExprIndex: NOT_SHARED,
      sharedScopeUid: NOT_SHARED,
    };
    return this.pool.alloc(instance);
  };

  // 통지 전 단계(store.setDeriveStage로 등록한다). 바뀐 leaf를 읽는 식 인스턴스를 인스턴스당 한 번 다시 세어 결과
  // leaf에 write하고, 바뀐 leaf에 값이 바뀐 결과 leaf를 더한 모음을 돌려준다. 바뀐 leaf 모음(changed)을 모든
  // 인스턴스가 그대로 공유한다 - 인스턴스마다 자기가 읽는 leaf를 has로 가려내므로 인스턴스별 배열과 Map을 만들
  // 필요가 없다(1000행의 식이 함께 바뀌면 그 할당이 클릭 한 번의 시간을 늘렸다). 식이 던지면 onError로 넘기고
  // 나머지는 계속 센다.
  //
  // 바뀐 leaf가 하나면 같은 인스턴스를 두 번 만날 일이 없어 이미 센 인스턴스를 Set으로 기억하지 않는다. 한 leaf에
  // 파생 구독이 수천 개 걸린 식(1000행의 같은 기준값을 읽는 식)에서 그 Set을 채우는 비용이 클릭 한 번보다 컸다.
  // `${big > 50}`에서 big이 100 -> 200이면 true 그대로라 결과 leaf의 값이 같아 쓰지 않는다.
  flush = (changed: ReadonlySet<number>, onError: (error: unknown) => void): ReadonlySet<number> => {
    const { store } = this;
    const single = changed.size === 1;
    let counted: Set<number> | undefined;
    let toNotify: Set<number> | undefined;
    const countOne = (exprInstanceIndex: number): void => {
      if (!single) {
        counted ??= new Set();
        if (counted.has(exprInstanceIndex)) {
          return;
        }
        counted.add(exprInstanceIndex);
      }
      try {
        const instance = this.pool.entries[exprInstanceIndex];
        const previous = instance.lastValue;
        const value = this.run(exprInstanceIndex, changed);
        const { resultLeaf } = instance;
        if (resultLeaf !== undefined && value !== previous) {
          store.write(resultLeaf, value);
          toNotify ??= new Set(changed);
          toNotify.add(resultLeaf);
        }
      } catch (error) {
        onError(error);
      }
    };
    for (const leafIndex of changed) {
      const derives = this.deriveSubscribers[leafIndex];
      if (derives === undefined) {
        continue;
      }
      if (typeof derives === "number") {
        countOne(derives);
      } else if (single) {
        // 스냅샷 순회 - 세는 도중 읽는 leaf를 다시 걸며 이 Set을 고칠 수 있다. 바뀐 leaf가 여럿이면 counted가
        // 다시 만난 인스턴스를 거른다.
        for (const exprInstanceIndex of [...derives]) {
          countOne(exprInstanceIndex);
        }
      } else {
        for (const exprInstanceIndex of derives) {
          countOne(exprInstanceIndex);
        }
      }
    }
    return toNotify ?? changed;
  };

  // 식을 다시 세어 값을 돌려주고 lastValue에 기록한다. store에 쓰지 않는다. 결과 leaf에는 늘 lastValue가 들어
  // 있으므로(처음 값은 evaluate가 센 값이다) 결과 leaf를 읽지 않고 lastValue로 바뀌었는지 가린다.
  private run = (exprInstanceIndex: number, changedLeaves: ReadonlySet<number>): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    if (instance.cache === null) {
      const expr = this.evaluator.exprBytes[instance.globalExprIndex];
      instance.lastValue = this.evaluator.runExpr(expr, instance.pairs, null, null, SKIP_NOTHING, null);
      return instance.lastValue;
    }
    return this.runPartial(exprInstanceIndex, changedLeaves);
  };

  // 식을 처음부터 세어 값을 돌려주고, 읽은 leaf(readLeaves)와 값(lastValue)을 인스턴스에 기록한다. 몇 번을 불러도
  // 같은 결과다. 구독을 건 채로 부르지 않는다 - 구독 대상(readLeaves)이 바뀌는데 구독은 그대로다.
  evaluate = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { globalExprIndex, pairs, cache } = instance;
    const expr = this.evaluator.exprBytes[globalExprIndex];
    let value: unknown;
    if (cache === null) {
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
      const table = this.evaluator.skipTable(globalExprIndex) as TExprSkipTable;
      const evaluated = this.evaluator.evalExpr(expr, pairs, table, cache);
      value = evaluated.value;
      instance.readLeaves = evaluated.leafOfVar;
    }
    instance.lastValue = value;
    return value;
  };

  // 식이 돌려준 값을 쓸 결과 leaf를 연결한다.
  bindResultLeaf = (exprInstanceIndex: number, resultLeafIndex: number): void => {
    this.pool.entries[exprInstanceIndex].resultLeaf = resultLeafIndex;
  };

  // 스코프 인스턴스(scopeUid)에서 식(globalExprIndex)을 이미 공유 중이면 그 식 인스턴스 번호, 없으면 NOT_SHARED.
  findShared = (globalExprIndex: number, scopeUid: number): number =>
    this.shared[globalExprIndex]?.get(scopeUid) ?? NOT_SHARED;

  // 식 인스턴스를 (globalExprIndex, scopeUid)로 공유 맵에 올린다. 참조 수가 0이 될 때 release가 지운다.
  markShared = (exprInstanceIndex: number, globalExprIndex: number, scopeUid: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.sharedGlobalExprIndex = globalExprIndex;
    instance.sharedScopeUid = scopeUid;
    const byScopeUid = this.shared[globalExprIndex] ?? new Map<number, number>();
    byScopeUid.set(scopeUid, exprInstanceIndex);
    this.shared[globalExprIndex] = byScopeUid;
  };

  // 식 인스턴스의 결과를 쓰는 leaf. bindResultLeaf 전에는 undefined다. 공유한 인스턴스를 두 번째로 든 자리가 같은
  // 결과 leaf를 구독하려고 읽는다.
  resultLeafOf = (exprInstanceIndex: number): number | undefined => this.pool.entries[exprInstanceIndex].resultLeaf;

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
      this.unsubscribeInputs(exprInstanceIndex);
      instance.attachedCount = 0;
    }
    if (instance.sharedGlobalExprIndex !== NOT_SHARED) {
      this.shared[instance.sharedGlobalExprIndex].delete(instance.sharedScopeUid);
    }
    if (instance.resultLeaf !== undefined) {
      this.store.free(instance.resultLeaf, 1);
    }
    this.pool.release(exprInstanceIndex);
  };

  // 붙은 가지를 하나 더한다. 붙은 가지가 0에서 1이 되면 입력 leaf마다 파생 구독을 건다. 구독이 풀렸던 적이 있으면
  // 입력 leaf 전체를 바뀐 leaf로 넘겨 한 번 불러 놓친 입력을 따라잡는다. leaf마다 부르면 식을 입력 leaf 수만큼
  // 세고, 나머지 입력이 낡은 채 센 중간 값까지 통지한다. 처음 걸 때는 evaluate가 방금 센 값이 최신이라 따라잡지
  // 않는다.
  attach = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.attachedCount++;
    if (instance.attachedCount > 1) {
      return;
    }
    const { readLeaves } = instance;
    for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
      if (this.isInputLeaf(instance, readLeafPosition)) {
        this.subscribeDerive(readLeaves[readLeafPosition], exprInstanceIndex);
      }
    }
    if (instance.everAttached) {
      const catchUpLeaves = this.catchUpLeaves;
      catchUpLeaves.clear();
      for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
        if (this.isInputLeaf(instance, readLeafPosition)) {
          catchUpLeaves.add(readLeaves[readLeafPosition]);
        }
      }
      const previous = instance.lastValue;
      const value = this.run(exprInstanceIndex, catchUpLeaves);
      const { resultLeaf } = instance;
      if (resultLeaf !== undefined && value !== previous) {
        this.store.write(resultLeaf, value);
        this.store.notify(resultLeaf);
      }
    }
    instance.everAttached = true;
  };

  // 붙은 가지를 하나 줄인다. 마지막 가지가 떼지면 파생 구독을 푼다.
  detach = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.attachedCount--;
    if (instance.attachedCount === 0) {
      this.unsubscribeInputs(exprInstanceIndex);
    }
  };

  clear = (): void => {
    this.pool.clear();
    this.shared = [];
    this.deriveSubscribers.length = 0;
  };

  private subscribeDerive = (leafIndex: number, exprInstanceIndex: number): void => {
    const current = this.deriveSubscribers[leafIndex];
    if (current === undefined) {
      this.deriveSubscribers[leafIndex] = exprInstanceIndex;
    } else if (typeof current === "number") {
      if (current !== exprInstanceIndex) {
        this.deriveSubscribers[leafIndex] = new Set([current, exprInstanceIndex]);
      }
    } else {
      current.add(exprInstanceIndex);
    }
  };

  private unsubscribeDerive = (leafIndex: number, exprInstanceIndex: number): void => {
    const current = this.deriveSubscribers[leafIndex];
    if (current === exprInstanceIndex) {
      this.deriveSubscribers[leafIndex] = undefined;
    } else if (current !== undefined && typeof current !== "number") {
      current.delete(exprInstanceIndex);
    }
  };

  private unsubscribeInputs = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { readLeaves } = instance;
    for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
      if (this.isInputLeaf(instance, readLeafPosition)) {
        this.unsubscribeDerive(readLeaves[readLeafPosition], exprInstanceIndex);
      }
    }
  };

  // readLeaves[readLeafPosition]이 구독할 입력 leaf인가 - 유효하고(0 이상) 같은 leaf를 앞에서 이미 읽지 않았다.
  // 건너뛸 부분식이 없는 식의 readLeaves는 evaluate가 중복 없이 채우므로 앞 검사를 하지 않는다.
  private isInputLeaf = (instance: TExprInstance, readLeafPosition: number): boolean => {
    const { readLeaves } = instance;
    return (
      readLeaves[readLeafPosition] >= 0 &&
      (instance.cache === null || readLeaves.indexOf(readLeaves[readLeafPosition]) === readLeafPosition)
    );
  };

  // 건너뛸 부분식이 있는 식을 다시 센다. 칸이 바뀌면 그 칸과 무관한 부분식은 건너뛰며 센다. 구독 층이 한 flush에서
  // 함수를 한 번만 불러 바뀐 leaf 전체를 넘기므로, 그중 이 식이 읽는 변수를 모아 바뀐 변수 전체로 건너뛰기 표를
  // 골라 한꺼번에 센다. leaf마다 따로 세면 먼저 센 쪽이 다른 부분식의 cache에 든 옛 값을 섞어 쓴다.
  private runPartial = (exprInstanceIndex: number, changedLeaves: ReadonlySet<number>): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { globalExprIndex, pairs, readLeaves: leafOfVar } = instance;
    const expr = this.evaluator.exprBytes[globalExprIndex];
    const table = this.evaluator.skipTable(globalExprIndex) as TExprSkipTable;
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
    // 바뀐 leaf 중 이 식이 읽는 것이 없다(구독을 다시 걸며 이미 뺀 leafIndex). 다시 셀 것이 없다.
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
          this.resubscribeReadLeavesDependingOn(exprInstanceIndex, varNumber);
        }
      }
    }
    instance.lastValue = value;
    return value;
  };

  // 변수 varNumber가 바뀌어 READ_LEAF가 읽을 leafIndex가 달라졌으면 그 READ_LEAF의 구독을 다시 건다.
  // READ_LEAF에 leafIndex를 넘긴 연산의 cache 값이 방금 읽은 leafIndex다.
  private resubscribeReadLeavesDependingOn = (exprInstanceIndex: number, varNumber: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { globalExprIndex } = instance;
    const expr = this.evaluator.exprBytes[globalExprIndex];
    const table = this.evaluator.skipTable(globalExprIndex) as TExprSkipTable;
    const cache = instance.cache as unknown[];
    for (const op of table.readLeafIndexOpsByVar[varNumber]) {
      const readLeafVar = table.varAt[op + instrSize(expr[op])];
      const newLeafIndex = cache[table.cacheIndex[op]] as number;
      this.resubscribeReadLeaf(exprInstanceIndex, readLeafVar, newLeafIndex);
    }
  };

  // READ_LEAF 변수(varNumber) 하나가 읽는 leafIndex를 newLeafIndex로 옮긴다. 옛 leafIndex를 읽는 변수가
  // 더 없으면 구독을 풀고, 새 leafIndex를 읽던 변수가 없었으면 구독한다. leafIndex가 그대로면 아무것도 하지 않는다.
  //
  // `${rows[cursor].score + rows[0].score}`에서 cursor가 1 -> 0이면 두 변수가 rows[0].score를 읽게 돼
  // 구독은 그대로 하나다.
  private resubscribeReadLeaf = (exprInstanceIndex: number, varNumber: number, newLeafIndex: number): void => {
    const { readLeaves: leafOfVar } = this.pool.entries[exprInstanceIndex];
    const oldLeafIndex = leafOfVar[varNumber];
    if (oldLeafIndex === newLeafIndex) {
      return;
    }
    const newAlreadyRead = leafOfVar.includes(newLeafIndex);
    leafOfVar[varNumber] = newLeafIndex;
    if (oldLeafIndex >= 0 && !leafOfVar.includes(oldLeafIndex)) {
      this.unsubscribeDerive(oldLeafIndex, exprInstanceIndex);
    }
    if (!newAlreadyRead) {
      this.subscribeDerive(newLeafIndex, exprInstanceIndex);
    }
  };
}
