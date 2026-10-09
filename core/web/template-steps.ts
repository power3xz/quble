// 템플릿 뼈대에서 값 자리 사이를 가는 걸음. cloneTemplate가 복제본 위의 커서를 이 걸음대로 움직여 값 자리 노드를 찾는다.

export const STEP_FIRST_CHILD = 1;
export const STEP_NEXT_SIBLING = 2;
export const STEP_PARENT = 3;

// root 아래를 앞순회한 순서로 모은다 - 노드 번호의 정의다.
const preorder = (root: Node): Node[] => {
  const nodes: Node[] = [];
  const visit = (parent: Node): void => {
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      nodes.push(child);
      visit(child);
    }
  };
  visit(root);
  return nodes;
};

// 뼈대 root를 앞순회했을 때, 앞 값 자리 노드에서 다음 값 자리 노드까지 가는 걸음 열을 값 자리마다 구한다.
// holeNodeNumbers는 앞순회 노드 번호의 비감소 열(같은 요소의 속성 여러 개는 같은 번호), 첫 걸음은 root에서 시작한다.
// 노드 번호가 -1인 자리는 걸음이 비어 있다. 반환: holeNodeNumbers와 같은 길이, 각 원소가 그 자리의 걸음 열.
//
// 커서에서 목표로 가는 법: 커서가 목표를 품고 있지 않으면 부모가 목표를 품을 때까지 위로 나가고,
// 형제를 건너 목표를 품은 노드에 닿은 뒤, 목표에 닿을 때까지 firstChild와 nextSibling으로 내려간다.
export const stepsToEachHole = (root: Node, holeNodeNumbers: number[]): number[][] => {
  const nodes = preorder(root);
  let cursor: Node = root;
  return holeNodeNumbers.map((number) => {
    const steps: number[] = [];
    if (number < 0) {
      return steps;
    }
    const target = nodes[number];
    if (!cursor.contains(target)) {
      while (!(cursor.parentNode as Node).contains(target)) {
        steps.push(STEP_PARENT);
        cursor = cursor.parentNode as Node;
      }
      while (!cursor.contains(target)) {
        steps.push(STEP_NEXT_SIBLING);
        cursor = cursor.nextSibling as Node;
      }
    }
    while (cursor !== target) {
      steps.push(STEP_FIRST_CHILD);
      cursor = cursor.firstChild as Node;
      while (!cursor.contains(target)) {
        steps.push(STEP_NEXT_SIBLING);
        cursor = cursor.nextSibling as Node;
      }
    }
    return steps;
  });
};
