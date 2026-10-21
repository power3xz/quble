// i번째를 뺀다. 빈자리에는 마지막 원소를 옮겨 오므로 순서가 바뀐다.
// [a, b, c, d]에서 swapDeleteAt(_, 1)이면 [a, d, c]
//
// 순서를 유지해야 하는 배열에는 쓰지 않는다. 예를 들어 elemStartLeafIndices는 순서가 곧 요소의
// 인덱스라 이것으로 지우면 rows[1]이 다른 요소를 가리킨다. 순서가 무의미하고 찾을 때 indexOf만 쓰는
// 배열에만 쓴다. 같은 자리 번호로 짝지은 배열 여럿(가지의 leafIndices와 updateFns처럼)은 모두 같은 i로
// 지워야 짝이 유지된다.
//
// splice(i, 1)는 뺀 원소를 담은 배열을 매번 새로 만들고 뒤를 당긴다. 이것은 원소 하나만 옮기고
// 아무것도 만들지 않는다.
export const swapDeleteAt = (items: unknown[], i: number): void => {
  items[i] = items[items.length - 1];
  items.pop();
};
