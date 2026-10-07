// qubb 상수풀이 인덱스로 가리키는 DOM 이름 표와 동적 속성 설정. 포맷은 core/BYTECODE.md.

export const TAGS = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "a",
  "ul",
  "li",
  "button",
  "article",
  "img",
  "section",
  "header",
  "footer",
  "nav",
  "main",
  "aside",
  "label",
  "input",
  "em",
  "b",
  "strong",
  "i",
  "small",
  "code",
  "pre",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "ol",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "form",
  "textarea",
  "select",
  "option",
  "figure",
  "figcaption",
  "time",
  "blockquote",
  "video",
  "audio",
  "canvas",
] as const;
export const ATTRS = [
  "class",
  "id",
  "src",
  "alt",
  "href",
  "type",
  "name",
  "value",
  "title",
  "style",
  "placeholder",
  "for",
  "disabled",
  "checked",
  "readonly",
  "required",
  "rel",
  "target",
  "width",
  "height",
  "colspan",
  "rowspan",
  "role",
  "tabindex",
  "datetime",
  "controls",
] as const;
// 전역 DOM 이벤트 테이블(BYTECODE.md #2). BIND_EVENT의 event_type. Rust dom_events.rs와 동일 순서.
export const DOM_EVENTS = [
  "click",
  "input",
  "change",
  "submit",
  "focus",
  "blur",
  "keydown",
  "keyup",
  "mousedown",
  "mouseup",
  "mouseenter",
  "mouseleave",
  "scroll",
] as const;

// URL을 받는 속성. 값이 javascript: 스킴이면 이동/제출 때 그 스크립트가 실행된다.
const URL_ATTRS = new Set(["href", "src", "action", "formaction"]);
// 브라우저는 스킴 앞의 공백/제어 문자(U+0000~U+0020)와 스킴 안의 탭/개행을 무시하고 읽는다.
// biome-ignore lint/suspicious/noControlCharactersInRegex: 브라우저가 무시하는 제어 문자를 그대로 걷어내야 한다
const SCHEME_LEADING = /^[\u0000- ]+/;
const SCHEME_INNER = /[\t\n\r]/g;

// 동적 속성 값을 단다. URL 속성에 javascript: 값이 오면 달지 않고 있던 속성도 지운다(XSS 차단).
export const setAttributeSafely = (el: HTMLElement, name: string, value: unknown): void => {
  if (
    URL_ATTRS.has(name) &&
    typeof value === "string" &&
    value.replace(SCHEME_LEADING, "").replace(SCHEME_INNER, "").toLowerCase().startsWith("javascript:")
  ) {
    el.removeAttribute(name);
    return;
  }
  el.setAttribute(name, value as string);
};
