// 인덱스 기반 플랫 배열 + freelist. 빈 칸을 재사용해 배열이 무한 증가하지 않게 한다.
// 데이터는 호출부가 순수 배열로 소유하고(접근은 pool[i] 직접, 인디렉션 없음), 이 두 함수는
// alloc/free 두 지점에서만 freelist에 관여한다. freeList는 비어 있는 칸의 인덱스 숫자만 담는다.

// freeList에 빈 칸이 있으면 pop해 재사용, 없으면 끝에 append. 그 칸에 value를 넣고 인덱스 반환.
export const allocInPool = <T>(pool: (T | null)[], freeList: number[], value: T): number => {
  const index = freeList.length > 0 ? (freeList.pop() as number) : pool.length;
  pool[index] = value;
  return index;
};

// 칸을 null로 끊고(유일 소유자라 null이어야 GC된다) freeList에 반납한다.
export const freeInPool = <T>(pool: (T | null)[], freeList: number[], index: number): void => {
  pool[index] = null;
  freeList.push(index);
};
