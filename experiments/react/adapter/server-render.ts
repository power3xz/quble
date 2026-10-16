import { JSDOM } from "jsdom";
import { mount, type TQubleBytecode } from "../../../core/web/runtime-entry.ts";

// 런타임이 전역으로 읽는 DOM 이름들. 호출하는 동안만 jsdom의 것으로 건다.
const GLOBALS = ["window", "document", "Event", "HTMLElement", "Node"] as const;

// jsdom 인스턴스는 한 번만 만들어 모든 호출이 나눠 쓴다. 컨테이너를 호출마다 새로 만들어 서로 섞이지 않는다.
let dom: JSDOM | undefined;

/**
 * 바이트코드를 data로 가짜 DOM(jsdom)에서 mount해 HTML 문자열로 낸다. 런타임이 전역 document를 쓰므로 호출하는
 * 동안만 전역을 걸고 끝나면 이전 값으로 되돌린다. 동기라 호출끼리 섞이지 않는다.
 * @param bytecode  .qubc import가 낸 바이트코드
 * @param data      루트 props 데이터
 */
export const renderToHtml = (bytecode: TQubleBytecode, data: Record<string, unknown>): string => {
  dom ??= new JSDOM("<!DOCTYPE html><body></body>");
  const { window } = dom;
  const g = globalThis as Record<string, unknown>;
  const previous = GLOBALS.map((name) => [name, name in g, g[name]] as const);
  g.window = window;
  g.document = window.document;
  g.Event = window.Event;
  g.HTMLElement = window.HTMLElement;
  g.Node = window.Node;
  try {
    const container = window.document.createElement("div");
    const instance = mount(bytecode, container, { data });
    const html = container.innerHTML;
    instance.destroy();
    return html;
  } finally {
    for (const [name, existed, value] of previous) {
      if (existed) {
        g[name] = value;
      } else {
        delete g[name];
      }
    }
  }
};
