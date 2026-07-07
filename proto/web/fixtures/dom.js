// 통합 테스트용 jsdom 셋업. runtime.js/region.js는 전역 document에 의존하므로
// 모듈 import 전에 globalThis.document를 주입해야 한다.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><body></body>");
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;

// 인스턴스 노드를 새 호스트 div에 붙이고 호스트를 돌려준다(innerHTML 검사용).
// host를 document.body에 붙인다 - 이벤트 위임(document 리스너)이 발화하려면 트리가
// document 안에 있어야 한다(detached 트리는 버블이 document까지 못 올라간다). 실제 앱의
// #quble-app 부착과 동일한 조건. 이전 테스트가 남긴 호스트는 비운다(발화 대상 격리).
export const mount = (instance) => {
  document.body.replaceChildren();
  const host = document.createElement("div");
  host.append(...instance.nodes);
  document.body.append(host);
  return host;
};
