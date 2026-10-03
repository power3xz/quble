// quble React 런타임. quble-react 바이너리가 낸 컴포넌트가 이것을 `$q`로 싣는다
// (docs/react-target.draft.md).
//
// 이벤트 fullname의 경로와 활성 @with 컨텍스트는 React context(TFrame)로 내려보낸다. 합성
// 자리마다 Segment가 경로 마디를 하나 더하고, With가 컨텍스트 하나를 더한다.
//
//   Page의 First: Toggle(...) 안 button에서 TOGGLE이 나면 fullname은 "First.TOGGLE"

import { createContext, createElement, type FC, type ReactNode, useContext, useRef, useSyncExternalStore } from "react";

// 주소. 핸들러가 get/set에 넘기는 키다. qubb의 leafIndex 자리에 루트 state 안 경로가 온다.
// 리터럴 인자(`Label(text="x")`)는 store에 자리가 없어 값을 그대로 든다.
export type TAddr = { readonly path: readonly string[] } | { readonly lit: unknown };

type TContexts = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

// 자식이 받는 슬롯 콘텐츠. 슬롯 이름 -> 콘텐츠. 무기명 슬롯의 키는 "".
export type TSlots = Readonly<Record<string, ReactNode>>;

// 핸들러가 get/set에 넘기는 주소. 필드와 인덱스로 내려간다. props.rows[0].title
export type TAddrNode = { readonly [key: string]: TAddrNode };

export type THandlerCtx = {
  event: Event;
  get: (node: TAddrNode) => unknown;
  set: (node: TAddrNode, value: unknown) => void;
  setObject: (node: TAddrNode, value: unknown) => void;
  setArray: (node: TAddrNode, elems: readonly unknown[]) => void;
  push: (node: TAddrNode, elem: unknown) => void;
  removeAt: (node: TAddrNode, i: number) => void;
  swapAt: (node: TAddrNode, i: number, j: number) => void;
  props: TAddrNode;
  store: TAddrNode;
  context: TContexts;
  [loopIndex: `$${number}`]: number;
};

export type THandlers = Record<string, (data: Record<string, unknown>, ctx: THandlerCtx) => void>;

type TStore = {
  state: Record<string, unknown>;
  listeners: Set<() => void>;
  handlers: THandlers;
};

type TFrame = {
  store: TStore;
  path: readonly string[];
  contexts: TContexts;
  // 이 프레임 아래 컴포넌트가 받은 props의 주소. 이름 -> 주소.
  props: Readonly<Record<string, TAddr>>;
  // 감싼 @for들의 회차 번호. 바깥 컴포넌트의 @for까지 쌓인다. 핸들러의 $0, $1...이 된다.
  loops: readonly number[];
  // 이 컴포넌트에 들어올 때의 loops 길이. 그 뒤로 쌓인 회차는 아직 경로 마디에 안 붙었다.
  base: number;
  // 이 컴포넌트 안 @for 변수의 주소. 이름 -> 주소.
  vars: Readonly<Record<string, TAddr>>;
};

// 경로 마디에 아직 안 붙은 회차 표기. 바깥에서 @for 하나를 거쳐 들어온 컴포넌트가 자기 @for
// 하나를 더 돌면 base 1, loops [2, 0] -> "[$1]"
const loopSuffix = (frame: TFrame): string =>
  frame.loops
    .slice(frame.base)
    .map((_, k) => `[$${frame.base + k}]`)
    .join("");

const Frame = createContext<TFrame | null>(null);

const useFrame = (): TFrame => {
  const frame = useContext(Frame);
  if (!frame) {
    throw new Error("quble 컴포넌트는 QubleRoot 안에서 그려야 한다");
  }
  return frame;
};

const descend = (addr: TAddr, fields: readonly string[]): TAddr => {
  if ("path" in addr) {
    return { path: [...addr.path, ...fields] };
  }
  return { lit: fields.reduce((value, field) => (value as Record<string, unknown>)[field], addr.lit) };
};

export type TQ = {
  emit: (
    event: string,
    data: Record<string, unknown>,
    domEvent: { stopPropagation(): void; nativeEvent: Event },
  ) => void;
  at: (name: string, ...fields: string[]) => TAddr;
  lit: (value: unknown) => TAddr;
  // 슬롯 콘텐츠. 자식 안에 붙어도 이 q의 경로, 컨텍스트, 회차로 해석되게 그 프레임을 다시 깐다.
  slot: (content: ReactNode) => ReactNode;
  // @for. source가 수면 0..source-1을, 배열이면 요소를 돈다. 회차마다 그 회차를 보는 q를 넘긴다.
  // addr는 배열의 주소다 - 요소를 자식에 넘기면 그 주소 아래 회차 번호가 요소의 주소가 된다.
  each: {
    (
      source: number,
      addr: TAddr | null,
      item: string,
      index: string | null,
      render: (q: TQ, item: number, index: number) => ReactNode,
    ): ReactNode[];
    <T>(
      source: readonly T[],
      addr: TAddr | null,
      item: string,
      index: string | null,
      render: (q: TQ, item: T, index: number) => ReactNode,
    ): ReactNode[];
  };
};

export const useQ = (): TQ => qOf(useFrame());

const qOf = (frame: TFrame): TQ => {
  return {
    emit: (event, data, domEvent) => {
      // qubb처럼 버블을 막는다 - 자식 클릭이 같은 이벤트를 단 부모까지 부르지 않게.
      domEvent.stopPropagation();
      fire(frame, event, data, domEvent.nativeEvent);
    },
    // @for 변수와 prop은 이름이 겹치지 않는다(codegen이 거른다).
    at: (name, ...fields) => descend(frame.vars[name] ?? frame.props[name], fields),
    lit: (value) => ({ lit: value }),
    slot: (content) => createElement(Frame.Provider, { value: frame }, content),
    each: (
      source: number | readonly unknown[],
      addr: TAddr | null,
      item: string,
      index: string | null,
      render: (q: TQ, item: never, index: number) => ReactNode,
    ) => {
      const count = typeof source === "number" ? source : source.length;
      const rounds: ReactNode[] = [];
      for (let i = 0; i < count; i++) {
        const value = typeof source === "number" ? i : source[i];
        const vars: Record<string, TAddr> = {
          ...frame.vars,
          [item]: addr === null || typeof source === "number" ? { lit: value } : descend(addr, [String(i)]),
        };
        if (index !== null) {
          vars[index] = { lit: i };
        }
        const round: TFrame = { ...frame, loops: [...frame.loops, i], vars };
        rounds.push(createElement(Frame.Provider, { key: i, value: round }, render(qOf(round), value as never, i)));
      }
      return rounds;
    },
  };
};

const ADDR = Symbol("addr");

// 핸들러가 `props.user.name`처럼 필드로 내려가 주소를 집게 한다. 내려갈 때마다 마디가 붙는다.
const addrNode = (addr: TAddr): TAddrNode =>
  new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === ADDR) {
          return addr;
        }
        return typeof key === "string" ? addrNode(descend(addr, [key])) : undefined;
      },
    },
  );

const addrOf = (node: TAddrNode): TAddr => {
  const addr = (node as Record<symbol, TAddr | undefined>)[ADDR];
  if (!addr) {
    throw new TypeError("get/set에는 props나 store에서 집은 주소를 넘긴다");
  }
  return addr;
};

const readPath = (state: unknown, path: readonly string[]): unknown =>
  path.reduce((value, key) => (value as Record<string, unknown>)[key], state);

// 경로를 따라 사본을 만들어 바꾼다. 경로 밖 가지는 원래 객체를 그대로 공유한다.
const writePath = (state: unknown, path: readonly string[], value: unknown): unknown => {
  if (path.length === 0) {
    return value;
  }
  const [key, ...rest] = path;
  const copy = (Array.isArray(state) ? state.slice() : { ...(state as object) }) as Record<string, unknown>;
  copy[key] = writePath(copy[key], rest, value);
  return copy;
};

const fire = (frame: TFrame, event: string, data: Record<string, unknown>, domEvent: Event) => {
  const { store } = frame;
  // @for 직속 요소에서 나면 회차 표기가 익명 마디가 된다. "[$0].SELECT"
  const suffix = loopSuffix(frame);
  const path = suffix ? [...frame.path, suffix] : frame.path;
  const handler = store.handlers[[...path, event].join(".")];
  if (!handler) {
    return;
  }
  const update = (node: TAddrNode, next: (current: unknown) => unknown) => {
    const addr = addrOf(node);
    if (!("path" in addr)) {
      throw new TypeError("리터럴 인자는 바꿀 수 없다");
    }
    store.state = writePath(store.state, addr.path, next(readPath(store.state, addr.path))) as Record<string, unknown>;
    for (const listener of store.listeners) {
      listener();
    }
  };
  const props = Object.fromEntries(Object.entries(frame.props).map(([name, addr]) => [name, addrNode(addr)]));
  const loopIndices = Object.fromEntries(frame.loops.map((i, depth) => [`$${depth}`, i]));
  handler(data, {
    event: domEvent,
    get: (node) => {
      const addr = addrOf(node);
      return "path" in addr ? readPath(store.state, addr.path) : addr.lit;
    },
    set: (node, value) => update(node, () => value),
    // 안 준 필드는 undefined다 - 합치지 않고 통째로 바꾼다.
    setObject: (node, value) => update(node, () => value),
    setArray: (node, elems) => update(node, () => [...elems]),
    push: (node, elem) => update(node, (array) => [...(array as unknown[]), elem]),
    removeAt: (node, i) => update(node, (array) => (array as unknown[]).filter((_, k) => k !== i)),
    swapAt: (node, i, j) =>
      update(node, (array) => {
        const swapped = (array as unknown[]).slice();
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        return swapped;
      }),
    props,
    store: addrNode({ path: [] }),
    context: frame.contexts,
    ...loopIndices,
  });
};

export const Segment: FC<{ name: string; props: Record<string, TAddr>; children: ReactNode }> = ({
  name,
  props,
  children,
}) => {
  const parent = useFrame();
  // @for 안 합성이면 회차 표기가 이 마디에 붙는다. "Item[$0]"
  // 자식은 자기 @for를 여기서부터 센다.
  const frame: TFrame = {
    ...parent,
    path: [...parent.path, name + loopSuffix(parent)],
    props,
    base: parent.loops.length,
    vars: {},
  };
  return createElement(Frame.Provider, { value: frame }, children);
};

// 같은 이름이 이미 있으면 통째로 덮는다(필드를 합치지 않는다).
//
// 자식을 함수로 받아 컨텍스트가 더해진 q를 넘긴다. 같은 컴포넌트 안의 요소는 컴포넌트 맨 위에서
// 잡은 q를 쓰므로, 그 q로는 이 With가 안 보인다.
//   <$q.With name="Area" value={...}>{(q) => <button onClick={(e) => q.emit(...)} />}</$q.With>
export const With: FC<{ name: string; value: Record<string, unknown>; children: (q: TQ) => ReactNode }> = ({
  name,
  value,
  children,
}) => {
  const parent = useFrame();
  const frame = { ...parent, contexts: { ...parent.contexts, [name]: value } };
  return createElement(Frame.Provider, { value: frame }, children(qOf(frame)));
};

// 루트 컴포넌트를 state로 그린다. handlers가 바뀌면 다음 발화부터 새 표를 쓴다.
export const QubleRoot = <T extends Record<string, unknown>>({
  component,
  initial,
  handlers,
}: {
  component: FC<T>;
  initial: T;
  handlers: THandlers;
}) => {
  const ref = useRef<TStore | null>(null);
  if (!ref.current) {
    ref.current = { state: initial, listeners: new Set(), handlers };
  }
  const store = ref.current;
  store.handlers = handlers;
  const state = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.state,
  );
  const props = Object.fromEntries(Object.keys(state).map((name) => [name, { path: [name] }]));
  return createElement(
    Frame.Provider,
    { value: { store, path: [], contexts: {}, props, loops: [], base: 0, vars: {} } },
    createElement(component, state as T),
  );
};

// 텍스트와 속성값. React는 boolean을 안 찍으므로 qubb처럼 "true"/"false"로 바꾼다.
export const str = (value: unknown): string => String(value);

// 배열 인덱스 접근. 요소가 없는 인덱스는 qubb처럼 RangeError를 낸다.
export const idx = <T>(array: readonly T[], index: number): T => {
  if (!Number.isInteger(index) || index < 0 || index >= array.length) {
    throw new RangeError(`index ${index} out of range (length ${array.length})`);
  }
  return array[index];
};
