// 표현식 층 - 식 인스턴스(식 하나가 한 스코프에서 읽는 leaf들과 결과)를 풀에 두고, 입력 leaf마다 파생 구독을
// 건다. 가지는 인스턴스 번호만 들고 다시 붙고 반납할 때 이 층을 부른다(region.ts).
//
// 파생 구독은 식 인스턴스 번호로 건다. `(a + b) * (c - d)`면 a~d 네 leaf에 같은 번호를 건다. 구독 층(leaf-store.ts)은
// 파생 구독을 모르고, flush마다 바뀐 leaf 모음을 이 층의 flush(통지 전 단계)에 넘긴다. flush는 그 leaf를 읽는
// 인스턴스를 다시 세어 결과 leaf에 write하고, 통지할 leaf 모음을 돌려준다.

import { type ExprEvaluator, NO_INPUT_VALUES, SKIP_NOTHING } from "./expr-eval.ts";
import { ExprGraph, LABEL_ELSE, LABEL_THEN, type TEdgeId } from "./expr-graph.ts";
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
  // 직전에 돌려준 값.
  lastValue: unknown;
  // 마지막으로 센 뒤 바뀐 변수 자리의 비트. readLeaves[n]이 바뀌면 n번 비트를 켠다. flush의 push가 켜고, 0이
  // 아니면 다시 셀 인스턴스다. 셀 때 이 비트로 건너뛰기 표를 고르고 0으로 지운다. pull이 평가하지 않은 쉬는
  // 인스턴스는 마스크가 다시 붙을 때까지 남는다(recountPending).
  pendingVarMask: number;
  // 식의 값을 write할 leaf. bindResultLeaf 전에는 undefined고, 없으면 센 값을 쓰지 않는다.
  resultLeaf: number | undefined;
  // 이 식 인스턴스가 있는 scope. 늘 식의 level과 같은 깊이의 scope다.
  scopeUid: number;
  // 이 식 인스턴스를 든 가지 수.
  heldByBranchCount: number;
  // 이 식 인스턴스를 입력으로 읽는 식 인스턴스 수. heldByBranchCount와 함께 0이 되면 반납한다.
  readByExprCount: number;
};

// 공유 맵에 없다는 뜻. 식 인스턴스 번호를 돌려주는 findShared가 쓴다.
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
  // flush의 push가 모은 다시 셀 식 인스턴스 번호. flush마다 배열을 만들지 않고 비우며 재사용한다.
  private recountExprInstanceIndices: number[] = [];
  // 식 인스턴스 사이의 간선. 노드 번호는 식 인스턴스 번호다. pull이 incoming labeled edge로 평가할지 정한다.
  readonly graph = new ExprGraph();
  // flush 하나나 recountPending 하나에서 값이 바뀐 결과 leaf. 요청이 재귀로 평가하는 식 인스턴스도 여기에 더한다.
  // 둘 밖에서는 null이다.
  private changedResultLeaves: number[] | null = null;

  constructor(evaluator: ExprEvaluator, store: LeafStoreSubject) {
    this.evaluator = evaluator;
    this.store = store;
    store.setDeriveStage(this.flush);
  }

  // 식 인스턴스를 만든다. 아직 가지도 식도 붙들지 않았다 - 붙드는 쪽이 retainByBranch나 retainByExpr를 호출한다. 식은
  // 아직 세지 않았으며 구독도 걸지 않는다 - evaluate가 세고, subscribeInputs가 건다.
  //
  // 건너뛸 부분식이 있는 식과 없는 식을 나눈다. 없는 식은 cache도 건너뛰기 표도 두지 않고 leaf가 바뀌면 처음부터
  // 센다. 같은 flush에서 읽는 leaf 여럿이 바뀌어도 flush가 인스턴스당 한 번만 세므로 한 번이면 된다.
  create = (globalExprIndex: number, pairs: TScope, scopeUid: number): number => {
    const table = this.evaluator.skipTable(globalExprIndex);
    const instance: TExprInstance = {
      globalExprIndex,
      pairs,
      cache: table === null ? null : new Array(table.opCount),
      readLeaves: [],
      lastValue: undefined,
      pendingVarMask: 0,
      resultLeaf: undefined,
      scopeUid,
      heldByBranchCount: 0,
      readByExprCount: 0,
    };
    return this.pool.alloc(instance);
  };

  // 통지 전 단계(store.setDeriveStage로 등록한다). push와 pull 두 단계로 나눈다.
  //   - push: 바뀐 leaf마다 그 leaf를 파생 구독한 식 인스턴스의 pendingVarMask에 바뀐 변수 자리를 켠다. 마스크가
  //     0이었던 인스턴스만 recountExprInstanceIndices에 넣어, 바뀐 leaf 여럿을 읽는 인스턴스도 한 번만 든다. 앞선
  //     flush에서 평가하지 않아 마스크가 남은 쉬는 인스턴스도 다시 넣지 않는다 - 다시 붙을 때 recountPending이 센다.
  //     세지 않는다.
  //   - pull: recountExprInstanceIndices의 인스턴스를 요청한다(request). 평가 대상인 인스턴스만 그 마스크로 평가해
  //     결과 leaf에 write한다.
  // 값이 바뀐 결과 leaf를 돌려준다(없으면 null). 식이 던지면 onError로 넘기고 나머지는 계속 센다.
  //
  // push가 끝난 뒤에 세므로 마스크에는 이번 flush에 바뀐 변수가 모두 들어 있다. 세는 도중 READ_LEAF 구독을 다시
  // 걸어 파생 구독 슬롯이 바뀌어도 push는 이미 끝나 순회가 깨지지 않는다.
  // `${big > 50}`에서 big이 100 -> 200이면 true 그대로라 결과 leaf의 값이 같아 쓰지 않는다.
  flush = (changed: ReadonlySet<number>, onError: (error: unknown) => void): number[] | null => {
    const { recountExprInstanceIndices } = this;
    for (const leafIndex of changed) {
      const derives = this.deriveSubscribers[leafIndex];
      if (derives === undefined) {
        continue;
      }
      if (typeof derives === "number") {
        this.markChanged(derives, leafIndex);
      } else {
        for (const exprInstanceIndex of derives) {
          this.markChanged(exprInstanceIndex, leafIndex);
        }
      }
    }
    const { graph } = this;
    for (const exprInstanceIndex of recountExprInstanceIndices) {
      try {
        // incoming edge가 없는 인스턴스가 대부분이라 request를 거치지 않고 바로 평가한다. 목록에 든 인스턴스는
        // 마스크가 0이 아니다 - 앞선 request가 재귀로 이미 평가했으면 0이다.
        if (graph.incomingEdgesOfNode(exprInstanceIndex) !== undefined) {
          this.request(exprInstanceIndex);
        } else if (this.pool.entries[exprInstanceIndex].pendingVarMask !== 0) {
          this.recount(exprInstanceIndex);
        }
      } catch (error) {
        onError(error);
      }
    }
    recountExprInstanceIndices.length = 0;
    const resultLeaves = this.changedResultLeaves;
    this.changedResultLeaves = null;
    return resultLeaves;
  };

  // 식 인스턴스가 평가 대상이면 true를 돌려준다. incoming labeled edge가 있으면 시작점을 먼저 요청하고, 시작점이 평가
  // 대상이면서 그 값이 label과 맞는 간선이 하나라도 있어야 평가 대상이다. 평가 대상이고 pendingVarMask가 0이 아니면
  // 다시 평가한다. 평가 대상이 아니면 마스크를 그대로 둔다 - 나중에 조건이 맞을 때 그 마스크로 평가한다.
  //
  // 시작점이 평가 대상인지까지 보는 이유는 겹친 @if다. `[c1] --(then)--> [c2] --(then)--> [x]`에서 c1이 false면 c2는
  // 평가하지 않아 lastValue가 낡았다. 그 낡은 값이 then과 맞아도 x를 평가하면 안 된다.
  //
  // 조건 아래 가지는 식 인스턴스를 가질 때 heldByBranchCount 하나와 incoming labeled edge 하나를 더한다. incoming
  // labeled edge 수가 heldByBranchCount보다 작으면 조건 없이 가진 가지가 있다는 뜻이라 간선을 보지 않고 평가 대상이다.
  private request = (exprInstanceIndex: number): boolean => {
    const instance = this.pool.entries[exprInstanceIndex];
    const incoming = this.graph.incomingEdgesOfNode(exprInstanceIndex);
    if (incoming !== undefined && incoming.length === instance.heldByBranchCount && !this.someEdgeChooses(incoming)) {
      return false;
    }
    if (instance.pendingVarMask !== 0) {
      this.recount(exprInstanceIndex);
    }
    return true;
  };

  private someEdgeChooses = (incoming: readonly TEdgeId[]): boolean => {
    const { graph } = this;
    for (const edge of incoming) {
      const startNode = graph.startNodeOfEdge(edge);
      if (this.request(startNode) && labelMatches(graph.labelOfEdge(edge), this.pool.entries[startNode].lastValue)) {
        return true;
      }
    }
    return false;
  };

  // 다시 평가해 값이 바뀌었으면 결과 leaf에 write하고 changedResultLeaves에 더한다.
  private recount = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    const previous = instance.lastValue;
    const value = this.run(exprInstanceIndex);
    const { resultLeaf } = instance;
    if (resultLeaf !== undefined && value !== previous) {
      this.store.write(resultLeaf, value);
      this.changedResultLeaves ??= [];
      this.changedResultLeaves.push(resultLeaf);
    }
  };

  // 식 인스턴스에 바뀐 leaf를 표시한다. readLeaves에서 leafIndex인 자리의 비트를 pendingVarMask에 켜고, 마스크가
  // 0이었으면 recountExprInstanceIndices에 넣는다. 같은 leaf를 두 변수가 읽으면(부모가 같은 칸을 두 prop으로 넘긴
  // 경우) 두 비트를 켠다.
  private markChanged = (exprInstanceIndex: number, leafIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { readLeaves } = instance;
    const wasZero = instance.pendingVarMask === 0;
    for (let n = 0; n < readLeaves.length; n++) {
      if (readLeaves[n] === leafIndex) {
        instance.pendingVarMask |= 1 << n;
      }
    }
    if (wasZero && instance.pendingVarMask !== 0) {
      this.recountExprInstanceIndices.push(exprInstanceIndex);
    }
  };

  // 식을 다시 세어 값을 돌려주고 lastValue에 기록한다. store에 쓰지 않는다. 결과 leaf에는 늘 lastValue가 들어
  // 있으므로(처음 값은 evaluate가 센 값이다) 결과 leaf를 읽지 않고 lastValue로 바뀌었는지 가린다. 세기 전에
  // pendingVarMask를 0으로 지운다 - 식이 throw해도 마스크가 다음 flush로 남지 않는다.
  private run = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    if (instance.cache === null) {
      instance.pendingVarMask = 0;
      const expr = this.evaluator.exprBytes[instance.globalExprIndex];
      instance.lastValue = this.evaluator.runExpr(
        expr,
        instance.pairs,
        null,
        null,
        SKIP_NOTHING,
        null,
        NO_INPUT_VALUES,
      );
      return instance.lastValue;
    }
    return this.runPartial(exprInstanceIndex);
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
      value = this.evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, reads, NO_INPUT_VALUES);
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
      const evaluated = this.evaluator.evalExpr(expr, pairs, table, cache, NO_INPUT_VALUES);
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

  // 식 인스턴스를 자기 (globalExprIndex, scopeUid)로 공유 맵에 올린다. 인스턴스를 반납할 때 freeIfUnheld가 지운다.
  markShared = (exprInstanceIndex: number): void => {
    const { globalExprIndex, scopeUid } = this.pool.entries[exprInstanceIndex];
    const byScopeUid = this.shared[globalExprIndex] ?? new Map<number, number>();
    byScopeUid.set(scopeUid, exprInstanceIndex);
    this.shared[globalExprIndex] = byScopeUid;
  };

  // 식 인스턴스의 결과를 쓰는 leaf. bindResultLeaf 전에는 undefined다. 공유한 인스턴스를 두 번째로 든 자리가 같은
  // 결과 leaf를 구독하려고 읽는다.
  resultLeafOf = (exprInstanceIndex: number): number | undefined => this.pool.entries[exprInstanceIndex].resultLeaf;

  retainByBranch = (exprInstanceIndex: number): void => {
    this.pool.entries[exprInstanceIndex].heldByBranchCount++;
  };

  // heldByBranchCount를 하나 줄이고, 식도 읽지 않으면 반납한다(freeIfUnheld).
  releaseByBranch = (exprInstanceIndex: number): void => {
    this.pool.entries[exprInstanceIndex].heldByBranchCount--;
    this.freeIfUnheld(exprInstanceIndex);
  };

  retainByExpr = (exprInstanceIndex: number): void => {
    this.pool.entries[exprInstanceIndex].readByExprCount++;
  };

  // readByExprCount를 하나 줄이고, 가지도 들지 않으면 반납한다(freeIfUnheld).
  releaseByExpr = (exprInstanceIndex: number): void => {
    this.pool.entries[exprInstanceIndex].readByExprCount--;
    this.freeIfUnheld(exprInstanceIndex);
  };

  // 가지도 식도 붙들지 않으면 파생 구독을 풀고 공유 키, 결과 leaf, 풀 번호를 반납한다.
  private freeIfUnheld = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    if (instance.heldByBranchCount > 0 || instance.readByExprCount > 0) {
      return;
    }
    this.unsubscribeInputs(exprInstanceIndex);
    // 맵의 그 키가 이 인스턴스를 가리킬 때만 지운다. 같은 식을 @for 안(공유)과 밖(공유 안 함)에서 쓰면 두 인스턴스의
    // (globalExprIndex, scopeUid)가 같아, 키만 보고 지우면 공유하지 않은 쪽을 반납할 때 공유한 쪽의 항목이 빠진다.
    const byScopeUid = this.shared[instance.globalExprIndex];
    if (byScopeUid?.get(instance.scopeUid) === exprInstanceIndex) {
      byScopeUid.delete(instance.scopeUid);
    }
    if (instance.resultLeaf !== undefined) {
      this.store.free(instance.resultLeaf, 1);
    }
    this.pool.release(exprInstanceIndex);
  };

  // 입력 leaf마다 파생 구독을 건다. evaluate가 readLeaves를 채운 뒤 한 번 부르고, 구독은 인스턴스를 반납할 때(freeIfUnheld)
  // 풀 때까지 둔다. 가지가 떼어져 쉬는 동안에도 구독이 남아 push가 바뀐 변수를 pendingVarMask에 모은다.
  subscribeInputs = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { readLeaves } = instance;
    for (let readLeafPosition = 0; readLeafPosition < readLeaves.length; readLeafPosition++) {
      if (this.isInputLeaf(instance, readLeafPosition)) {
        this.subscribeDerive(readLeaves[readLeafPosition], exprInstanceIndex);
      }
    }
  };

  // 다시 붙는 가지의 식 인스턴스를 요청해(request), 쉬는 동안 남은 pendingVarMask로 평가한다. 요청이 incoming edge의
  // 시작점을 먼저 요청하므로 시작점도 마스크가 남았으면 먼저 평가한다. 마스크가 0이면 세지 않는다.
  //
  // 값이 바뀐 결과 leaf는 바로 notify한다. 가지는 flush의 notify 단계에서 다시 붙어, 바뀐 결과 leaf를 돌려줄 flush가
  // 이미 끝났다.
  recountPending = (exprInstanceIndex: number): void => {
    this.request(exprInstanceIndex);
    const resultLeaves = this.changedResultLeaves;
    this.changedResultLeaves = null;
    if (resultLeaves !== null) {
      for (const resultLeaf of resultLeaves) {
        this.store.notify(resultLeaf);
      }
    }
  };

  clear = (): void => {
    this.pool.clear();
    this.shared = [];
    this.deriveSubscribers.length = 0;
    this.graph.clear();
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

  // 건너뛸 부분식이 있는 식을 다시 센다. pendingVarMask에 든 바뀐 변수 전체로 건너뛰기 표를 골라 한꺼번에 센다.
  // 변수마다 따로 세면 먼저 센 쪽이 다른 부분식의 cache에 든 옛 값을 섞어 쓴다.
  //
  // 마스크는 세기 전에 push가 다 모아 둔 것이라, 세는 도중 다시 걸기가 leafOfVar를 고쳐도 바뀐 변수를 놓치지 않는다.
  //   ${nums[nums[0]]}, nums = [0, 7]에서 두 READ_LEAF가 nums[0]을 읽는다.
  //   nums[0]에 1을 쓰면 안쪽 차례에 바깥을 nums[1]로 옮겨, 그 뒤의 leafOfVar로는 바깥이 안 보인다.
  private runPartial = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { globalExprIndex, pairs, readLeaves: leafOfVar } = instance;
    const expr = this.evaluator.exprBytes[globalExprIndex];
    const table = this.evaluator.skipTable(globalExprIndex) as TExprSkipTable;
    const cache = instance.cache as unknown[];
    const changedVarMask = instance.pendingVarMask;
    instance.pendingVarMask = 0;
    // 변수 하나만 바뀌면 식 정의가 공유하는 표를 쓴다. 둘 이상이면 그 변수들을 모두 품지 않은 부분식의
    // 표를 만든다(부모가 같은 칸을 두 prop으로 넘긴 경우도 여기다).
    const skipPastOps =
      (changedVarMask & (changedVarMask - 1)) === 0
        ? table.skipPastOpsByVar[31 - Math.clz32(changedVarMask)]
        : buildSkipPastOpsOfVars(table, expr, changedVarMask);
    const value = this.evaluator.reevalExpr(expr, pairs, table, cache, skipPastOps, NO_INPUT_VALUES);
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

// 간선의 시작점 값이 label과 맞는지. then은 truthy, else는 falsy, 행 번호 k는 k < 값일 때 맞는다.
const labelMatches = (label: number, startValue: unknown): boolean => {
  if (label === LABEL_THEN) {
    return !!startValue;
  }
  if (label === LABEL_ELSE) {
    return !startValue;
  }
  return label < Number(startValue);
};
