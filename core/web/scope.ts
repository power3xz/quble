// 슬롯 해석방법. argumentSourcePairs는 (해석방법, 참조) 쌍을 인터리브로 담는다 - 슬롯 offset은
// argumentSourcePairs[2*offset](해석방법) / argumentSourcePairs[2*offset+1](참조)로 읽는다. STORE는 참조가 store
// leafIndex(반응값, 구독), CONST는 참조가 상수풀 인덱스(불변, 구독 스킵), RAW는 참조가 값 자체
// (count @for의 회차 인덱스 - store에 안 앉는 회차 상수, 구독 스킵).
export const STORE = 0;
export const CONST = 1;
export const RAW = 2;

// 스코프 - (kind, ref) 쌍을 인터리브로 담은 평탄 배열.
//
//   [ kind0, ref0 | kind1, ref1 | ... ]      슬롯 o -> [2o]=kind, [2o+1]=ref
//     +-- 슬롯 0 --+  +-- 슬롯 1 --+
//
// 만든 뒤 바꾸지 않는다 - @for 회차는 바깥 스코프 뒤에 회차변수 슬롯을 붙인 새 배열을 받는다.
// 그래서 식/이벤트/지연 build가 나중에 슬롯을 다시 읽어도 복사 없이 참조로 들고 있으면 된다.
export type TScope = readonly number[];

export const slotKind = (scope: TScope, o: number): number => scope[2 * o];
export const slotRef = (scope: TScope, o: number): number => scope[2 * o + 1];

// 바깥 스코프 뒤에 회차변수 슬롯 2칸(item, index)을 붙인 새 스코프. 배열 하나로 concat해야 빈칸
// 없는(PACKED) 배열이 딱 맞는 크기로 나온다 - new Array(n)와 값 여럿 concat은 빈칸 있는(HOLEY) 배열이
// 되고, spread는 저장 공간을 넉넉히 잡아 두 배 넘게 크다.
export const scopeWithIteration = (
  scope: TScope,
  itemKind: number,
  itemRef: number,
  indexKind: number,
  indexRef: number,
): TScope => scope.concat([itemKind, itemRef, indexKind, indexRef]);
