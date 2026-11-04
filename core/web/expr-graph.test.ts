// 식 인스턴스 의존 그래프의 간선 표 - 간선 하나를 양 끝 노드에서 같은 시작점, 끝점, label로 읽고, 간선을 지우면 그
// 간선만 양 끝 노드의 목록에서 빠진다.
//
// 지우는 테스트는 지우기 전에 간선이 있는 것을 먼저 확인한다. 그래야 지운 뒤에 없는 것이 지워서 없어진 것이다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprGraph, LABEL_ELSE, LABEL_THEN } from "./expr-graph.ts";

// 노드의 incoming edge를 [시작점, label] 목록으로 읽는다. 간선이 없으면 undefined다.
const incomingOf = (graph: ExprGraph, node: number) =>
  graph.incomingEdgesOfNode(node)?.map((edge) => [graph.startNodeOfEdge(edge), graph.labelOfEdge(edge)]);

// 노드의 outgoing edge를 [끝점, label] 목록으로 읽는다. 간선이 없으면 undefined다.
const outgoingOf = (graph: ExprGraph, node: number) =>
  graph.outgoingEdgesOfNode(node)?.map((edge) => [graph.endNodeOfEdge(edge), graph.labelOfEdge(edge)]);

test("간선을 더하면 끝점의 incoming edge와 시작점의 outgoing edge가 같은 간선을 가리킨다", () => {
  const graph = new ExprGraph();
  graph.addEdge(0, 1, LABEL_THEN);

  assert.deepEqual(graph.incomingEdgesOfNode(1), graph.outgoingEdgesOfNode(0));
  assert.deepEqual(incomingOf(graph, 1), [[0, LABEL_THEN]]);
  assert.deepEqual(outgoingOf(graph, 0), [[1, LABEL_THEN]]);
  assert.equal(graph.incomingEdgesOfNode(0), undefined, "시작점에는 incoming edge가 없다");
  assert.equal(graph.outgoingEdgesOfNode(1), undefined, "끝점에는 outgoing edge가 없다");
});

test("간선을 지우면 그 간선만 끝점의 incoming edge와 시작점의 outgoing edge에서 빠진다", () => {
  const graph = new ExprGraph();
  graph.addEdge(0, 1, LABEL_THEN);
  graph.addEdge(2, 1, LABEL_ELSE);
  graph.addEdge(0, 3, LABEL_THEN);
  assert.deepEqual(incomingOf(graph, 1), [
    [0, LABEL_THEN],
    [2, LABEL_ELSE],
  ]);
  assert.deepEqual(outgoingOf(graph, 0), [
    [1, LABEL_THEN],
    [3, LABEL_THEN],
  ]);

  graph.removeEdge(0, 1, LABEL_THEN);

  assert.deepEqual(incomingOf(graph, 1), [[2, LABEL_ELSE]], "2 -> 1은 남는다");
  assert.deepEqual(outgoingOf(graph, 0), [[3, LABEL_THEN]], "0 -> 3은 남는다");
});

test("시작점과 끝점이 같은 간선이 둘이면 label이 같은 간선만 지운다", () => {
  // `@if (c) { ${x} } @else { ${x} }`에서 두 가지가 x를 공유하면 c -> x 간선이 then과 else로 둘이다.
  const graph = new ExprGraph();
  graph.addEdge(0, 1, LABEL_THEN);
  graph.addEdge(0, 1, LABEL_ELSE);
  assert.deepEqual(incomingOf(graph, 1), [
    [0, LABEL_THEN],
    [0, LABEL_ELSE],
  ]);

  graph.removeEdge(0, 1, LABEL_ELSE);

  assert.deepEqual(incomingOf(graph, 1), [[0, LABEL_THEN]]);
  assert.deepEqual(outgoingOf(graph, 0), [[1, LABEL_THEN]]);
});

test("노드의 마지막 간선을 지우면 그 노드의 간선 목록이 undefined가 된다", () => {
  const graph = new ExprGraph();
  graph.addEdge(0, 1, LABEL_THEN);
  assert.deepEqual(incomingOf(graph, 1), [[0, LABEL_THEN]]);

  graph.removeEdge(0, 1, LABEL_THEN);

  assert.equal(graph.incomingEdgesOfNode(1), undefined);
  assert.equal(graph.outgoingEdgesOfNode(0), undefined);
});
