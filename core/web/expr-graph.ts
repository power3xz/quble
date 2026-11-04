// 식 인스턴스 의존 그래프 - 노드는 식 인스턴스 번호다. 간선 A -> B는 B를 평가하기 전에 A를 먼저 확정해야 한다는
// 뜻이다. 간선은 간선 표에 한 번만 두고(시작점, 끝점, label), 노드에는 incoming edge와 outgoing edge의 간선 번호만
// 기록한다. label이 한 곳에만 있어 양쪽 기록이 어긋나지 않는다.
//
// label은 고르기를 나타낸다. `@if (c) { ${x} }`면 `[c] --(then)--> [x]`이고, flush의 pull은 c의 값이 then과 맞을
// 때만 x를 평가한다.

import { IdPool } from "./pool-allocator.ts";

// c가 truthy일 때 끝점을 평가한다.
export const LABEL_THEN = -1;
// c가 falsy일 때 끝점을 평가한다.
export const LABEL_ELSE = -2;
// 0 이상은 개수 @for의 행 번호 k다. k < c일 때 끝점을 평가한다.

export type TEdgeId = number & { readonly __edgeId: unique symbol };

export class ExprGraph {
  // 간선 표. 간선 번호를 인덱스로 하는 배열 셋이다.
  private edgeIds = new IdPool<TEdgeId>();
  private startNodes: number[] = [];
  private endNodes: number[] = [];
  private labels: number[] = [];
  // 노드 번호 -> 그 노드의 간선 번호들. 간선이 없는 노드는 undefined다.
  private incomingEdges: Array<TEdgeId[] | undefined> = [];
  private outgoingEdges: Array<TEdgeId[] | undefined> = [];

  addEdge = (startNode: number, endNode: number, label: number): void => {
    const edge = this.edgeIds.alloc();
    this.startNodes[edge] = startNode;
    this.endNodes[edge] = endNode;
    this.labels[edge] = label;
    addToList(this.outgoingEdges, startNode, edge);
    addToList(this.incomingEdges, endNode, edge);
  };

  // 식 인스턴스를 해제할 때 그 노드의 incoming edge와 outgoing edge를 모두 지운다. 상대 노드의 목록에서도 뺀다.
  removeEdgesOfNode = (node: number): void => {
    const incoming = this.incomingEdges[node];
    if (incoming !== undefined) {
      for (const edge of incoming) {
        removeFromList(this.outgoingEdges, this.startNodes[edge], edge);
        this.edgeIds.release(edge);
      }
      this.incomingEdges[node] = undefined;
    }
    const outgoing = this.outgoingEdges[node];
    if (outgoing !== undefined) {
      for (const edge of outgoing) {
        removeFromList(this.incomingEdges, this.endNodes[edge], edge);
        this.edgeIds.release(edge);
      }
      this.outgoingEdges[node] = undefined;
    }
  };

  incomingEdgesOfNode = (node: number): readonly TEdgeId[] | undefined => this.incomingEdges[node];

  outgoingEdgesOfNode = (node: number): readonly TEdgeId[] | undefined => this.outgoingEdges[node];

  startNodeOfEdge = (edge: TEdgeId): number => this.startNodes[edge];

  endNodeOfEdge = (edge: TEdgeId): number => this.endNodes[edge];

  labelOfEdge = (edge: TEdgeId): number => this.labels[edge];

  clear = (): void => {
    this.edgeIds.clear();
    this.startNodes.length = 0;
    this.endNodes.length = 0;
    this.labels.length = 0;
    this.incomingEdges.length = 0;
    this.outgoingEdges.length = 0;
  };
}

const addToList = (lists: Array<TEdgeId[] | undefined>, node: number, edge: TEdgeId): void => {
  const list = lists[node];
  if (list === undefined) {
    lists[node] = [edge];
  } else {
    list.push(edge);
  }
};

// 목록에서 간선을 빼고, 목록이 비면 undefined로 되돌린다. 뒤에서부터 찾는다 - 개수 @for는 행을 꼬리부터 지우므로
// 지울 간선이 늘 목록 끝에 있어, 찾기와 splice가 바로 끝난다.
const removeFromList = (lists: Array<TEdgeId[] | undefined>, node: number, edge: TEdgeId): void => {
  const list = lists[node] as TEdgeId[];
  list.splice(list.lastIndexOf(edge), 1);
  if (list.length === 0) {
    lists[node] = undefined;
  }
};
