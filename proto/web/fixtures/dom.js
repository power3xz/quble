// 통합 테스트용 jsdom 셋업. runtime.js/region.js는 전역 document에 의존하므로
// 모듈 import 전에 globalThis.document를 주입해야 한다.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.document = dom.window.document;

// 인스턴스 노드를 새 호스트 div에 붙이고 호스트를 돌려준다(innerHTML 검사용).
export const mount = (instance) => {
  const host = document.createElement("div");
  host.append(...instance.nodes);
  return host;
};
