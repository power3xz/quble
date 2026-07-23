// 인덱스 기반 플랫 배열 + freelist. 빈 칸을 재사용해 배열이 무한 증가하지 않게 한다.
// 데이터는 호출부가 pool.entries 순수 배열로 소유하고(접근은 entries[i] 직접, 인디렉션 없음),
// 이 두 함수는 alloc/free 두 지점에서만 freelist에 관여한다. free는 비어 있는 칸의 인덱스만 담는다.
//
// 빈 칸은 내부적으로 null이지만 그 사실을 이 유닛 안에 가둔다 - entries 타입은 T[](non-null)로
// 노출한다. 접근 인덱스가 빈 칸을 가리키는 일은 없음을 바이트코드가 보장하므로(free된 칸의
// 인덱스는 명단에서 잘려 접근 경로에 없다), 호출부는 단언 없이 entries[i]를 유효한 T로 다룬다.

// 항목 배열(entries)과 빈 칸 인덱스 freelist(free)를 묶은 풀.
export type TPool<T> = { entries: T[]; free: number[] };

// free에 빈 칸이 있으면 pop해 재사용, 없으면 끝에 append. 그 칸에 value를 넣고 인덱스 반환.
export const allocInPool = <T>(pool: TPool<T>, value: T): number => {
  const index = pool.free.length > 0 ? (pool.free.pop() as number) : pool.entries.length;
  pool.entries[index] = value;
  return index;
};

// 칸을 null로 끊고(유일 소유자라 null이어야 GC된다) free에 반납한다. null은 이 유닛만
// 아는 구현 세부라 여기서만 인정한다(호출부 타입은 T[]로 유지).
export const freeInPool = <T>(pool: TPool<T>, index: number): void => {
  (pool.entries as (T | null)[])[index] = null;
  pool.free.push(index);
};
