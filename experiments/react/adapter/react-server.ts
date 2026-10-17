import { createElement, type FunctionComponent } from "react";
import type { TQubleBytecode } from "../../../core/web/runtime-entry.ts";
import type { TComponentProps } from "./handler-types.ts";
import { renderToHtml } from "./server-render.ts";

/**
 * TQubleBytecode를 서버에서 그리는 React 컴포넌트로 만든다. 렌더 중에 props를 루트 props 데이터로 jsdom에서
 * mount해 얻은 HTML을 `<div>`에 심는다. 브라우저 쪽 react-browser.ts의 createComponent와 시그니처가 같다.
 * handlers는 서버에서 쓰이지 않는다(이벤트는 브라우저가 resume한 뒤에 붙는다).
 * @param bytecode  .qubc import가 낸 바이트코드
 */
export const createComponent = <THandlerMap = unknown>(
  bytecode: TQubleBytecode<THandlerMap>,
): FunctionComponent<TComponentProps<THandlerMap>> => {
  const Component = ({ handlers: _handlers, ...data }: Record<string, unknown>) =>
    createElement("div", {
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderToHtml이 낸 바이트코드 렌더 결과를 그대로 심는다
      dangerouslySetInnerHTML: { __html: renderToHtml(bytecode, data) },
    });
  return Component as unknown as FunctionComponent<TComponentProps<THandlerMap>>;
};
