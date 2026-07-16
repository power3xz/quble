// 통합 테스트용 핸들러 타입. runtime의 THandlers(ctx가 Record<string,unknown>)는 너무 헐거워
// set/get/props를 쓰는 테스트에서 unknown이 되므로, dispatchBinding이 실제로 넘기는 인자 셋을
// 그대로 담은 실용 타입을 둔다(정밀하진 않게 - 테스트가 편하게 쓸 정도). fullname -> 핸들러 맵.

// 핸들러 둘째 인자(dispatchBinding이 실제로 넘기는 ctx). leafIndex는 number(leaf-store 로컬 타입).
// $0/$1... 회차 인덱스는 인덱스 시그니처로.
export type THandlerCtx = {
  event: Event;
  get: (leafIndex: number) => unknown;
  set: (leafIndex: number, value: unknown) => void;
  props: Record<string, number>;
  context: Record<string, Record<string, unknown>>;
  [loopIndex: `$${number}`]: number;
};

export type TTestHandler = (data: Record<string, unknown>, ctx: THandlerCtx) => void;

// fullname -> 핸들러. compile(...)(0)(values, handlers)에 그대로 넘긴다.
export type TTestHandlers = Record<string, TTestHandler>;
