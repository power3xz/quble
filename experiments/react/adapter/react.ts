import { createElement, type FunctionComponent, useEffect, useRef } from "react";
import { mount, type THandlers, type TQubleBytecode } from "../../../core/web/runtime-entry.ts";

/**
 * TQubleBytecode를 React 컴포넌트로 만든다. props를 루트 props 데이터로 한 번 mount하고, props 내용이 바뀌면
 * 바뀐 최상위 prop만 인스턴스의 update(replace)로 갱신한다. 다시 mount하지 않으므로 DOM은 유지된다.
 * 이전 렌더에 있던 prop이 빠져도 갱신하지 않는다(루트 props는 모두 필수다).
 * 이벤트 핸들러 맵은 예약 prop `handlers`로 받는다. 마운트할 때의 맵을 쓰며, 맵 객체가 바뀌어도 반영하지 않는다.
 * props는 직렬화할 수 있는 값이어야 한다(내용이 바뀌었는지를 JSON으로 견준다). 컴포넌트는 모듈 최상위에서 한 번만
 * 만든다 - 렌더마다 만들면 컴포넌트 타입이 바뀌어 매번 다시 mount한다.
 * @param bytecode  .qubc import가 낸 바이트코드
 */
export const createComponent = <TProps extends object>(
  bytecode: TQubleBytecode,
): FunctionComponent<TProps & { handlers?: THandlers }> => {
  const Component: FunctionComponent<TProps & { handlers?: THandlers }> = ({ handlers, ...data }) => {
    const container = useRef<HTMLDivElement>(null);
    const instance = useRef<ReturnType<typeof mount> | null>(null);
    const applied = useRef<Record<string, unknown>>({}); // 마지막으로 mount하거나 update한 data
    const dataKey = JSON.stringify(data);
    // biome-ignore lint/correctness/useExhaustiveDependencies: 처음 한 번만 mount한다 - 이후 data 변화는 아래 이펙트가 update로 반영하고 handlers는 의도적으로 뺐다
    useEffect(() => {
      applied.current = JSON.parse(dataKey);
      const inst = mount(bytecode, container.current as HTMLDivElement, { data: applied.current, handlers });
      instance.current = inst;
      return () => {
        inst.destroy();
        instance.current = null;
      };
    }, []);
    useEffect(() => {
      const next: Record<string, unknown> = JSON.parse(dataKey);
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next)) {
        if (JSON.stringify(value) !== JSON.stringify(applied.current[key])) {
          changed[key] = value;
        }
      }
      applied.current = next;
      if (Object.keys(changed).length > 0) {
        instance.current?.update(changed, "replace");
      }
    }, [dataKey]);
    return createElement("div", { ref: container });
  };
  return Component;
};
