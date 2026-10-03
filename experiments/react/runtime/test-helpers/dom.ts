// jsdom 전역. react-dom은 실릴 때 window가 있는지 보므로 react-dom보다 먼저 import한다.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><body></body>");
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.Event = dom.window.Event;
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
// act()로 감싼 갱신을 React가 경고 없이 받게 한다.
g.IS_REACT_ACT_ENVIRONMENT = true;
