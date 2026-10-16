import { createElement, type FunctionComponent, useEffect, useRef } from "react";
import { mount, type THandlers, type TQubleBytecode } from "../../../core/web/runtime-entry.ts";

/**
 * TQubleBytecode를 React 컴포넌트로 만든다. props를 루트 props 데이터로 mount하고, props 내용이 바뀌면 다시 mount한다.
 * 이벤트 핸들러 맵은 예약 prop `handlers`로 받는다. 마운트할 때의 맵을 쓰며, 맵 객체만 바뀌어서는 다시 mount하지 않는다.
 * props는 직렬화할 수 있는 값이어야 한다(내용이 바뀌었는지를 JSON으로 견준다). 컴포넌트는 모듈 최상위에서 한 번만
 * 만든다 - 렌더마다 만들면 컴포넌트 타입이 바뀌어 매번 다시 mount한다.
 * @param bytecode  .qubc import가 낸 바이트코드
 */
export const createComponent = <TProps extends object>(
  bytecode: TQubleBytecode,
): FunctionComponent<TProps & { handlers?: THandlers }> => {
  const Component: FunctionComponent<TProps & { handlers?: THandlers }> = ({ handlers, ...data }) => {
    const container = useRef<HTMLDivElement>(null);
    const dataKey = JSON.stringify(data);
    // biome-ignore lint/correctness/useExhaustiveDependencies: handlers는 의도적으로 뺐다 - 맵 객체가 바뀌어도 다시 mount하지 않는다
    useEffect(() => {
      const inst = mount(bytecode, container.current as HTMLDivElement, { data: JSON.parse(dataKey), handlers });
      return () => inst.destroy();
    }, [dataKey]);
    return createElement("div", { ref: container });
  };
  return Component;
};
