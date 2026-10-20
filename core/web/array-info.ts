import type { Pool } from "./pool-allocator.ts";

// @for가 순회하는 배열 하나의 요소 위치. elemSize = 요소 하나가 차지하는 leaf 수(스칼라 1, 객체는
// 필드 수) - 요소 안은 시작에서 이만큼 연속. elemStartLeafIndices[i] = i번째 요소의 시작 leafIndex -
// 요소가 흩어져 할당돼 연속을 못 믿으므로 회차마다 시작을 명시로 든다(요소 사이는 리스트, 요소
// 안은 elemSize 산술). 요소 추가/제거 시 이 목록으로 유지/회수 대상을 가른다.
export type TArrayInfo = {
  elemSize: number;
  elemTypeRef: number; // 요소 하나의 타입 - 요소 추가(push)가 값을 이 타입대로 store에 펴 심는다.
  elemStartLeafIndices: number[];
  indexLeafIndices: number[]; // elemStartLeafIndices와 나란한 요소별 인덱스 leaf - [i]=i번째 요소의 회차 번호를 담은 store 칸. 몸체 ${i}/$0가 이 leaf를 읽어, 중간 제거(removeAt) 시 뒤 칸을 set으로 당기면 자동 갱신된다(값 고정/위치 이동 설계의 인덱스 반응성). @for 순회될 때만 lazy로 채운다(sizeLeafIndex와 같은 결). count-for는 중간 제거가 없어(꼬리만) 이걸 안 쓴다.
  sizeLeafIndex: number | null; // 이 배열이 @for 순회 대상이 되면(그때만) 요소 수를 담는 store 칸을 lazy 확보 - 그 칸 구독이 grow/shrink 발화. @for에 안 쓰이면 null(길이 칸 낭비 없음).
  forRegionIndices: number[]; // 이 배열을 순회하는 @for region들. 요소 중간 제거(removeAt)가 이들 각각의 i번째 회차 DOM을 뗀다 - 하나만 들면 나중 @for가 앞의 것을 덮어써 한쪽만 정확히 떨어지고 나머지는 길이 칸 구독이 꼬리를 잘라 다른 요소가 사라진다. @for에 안 쓰이면 빈 배열(뗄 DOM 없음). 인덱스 칸(indexLeafIndices)은 자리 번호라 @for가 여럿이어도 같은 값이므로 배열이 그대로 소유하고 회차들이 함께 구독한다.
};

// arrayPool에 빈 배열정보를 alloc하고 그 arrayInfoIndex를 돌려준다.
export const appendArrayInfo = (arrayPool: Pool<TArrayInfo>, elemSize: number, elemTypeRef: number): number =>
  arrayPool.alloc({
    elemSize,
    elemTypeRef,
    elemStartLeafIndices: [],
    indexLeafIndices: [],
    sizeLeafIndex: null,
    forRegionIndices: [],
  });

// arrayPool의 arrayInfo 칸을 반납한다 - 요소 제거(removeAt)가 중첩 배열을 재귀 회수할 때 그 배열의 arrayInfo를 반납.
export const freeArrayInfo = (arrayPool: Pool<TArrayInfo>, arrayInfoIndex: number): void =>
  arrayPool.release(arrayInfoIndex);
