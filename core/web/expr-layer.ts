// 표현식 층 - 식 인스턴스(식 하나가 한 스코프에서 읽는 leaf들과 결과)를 풀에 두고, 입력 leaf마다 파생 구독을
// 건다. 가지는 인스턴스 번호만 들고 다시 붙고 반납할 때 이 층을 부른다(region.ts).
//
// 파생 구독은 식 인스턴스 번호로 건다. `(a + b) * (c - d)`면 a~d 네 leaf에 같은 번호를 건다. 구독 층(leaf-store.ts)은
// 파생 구독을 모르고, flush마다 바뀐 leaf 모음을 이 층의 flush(통지 전 단계)에 넘긴다. flush는 그 leaf를 읽는
// 인스턴스를 다시 세어 결과 leaf에 write하고, 통지할 leaf 모음을 돌려준다.

import { FV_CONST, FV_EXPR, type TExprInputs, type TRef } from "./decode.ts";
import { type ExprEvaluator, NO_INPUT_VALUES, SKIP_NOTHING } from "./expr-eval.ts";
import { ExprGraph, LABEL_ELSE, LABEL_THEN, type TEdgeId } from "./expr-graph.ts";
import { buildSkipPastOpsOfVars, type TExprSkipTable } from "./expr-skip-table.ts";
import type { LeafStoreSubject } from "./leaf-store.ts";
import { Pool } from "./pool-allocator.ts";
import type { TScope } from "./scope.ts";
import { ancestorScopeUid, type TScopeParentPool } from "./scope-uid.ts";

export type TExprInstance = {
  globalExprIndex: number;
  pairs: TScope;
  // 건너뛸 부분식이 있거나 READ_LEAF가 있는 계산 식만 갖는다(create). 나머지는 cache가 null이다.
  cache: unknown[] | null;
  // 식이 읽은 leaf이자 구독할 입력 leaf. cache가 있는 계산 식은 변수마다 읽는 leafIndex(중복과 -1 포함, LOAD_INPUT
  // 변수의 자리는 -1)고, cache가 없는 계산 식은 중복 없는 목록이다. 삼항은 [cond, 참 갈래, 거짓 갈래] 자리의 leafIndex이고
  // 잎이 아닌 피연산자와 고르지 않은 갈래의 자리는 -1이다. evaluate가 처음 셀 때 채우고, 다시 센 뒤 읽는 leaf가
  // 바뀌었으면 고친다.
  readLeaves: number[];
  // 직전에 돌려준 값.
  lastValue: unknown;
  // 마지막으로 센 뒤 바뀐 변수 자리의 비트. readLeaves[n]이 바뀌면 n번 비트를, 입력 자리 i의 입력 인스턴스가 다시 셀
  // 인스턴스가 되면 그 입력의 변수 번호(inputPositionToVarNumber[i]) 비트를 켠다. flush의 push가 켜고, 0이
  // 아니면 다시 셀 인스턴스다. 셀 때 이 비트로 건너뛰기 표를 고르고 0으로 지운다. pull이 평가하지 않은 쉬는
  // 인스턴스는 마스크가 다시 붙을 때까지 남는다(recountPending).
  pendingVarMask: number;
  // 식의 값을 write할 leaf. bindResultLeaf 전에는 undefined고, 없으면 센 값을 쓰지 않는다.
  resultLeaf: number | undefined;
  // 이 식 인스턴스가 있는 scope. 늘 식의 level과 같은 깊이의 scope다.
  scopeUid: number;
  // 이 식 인스턴스를 든 가지 수.
  heldByBranchCount: number;
  // 입력 식의 인스턴스. evaluate가 처음 셀 때 만든다. 계산 식은 inputs[i]의 인스턴스, 삼항은 [cond, 참 갈래, 거짓
  // 갈래]이고, 삼항에서 잎과 상수 피연산자, 아직 고르지 않은 갈래 자리는 undefined다. 삼항은 피연산자가 모두 잎이어도
  // 처음 셀 때 배열을 둔다. 입력이 없는 계산 식과 아직 세지 않은 인스턴스는 NO_INPUT_INSTANCES다. 처음 셀 때 빈 자리로
  // 만들어 두고 입력을 연결하는 대로 채운다 - 연결하던 중 throw해도 이미 연결한 입력은 여기 있어 반납할 때 놓인다.
  inputInstances: (number | undefined)[];
  // 계산 식이 셀 때 평가기에 넘기는 입력 값. inputValues[i]가 inputInstances[i]의 값이다. 입력이 없으면 NO_INPUT_VALUES다.
  // 처음 셀 때 한 번 만들고 셀 때마다 자리를 덮어쓴다.
  inputValues: unknown[];
  // 이 식 인스턴스를 입력으로 읽는 식 인스턴스. 한 식이 두 자리에서 읽으면(`x ? x : y`) 두 번 든다. 읽는 식이 없으면
  // null이다. heldByBranchCount가 0이고 이것도 비면 반납한다.
  outputInstances: number[] | null;
  // 연결한 입력 인스턴스 중 다시 세야 할 것이 있다. markOutputInstances가 켜고, 셀 때 지운다.
  inputMarked: boolean;
  // 삼항이 지금 고른 갈래의 inputInstances 자리(THEN_POSITION이나 ELSE_POSITION). 계산 식은 사용하지 않는다.
  chosenPosition: number;
};

// 다시 셀 식 인스턴스인가 - 읽는 leaf가 바뀌었거나 연결한 입력 인스턴스 중 다시 세야 할 것이 있다.
const needsRecount = (instance: TExprInstance): boolean => instance.pendingVarMask !== 0 || instance.inputMarked;

// 공유 맵에 없다는 뜻. 식 인스턴스 번호를 돌려주는 findShared가 쓴다.
export const NOT_SHARED = -1;

// 입력 식이 없는 식 인스턴스의 inputInstances. 인스턴스마다 빈 배열을 만들지 않고 이것을 함께 쓴다. 자리를 채우지
// 않는다 - 입력을 연결하기 전에 새 배열로 바꾼다.
const NO_INPUT_INSTANCES: (number | undefined)[] = [];

// 삼항 inputInstances의 자리.
const COND_POSITION = 0;
const THEN_POSITION = 1;
const ELSE_POSITION = 2;

// runExpr의 reads([leafIndex, 읽은 명령 위치, ...])에서 중복 없는 leafIndex 목록을 만든다. push로 채운 배열은 V8이
// 늘어날 몫까지 잡아 두므로(원소 하나를 push하면 용량이 17) 길이만큼의 사본을 돌려준다.
const uniqueLeavesOf = (reads: readonly number[]): number[] => {
  const leaves: number[] = [];
  for (let i = 0; i < reads.length; i += 2) {
    if (!leaves.includes(reads[i])) {
      leaves.push(reads[i]);
    }
  }
  return leaves.slice();
};

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
  // runPartial이 다시 세며 실행한 읽기 명령을 모으는 배열. 셀 때마다 배열을 만들지 않고 비우며 재사용한다.
  private partialReads: number[] = [];
  // 식 인스턴스 사이의 간선. 노드 번호는 식 인스턴스 번호다. pull이 incoming labeled edge로 평가할지 정한다.
  readonly graph = new ExprGraph();
  // flush 하나나 recountPending 하나에서 값이 바뀐 결과 leaf. 요청이 재귀로 평가하는 식 인스턴스도 여기에 더한다.
  // 둘 밖에서는 null이다.
  private changedResultLeaves: number[] | null = null;
  // 정적 그래프. globalExprIndex -> 식의 입력(decode.ts TModule.exprInputs)과 level(vm.ts exprLevels).
  private exprInputs: TExprInputs[];
  private exprLevels: number[];
  // 입력 식의 인스턴스를 둘 조상 scope를 찾는 부모 표. vm과 함께 쓴다.
  private scopeParentPool: TScopeParentPool;

  constructor(
    evaluator: ExprEvaluator,
    store: LeafStoreSubject,
    exprInputs: TExprInputs[],
    exprLevels: number[],
    scopeParentPool: TScopeParentPool,
  ) {
    this.evaluator = evaluator;
    this.store = store;
    this.exprInputs = exprInputs;
    this.exprLevels = exprLevels;
    this.scopeParentPool = scopeParentPool;
    store.setDeriveStage(this.flush);
  }

  // 식 인스턴스를 만든다. 아직 가지도 식도 붙들지 않았다 - 붙드는 쪽이 retainByBranch나 retainByExpr를 호출한다. 식은
  // 아직 세지 않았으며 구독도 걸지 않는다 - evaluate가 세고, subscribeInputs가 건다.
  //
  // cache는 건너뛸 부분식이 생길 수 있거나(mightSkip) READ_LEAF가 있는(hasIndexAccess) 계산 식만 둔다. READ_LEAF가
  // 있어도 주소가 잎 하나면(#A ReadLeaf, nums[pivot]) 건너뛸 것이 없는데, 구독을 옮기는 runPartial로 세려고 cache를
  // 둔다. 둘 다 없는 식(row.price - #R)과 삼항, 표가 없는 계산 식은 처음부터 센다. 같은 flush에서 읽는 leaf 여럿이
  // 바뀌어도 flush가 인스턴스당 한 번만 세므로 한 번이면 된다. 삼항은 평가기를 거치지 않아(evaluateTernary) 표를
  // 보지 않는다.
  create = (globalExprIndex: number, pairs: TScope, scopeUid: number): number => {
    const table =
      this.exprInputs[globalExprIndex].kind === "ternary" ? null : this.evaluator.skipTable(globalExprIndex);
    const instance: TExprInstance = {
      globalExprIndex,
      pairs,
      cache: table !== null && (table.mightSkip || table.hasIndexAccess) ? new Array(table.opCount) : null,
      readLeaves: [],
      lastValue: undefined,
      pendingVarMask: 0,
      resultLeaf: undefined,
      scopeUid,
      heldByBranchCount: 0,
      inputInstances: NO_INPUT_INSTANCES,
      inputValues: NO_INPUT_VALUES,
      outputInstances: null,
      inputMarked: false,
      chosenPosition: THEN_POSITION,
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
    for (const leafIndex of changed) {
      this.markReaders(leafIndex);
    }
    this.recountMarked(onError);
    const resultLeaves = this.changedResultLeaves;
    if (resultLeaves !== null) {
      this.flushResultLeafReaders(resultLeaves, onError);
    }
    this.changedResultLeaves = null;
    return resultLeaves;
  };

  // leafIndex를 파생 구독한 식 인스턴스마다 그 leaf가 바뀐 것을 표시한다.
  private markReaders = (leafIndex: number): void => {
    const derives = this.deriveSubscribers[leafIndex];
    if (derives === undefined) {
      return;
    }
    if (typeof derives === "number") {
      this.markChanged(derives, leafIndex);
    } else {
      for (const exprInstanceIndex of derives) {
        this.markChanged(exprInstanceIndex, leafIndex);
      }
    }
  };

  // 이번 flush에서 쓴 결과 leaf를 입력으로 읽는 식 인스턴스를 센다. 합성 인자로 넘긴 식의 결과를 자식 식이 읽으면 둘 사이에
  // 그래프 간선이 없어, flush가 받은 changed에 이 leaf가 없어 표시하지 못한다. 센 결과가 또 결과 leaf를 쓰면 resultLeaves
  // 뒤에 더해져 이어서 훑는다. 식의 의존은 순환이 없어 끝난다.
  private flushResultLeafReaders = (resultLeaves: number[], onError: (error: unknown) => void): void => {
    for (let scanned = 0; scanned < resultLeaves.length; ) {
      const roundEnd = resultLeaves.length;
      for (; scanned < roundEnd; scanned++) {
        this.markReaders(resultLeaves[scanned]);
      }
      this.recountMarked(onError);
    }
  };

  // recountExprInstanceIndices에 모인 식 인스턴스를 센다. 세고 나면 모음을 비운다.
  private recountMarked = (onError: (error: unknown) => void): void => {
    const { recountExprInstanceIndices } = this;
    const { graph } = this;
    for (const exprInstanceIndex of recountExprInstanceIndices) {
      const instance = this.pool.entries[exprInstanceIndex];
      // 입력으로만 쓰이는 인스턴스(가지가 들지 않음)는 그 값을 읽는 식 인스턴스가 셀 때 요청한다. 고르지 않은 갈래면
      // 요청하지 않아 세지 않는다.
      if (instance.heldByBranchCount === 0) {
        continue;
      }
      try {
        // incoming edge가 없는 인스턴스가 대부분이라 request를 거치지 않고 바로 평가한다. 앞선 request가 재귀로 이미
        // 평가했으면 다시 셀 인스턴스가 아니다.
        if (graph.incomingEdgesOfNode(exprInstanceIndex) !== undefined) {
          this.request(exprInstanceIndex);
        } else if (needsRecount(instance)) {
          this.recount(exprInstanceIndex);
        }
      } catch (error) {
        onError(error);
      }
    }
    recountExprInstanceIndices.length = 0;
  };

  // 식 인스턴스가 평가 대상이면 true를 돌려준다. incoming labeled edge가 있으면 시작점을 먼저 요청하고, 시작점이 평가
  // 대상이면서 그 값이 label과 맞는 간선이 하나라도 있어야 평가 대상이다. 평가 대상이고 다시 셀 인스턴스(needsRecount)면
  // 다시 평가한다. 평가 대상이 아니면 표시를 그대로 둔다 - 나중에 조건이 맞을 때 그 표시로 평가한다.
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
    if (needsRecount(instance)) {
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
    // NaN이 그대로면 바뀌지 않은 것이다. !==로 견주면 NaN끼리도 달라 셀 때마다 쓰고 통지한다.
    if (resultLeaf !== undefined && !Object.is(value, previous)) {
      this.store.write(resultLeaf, value);
      this.changedResultLeaves ??= [];
      this.changedResultLeaves.push(resultLeaf);
    }
  };

  // 식 인스턴스에 바뀐 leaf를 표시한다. readLeaves에서 leafIndex인 자리의 비트를 pendingVarMask에 켠다. 마스크가
  // 0이었으면 recountExprInstanceIndices에 넣고 그 값을 읽는 식 인스턴스로 표시를 올린다. 같은 leaf를 두 변수가
  // 읽으면(부모가 같은 칸을 두 prop으로 넘긴 경우) 두 비트를 켠다.
  //
  // inputMarked만 켜져 있던 인스턴스(cache가 없는 식)도 마스크가 0이라 목록에 다시 든다. 셀 때 표시를 지우므로
  // 두 번 세지 않고, 위로 올리는 표시도 이미 표시된 인스턴스에서 멈춘다.
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
      // 읽는 식이 없는 인스턴스가 대부분이다. 호출 전에 걸러 두면 V8이 flush에 markOutputInstances를 inline하지 않아,
      // flush의 inline 한도가 recount에 남는다.
      if (instance.outputInstances !== null) {
        this.markOutputInstances(exprInstanceIndex, instance.outputInstances);
      }
    }
  };

  // 식 인스턴스의 값을 활성 간선으로 읽는 식 인스턴스에 inputMarked를 켜고, 그 인스턴스의 outputInstances로 이어
  // 올린다. cache가 있는 계산 식이면 그 입력의 변수 비트도 pendingVarMask에 켜, 부분 재평가가 그 입력을 품지 않은
  // 부분식만 건너뛰게 한다. 비트는 이미 다시 셀 인스턴스에도 켠다 - 켜지 않으면 다른 변수만 바뀐 것으로 보고 이 입력을
  // 품은 부분식까지 건너뛴다. 이미 다시 셀 인스턴스면 그 위도 이미 표시되어 있어 더 올리지 않는다. 가지가 든
  // 인스턴스는 flush의 pull이 세도록 recountExprInstanceIndices에 넣는다.
  //   ok ? price * 2 : row.x 에서 price가 바뀌면 price * 2에서 ok가 true인 행의 삼항으로 올라간다. ok가 false인 행은
  //   price * 2를 고르지 않아 올라가지 않는다.
  private markOutputInstances = (exprInstanceIndex: number, outputInstances: readonly number[]): void => {
    for (const output of outputInstances) {
      const outputInstance = this.pool.entries[output];
      if (!this.readsActively(outputInstance, exprInstanceIndex)) {
        continue;
      }
      const alreadyMarked = needsRecount(outputInstance);
      if (outputInstance.cache !== null) {
        const table = this.evaluator.skipTable(outputInstance.globalExprIndex) as TExprSkipTable;
        const inputPosition = outputInstance.inputInstances.indexOf(exprInstanceIndex);
        outputInstance.pendingVarMask |= 1 << table.inputPositionToVarNumber[inputPosition];
      }
      if (alreadyMarked) {
        continue;
      }
      outputInstance.inputMarked = true;
      if (outputInstance.heldByBranchCount > 0) {
        this.recountExprInstanceIndices.push(output);
      }
      if (outputInstance.outputInstances !== null) {
        this.markOutputInstances(output, outputInstance.outputInstances);
      }
    }
  };

  // 식 인스턴스(output)가 입력 인스턴스(input)를 활성 간선으로 읽는가. 계산 식은 입력을 늘 읽고, 삼항은 cond와 지금
  // 고른 갈래만 읽는다.
  private readsActively = (output: TExprInstance, input: number): boolean =>
    this.exprInputs[output.globalExprIndex].kind !== "ternary" ||
    output.inputInstances[COND_POSITION] === input ||
    output.inputInstances[output.chosenPosition] === input;

  // 식을 다시 세어 값을 돌려주고 lastValue에 기록한다. store에 쓰지 않는다. 결과 leaf에는 늘 lastValue가 들어
  // 있으므로(처음 값은 evaluate가 센 값이다) 결과 leaf를 읽지 않고 lastValue로 바뀌었는지 가린다. 세기 전에
  // pendingVarMask를 0으로 지운다 - 식이 throw해도 마스크가 다음 flush로 남지 않는다.
  //
  // cache가 있는 계산 식은 runPartial이, 나머지는 runFromScratch가 센다.
  private run = (exprInstanceIndex: number): unknown => {
    if (this.pool.entries[exprInstanceIndex].cache !== null) {
      return this.runPartial(exprInstanceIndex);
    }
    return this.runFromScratch(exprInstanceIndex);
  };

  // cache가 없는 식을 처음부터 다시 센다. 세기 전에 pendingVarMask와 inputMarked를 지우고, 연결한 입력 인스턴스를 먼저
  // 요청해 이번 flush의 값으로 만든다. 식에 따라 셋으로 나뉜다.
  //   - 건너뛸 부분식도 READ_LEAF도 없는 계산 식: 읽는 leaf가 바뀌지 않아 읽기를 모으지 않고 센다.
  //   - 삼항: 갈래를 바꿨을 때만 구독을 옮긴다. 떠나는 갈래의 leaf 하나만 기억해 두면 된다 - 새 갈래의 leaf는 세고 나면
  //     readLeaves의 고른 자리에 있다.
  //   - 표가 없는 계산 식(변수가 32개를 넘는 식): READ_LEAF가 있는지 몰라 evaluate로 세고 옛 readLeaves와 새 readLeaves를
  //     견준다.
  private runFromScratch = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.pendingVarMask = 0;
    instance.inputMarked = false;
    const { globalExprIndex } = instance;
    const exprInputs = this.exprInputs[globalExprIndex];
    if (exprInputs.kind === "calc" && this.evaluator.skipTable(globalExprIndex) !== null) {
      if (exprInputs.inputs.length > 0) {
        this.linkCalcInputs(exprInstanceIndex, exprInputs.inputs);
      }
      const expr = this.evaluator.exprBytes[globalExprIndex];
      instance.lastValue = this.evaluator.runExpr(
        expr,
        instance.pairs,
        null,
        null,
        SKIP_NOTHING,
        null,
        instance.inputValues,
      );
      return instance.lastValue;
    }
    if (exprInputs.kind === "ternary") {
      const previousChosenPosition = instance.chosenPosition;
      const leavingLeaf = instance.readLeaves[previousChosenPosition];
      const value = this.evaluate(exprInstanceIndex);
      if (instance.chosenPosition !== previousChosenPosition) {
        this.resubscribeBranchLeaf(exprInstanceIndex, leavingLeaf);
      }
      return value;
    }
    const previousReadLeaves = instance.readLeaves;
    const value = this.evaluate(exprInstanceIndex);
    this.resubscribeChangedLeaves(exprInstanceIndex, previousReadLeaves);
    return value;
  };

  // 식을 처음부터 세어 값을 돌려주고, 읽은 leaf(readLeaves)와 값(lastValue)을 인스턴스에 기록한다. 몇 번을 불러도
  // 같은 결과다. 구독을 건 채로 부르지 않는다 - 구독 대상(readLeaves)이 바뀌는데 구독은 그대로다. 구독을 건 뒤 다시
  // 셀 때는 run이 부르고 구독을 옮긴다.
  //
  // 입력이 있는 식은 정적 그래프(exprInputs)를 따라 입력 식의 인스턴스를 처음 셀 때 연결한다. 이미 연결한 입력
  // 인스턴스는 요청해(request) 다시 셀 인스턴스면 먼저 센다. 삼항은 cond를 센 뒤 고른 갈래만 연결하거나 요청하고,
  // 계산 식은 입력을 모두 연결하거나 요청해 그 값을 inputValues로 평가기에 넘긴다.
  evaluate = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { globalExprIndex, pairs, cache } = instance;
    const exprInputs = this.exprInputs[globalExprIndex];
    if (exprInputs.kind === "ternary") {
      instance.lastValue = this.evaluateTernary(exprInstanceIndex, exprInputs);
      return instance.lastValue;
    }
    if (exprInputs.inputs.length > 0) {
      this.linkCalcInputs(exprInstanceIndex, exprInputs.inputs);
    }
    const expr = this.evaluator.exprBytes[globalExprIndex];
    let value: unknown;
    if (cache === null) {
      const reads: number[] = [];
      value = this.evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, reads, instance.inputValues);
      instance.readLeaves = uniqueLeavesOf(reads);
    } else {
      const table = this.evaluator.skipTable(globalExprIndex) as TExprSkipTable;
      const evaluated = this.evaluator.evalExpr(expr, pairs, table, cache, instance.inputValues);
      value = evaluated.value;
      instance.readLeaves = evaluated.varNumberToLeafIndex;
    }
    instance.lastValue = value;
    return value;
  };

  // 방금 만든 식 인스턴스를 처음 센다. throw하면 인스턴스와 그때까지 연결한 입력 인스턴스를 반납하고 다시 throw한다.
  // 아직 아무도 붙들지 않아 남겨 두면 반납되지 않고, 공유 맵에 올린 뒤라면 다음에 찾은 쪽이 세지 않은 값을 읽는다.
  // 그래서 공유 맵에는 센 뒤에 올린다.
  evaluateOrFree = (exprInstanceIndex: number): unknown => {
    try {
      return this.evaluate(exprInstanceIndex);
    } catch (error) {
      this.freeIfUnheld(exprInstanceIndex);
      throw error;
    }
  };

  // 계산 식의 입력 식 인스턴스를 처음 셀 때 한 번 연결하고, 그 뒤로는 셀 때마다 요청한다. 셀 때마다 그 값을
  // inputValues에 담는다.
  //   #1 = base - #0, inputs [0]이면 inputInstances [#0의 인스턴스], inputValues [#0의 값]
  private linkCalcInputs = (exprInstanceIndex: number, inputs: readonly number[]): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    if (instance.inputInstances === NO_INPUT_INSTANCES) {
      instance.inputInstances = inputs.map(() => undefined);
      instance.inputValues = inputs.map(() => undefined);
    }
    const linked = instance.inputInstances;
    const values = instance.inputValues;
    for (let i = 0; i < inputs.length; i++) {
      linked[i] = this.requestOrLinkInput(exprInstanceIndex, inputs[i], linked[i]);
      values[i] = this.pool.entries[linked[i] as number].lastValue;
    }
  };

  // 삼항을 센다. cond를 읽고, cond 값으로 고른 갈래만 읽는다. 식인 cond와 식인 갈래는 처음 읽을 때 인스턴스를
  // 연결하고 그 뒤로는 요청하며, 고르지 않은 갈래는 연결하지도 요청하지도 않는다. 잎인 cond와 고른 잎 갈래는
  // readLeaves의 제 자리에 leafIndex를 기록해 구독 대상으로 두고, 고르지 않은 갈래의 자리는 -1로 둔다.
  //   ok ? price * 2 : row.x 에서 ok가 true면 inputInstances [undefined, price * 2의 인스턴스, undefined],
  //   readLeaves [ok의 leaf, -1, -1]
  private evaluateTernary = (
    exprInstanceIndex: number,
    exprInputs: Extract<TExprInputs, { kind: "ternary" }>,
  ): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    // 피연산자가 모두 잎이어도 처음 셀 때 배열을 둔다. run이 NO_INPUT_INSTANCES인지만 보고 입력이 있는 식을 가린다.
    if (instance.inputInstances === NO_INPUT_INSTANCES) {
      instance.inputInstances = [undefined, undefined, undefined];
      instance.readLeaves = [-1, -1, -1];
    }
    const linked = instance.inputInstances;
    linked[COND_POSITION] = this.requestOrLinkOperand(exprInstanceIndex, exprInputs.cond, linked[COND_POSITION]);
    const cond = this.readOperand(instance, exprInputs.cond, linked[COND_POSITION], COND_POSITION);
    const chosenPosition = cond ? THEN_POSITION : ELSE_POSITION;
    const branch = cond ? exprInputs.thenBranch : exprInputs.elseBranch;
    linked[chosenPosition] = this.requestOrLinkOperand(exprInstanceIndex, branch, linked[chosenPosition]);
    const value = this.readOperand(instance, branch, linked[chosenPosition], chosenPosition);
    instance.readLeaves[chosenPosition === THEN_POSITION ? ELSE_POSITION : THEN_POSITION] = -1;
    instance.chosenPosition = chosenPosition;
    return value;
  };

  // 삼항 피연산자가 식이면 requestOrLinkInput으로 그 인스턴스 번호를 돌려준다. 잎이나 상수면 undefined.
  private requestOrLinkOperand = (
    exprInstanceIndex: number,
    operand: TRef,
    linkedInstance: number | undefined,
  ): number | undefined =>
    operand.tag === FV_EXPR ? this.requestOrLinkInput(exprInstanceIndex, operand.ref, linkedInstance) : undefined;

  // 입력 식의 인스턴스 번호를 돌려준다. 이미 연결했으면(linkedInstance) 요청해 다시 셀 인스턴스면 세고, 아직이면
  // 연결한다.
  private requestOrLinkInput = (
    exprInstanceIndex: number,
    inputGlobalExprIndex: number,
    linkedInstance: number | undefined,
  ): number => {
    if (linkedInstance !== undefined) {
      this.request(linkedInstance);
      return linkedInstance;
    }
    return this.linkInputInstance(exprInstanceIndex, inputGlobalExprIndex);
  };

  // 삼항 피연산자의 값. 상수는 상수풀, 식은 연결한 인스턴스의 값, 잎은 슬롯의 값이다. 잎이면 그 leafIndex(store
  // leaf가 아니면 -1)를 readLeaves[position]에 기록한다.
  private readOperand = (
    instance: TExprInstance,
    operand: TRef,
    operandInstance: number | undefined,
    position: number,
  ): unknown => {
    if (operand.tag === FV_CONST) {
      return this.evaluator.constpool[operand.ref];
    }
    if (operand.tag === FV_EXPR) {
      return this.pool.entries[operandInstance as number].lastValue;
    }
    const { pairs } = instance;
    instance.readLeaves[position] = this.evaluator.slotLeafIndex(pairs, operand.ref, operand.offset);
    return this.evaluator.slotValue(pairs, operand.ref, operand.offset, 0, null);
  };

  // 식 인스턴스(소비자)가 입력 식(inputGlobalExprIndex)의 인스턴스를 연결한다. 입력 인스턴스는 입력 식의 level 깊이
  // scope에 있고, 그 scope는 소비자 scope에서 부모를 (소비자 level - 입력 level)번 올라가 얻는다. 그 (식, scope)로
  // 공유 중이면 요청해(쉬는 동안 표시가 남았으면 센다) 재사용하고, 없으면 만들어 세고 공유 맵에 올리고 구독을 건다.
  // 어느 쪽이든 retainByExpr로 붙든다.
  //   @for (row of rows) { ${ok ? price * 2 : row.x} }에서 행의 삼항(level 1)이 price * 2(level 0)를 연결하면
  //   행 scope에서 한 번 올라간 root scope의 인스턴스 하나를 모든 행이 함께 쓴다.
  private linkInputInstance = (exprInstanceIndex: number, inputGlobalExprIndex: number): number => {
    const { globalExprIndex, scopeUid, pairs } = this.pool.entries[exprInstanceIndex];
    const inputScopeUid = ancestorScopeUid(
      this.scopeParentPool,
      scopeUid,
      this.exprLevels[globalExprIndex] - this.exprLevels[inputGlobalExprIndex],
    );
    let input = this.findShared(inputGlobalExprIndex, inputScopeUid);
    if (input === NOT_SHARED) {
      input = this.create(inputGlobalExprIndex, pairs, inputScopeUid);
      this.evaluateOrFree(input);
      this.markShared(input);
      this.subscribeInputs(input);
    } else {
      this.request(input);
    }
    this.retainByExpr(input, exprInstanceIndex);
    return input;
  };

  // 식(globalExprIndex)을 인스턴스 없이 pairs로 한 번 센다. 구독하지 않고 store에 쓰지 않는다. 삼항은 cond를 센 뒤
  // 고른 갈래만 세고, 입력이 있는 계산 식은 입력 식을 먼저 같은 방식으로 세어 inputValues로 넘긴다. 발화 때 payload와
  // context 값을 낼 때 VM이 호출한다 - 그 값은 발화 순간 한 번만 필요해 구독으로 최신을 유지하지 않는다.
  //   n - (open ? n : 0) 에서 open이 false면 삼항이 거짓 갈래 0을 내고, 계산 식이 inputValues [0]으로 n - 0을 센다.
  evaluateOnce = (globalExprIndex: number, pairs: TScope): unknown => {
    const exprInputs = this.exprInputs[globalExprIndex];
    if (exprInputs.kind === "ternary") {
      const cond = this.readOperandOnce(exprInputs.cond, pairs);
      return this.readOperandOnce(cond ? exprInputs.thenBranch : exprInputs.elseBranch, pairs);
    }
    const inputValues =
      exprInputs.inputs.length === 0
        ? NO_INPUT_VALUES
        : exprInputs.inputs.map((input) => this.evaluateOnce(input, pairs));
    const expr = this.evaluator.exprBytes[globalExprIndex];
    return this.evaluator.runExpr(expr, pairs, null, null, SKIP_NOTHING, null, inputValues);
  };

  // evaluateOnce가 삼항 피연산자의 값을 낸다. 상수는 상수풀, 식은 evaluateOnce로 센 값, 잎은 슬롯의 값이다.
  private readOperandOnce = (operand: TRef, pairs: TScope): unknown => {
    if (operand.tag === FV_CONST) {
      return this.evaluator.constpool[operand.ref];
    }
    if (operand.tag === FV_EXPR) {
      return this.evaluateOnce(operand.ref, pairs);
    }
    return this.evaluator.slotValue(pairs, operand.ref, operand.offset, 0, null);
  };

  // 식 인스턴스의 직전 값. 공유 중인 인스턴스를 찾은 VM이 읽는다 - 입력으로만 쓰이던 인스턴스는 결과 leaf가 없다.
  valueOf = (exprInstanceIndex: number): unknown => this.pool.entries[exprInstanceIndex].lastValue;

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

  // 식 인스턴스(exprInstanceIndex)의 outputInstances에 그 값을 읽는 식 인스턴스(outputExprInstanceIndex)를 더한다.
  retainByExpr = (exprInstanceIndex: number, outputExprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    instance.outputInstances ??= [];
    instance.outputInstances.push(outputExprInstanceIndex);
  };

  // outputInstances에서 outputExprInstanceIndex 하나를 빼고, 가지도 들지 않으면 반납한다(freeIfUnheld). 뺀 자리에는
  // 맨 끝 번호를 옮긴다 - 순서는 보지 않는다.
  releaseByExpr = (exprInstanceIndex: number, outputExprInstanceIndex: number): void => {
    const outputs = this.pool.entries[exprInstanceIndex].outputInstances as number[];
    outputs[outputs.indexOf(outputExprInstanceIndex)] = outputs[outputs.length - 1];
    outputs.pop();
    this.freeIfUnheld(exprInstanceIndex);
  };

  // 가지도 식도 붙들지 않으면 파생 구독을 풀고 공유 키, 결과 leaf, 풀 번호를 반납한다. 연결한 입력 식의 인스턴스는
  // releaseByExpr로 놓아, 그 인스턴스를 읽는 다른 식도 없으면 함께 반납된다.
  private freeIfUnheld = (exprInstanceIndex: number): void => {
    const instance = this.pool.entries[exprInstanceIndex];
    if (instance.heldByBranchCount > 0 || (instance.outputInstances?.length ?? 0) > 0) {
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
    for (const input of instance.inputInstances) {
      if (input !== undefined) {
        this.releaseByExpr(input, exprInstanceIndex);
      }
    }
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
  // 건너뛸 부분식이 없는 식은 앞 검사를 하지 않는다. 계산 식은 evaluate가 중복 없이 채우고, 삼항은 같은 leaf가 두
  // 자리에 들 수 있지만(`ok ? ok : x`) 같은 인스턴스를 두 번 구독하거나 풀어도 결과가 같다.
  private isInputLeaf = (instance: TExprInstance, readLeafPosition: number): boolean => {
    const { readLeaves } = instance;
    return (
      readLeaves[readLeafPosition] >= 0 &&
      (instance.cache === null || readLeaves.indexOf(readLeaves[readLeafPosition]) === readLeafPosition)
    );
  };

  // cache가 있는 계산 식을 다시 센다. pendingVarMask에 든 바뀐 변수(leaf와 입력) 전체로 건너뛰기 표를 골라 한꺼번에
  // 센다. 변수마다 따로 세면 먼저 센 쪽이 다른 부분식의 cache에 든 옛 값을 섞어 쓴다. 입력이 있으면 세기 전에 연결한
  // 입력 인스턴스를 요청해 inputValues를 이번 flush의 값으로 만든다. READ_LEAF가 있는 식(hasIndexAccess)만 다시 세며
  // 실행한 읽기 명령을 모아, 지난번과 다른 leaf를 읽었으면 구독을 옮긴다(resubscribeMovedLeaves). 다른 식은 읽는
  // leaf가 바뀌지 않아 모으지 않는다 - 모으면 slotValue가 읽을 때마다 push해 다시 세기가 느려진다.
  private runPartial = (exprInstanceIndex: number): unknown => {
    const instance = this.pool.entries[exprInstanceIndex];
    const { globalExprIndex, pairs } = instance;
    const expr = this.evaluator.exprBytes[globalExprIndex];
    const table = this.evaluator.skipTable(globalExprIndex) as TExprSkipTable;
    const cache = instance.cache as unknown[];
    const changedVarMask = instance.pendingVarMask;
    instance.pendingVarMask = 0;
    instance.inputMarked = false;
    if (instance.inputInstances !== NO_INPUT_INSTANCES) {
      const { inputs } = this.exprInputs[globalExprIndex] as Extract<TExprInputs, { kind: "calc" }>;
      this.linkCalcInputs(exprInstanceIndex, inputs);
    }
    // 변수 하나만 바뀌면 식 정의가 공유하는 표를 쓴다. 둘 이상이면 그 변수들을 모두 품지 않은 부분식의
    // 표를 만든다(부모가 같은 칸을 두 prop으로 넘긴 경우도 여기다).
    const skipPastOps =
      (changedVarMask & (changedVarMask - 1)) === 0
        ? table.varNumberToSkipPastOps[31 - Math.clz32(changedVarMask)]
        : buildSkipPastOpsOfVars(table, expr, changedVarMask);
    if (!table.hasIndexAccess) {
      instance.lastValue = this.evaluator.reevalExpr(
        expr,
        pairs,
        table,
        cache,
        skipPastOps,
        null,
        instance.inputValues,
      );
      return instance.lastValue;
    }
    // 입력을 요청하다 다른 인스턴스의 runPartial이 이 배열을 사용했을 수 있어, 입력을 요청한 뒤에 비운다.
    const reads = this.partialReads;
    reads.length = 0;
    const value = this.evaluator.reevalExpr(expr, pairs, table, cache, skipPastOps, reads, instance.inputValues);
    instance.lastValue = value;
    this.resubscribeMovedLeaves(exprInstanceIndex, table, reads);
    return value;
  };

  // 다시 세며 실행한 읽기 명령(reads의 [leafIndex, 명령 위치, ...])마다 그 변수가 지난번에 읽은 leaf(readLeaves)와
  // 견주어, 다르면 readLeaves를 고치고 구독을 옮긴다. 옛 leaf는 다른 변수도 읽지 않을 때만 풀고, 새 leaf는 건다 - 같은
  // 인스턴스를 두 번 걸어도 하나다. 건너뛴 부분식 안의 명령은 실행되지 않아 reads에 없고, 읽는 leaf도 그대로다.
  //   rows[pivot].price의 값 읽기 식에서 pivot이 0 -> 1이면 READ_LEAF가 읽는 leaf가 40에서 43이 되어 40을 풀고 43에 건다.
  private resubscribeMovedLeaves = (
    exprInstanceIndex: number,
    table: TExprSkipTable,
    reads: readonly number[],
  ): void => {
    const { readLeaves } = this.pool.entries[exprInstanceIndex];
    for (let i = 0; i < reads.length; i += 2) {
      const leafIndex = reads[i];
      const varNumber = table.instrPosToVarNumber[reads[i + 1]];
      const previous = readLeaves[varNumber];
      if (previous === leafIndex) {
        continue;
      }
      readLeaves[varNumber] = leafIndex;
      if (previous >= 0 && !readLeaves.includes(previous)) {
        this.unsubscribeDerive(previous, exprInstanceIndex);
      }
      this.subscribeDerive(leafIndex, exprInstanceIndex);
    }
  };

  // 삼항이 다른 갈래를 고른 뒤 갈래 leaf의 구독을 옮긴다. 떠나는 갈래의 leaf(leavingLeaf)는 구독을 풀고 새로 고른
  // 갈래의 leaf는 구독한다. 잎이 아닌 갈래는 -1이라 건너뛴다. cond와 같은 leaf는 계속 읽으므로 풀지도 다시 걸지도
  // 않고(`ok ? ok : x`), 두 갈래가 같은 leaf면 그대로 둔다.
  //   ok ? price : 0 에서 ok가 false -> true면 readLeaves [ok, -1, -1]이 [ok, price, -1]이 되어 price를 구독한다.
  private resubscribeBranchLeaf = (exprInstanceIndex: number, leavingLeaf: number): void => {
    const { readLeaves, chosenPosition } = this.pool.entries[exprInstanceIndex];
    const condLeaf = readLeaves[COND_POSITION];
    const chosenLeaf = readLeaves[chosenPosition];
    if (leavingLeaf >= 0 && leavingLeaf !== condLeaf && leavingLeaf !== chosenLeaf) {
      this.unsubscribeDerive(leavingLeaf, exprInstanceIndex);
    }
    if (chosenLeaf >= 0 && chosenLeaf !== condLeaf && chosenLeaf !== leavingLeaf) {
      this.subscribeDerive(chosenLeaf, exprInstanceIndex);
    }
  };

  // 표가 없는 계산 식을 처음부터 다시 센 뒤 읽는 leaf가 달라졌으면 구독을 옮긴다. 옛 readLeaves에만 있는 leaf는
  // 구독을 풀고 새 readLeaves에만 있는 leaf는 구독한다.
  private resubscribeChangedLeaves = (exprInstanceIndex: number, previousReadLeaves: number[]): void => {
    const { readLeaves } = this.pool.entries[exprInstanceIndex];
    for (const leafIndex of previousReadLeaves) {
      if (leafIndex >= 0 && !readLeaves.includes(leafIndex)) {
        this.unsubscribeDerive(leafIndex, exprInstanceIndex);
      }
    }
    for (const leafIndex of readLeaves) {
      if (leafIndex >= 0 && !previousReadLeaves.includes(leafIndex)) {
        this.subscribeDerive(leafIndex, exprInstanceIndex);
      }
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
