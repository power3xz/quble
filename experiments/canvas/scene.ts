// canvas 렌더 실험의 장면 트리. 런타임(runtime.ts, region.ts)이 쓰는 DOM API만 흉내 낸다. 런타임은 전역
// document로 노드를 만들고 붙이므로, document 자리에 SDocument를 넣으면 런타임을 고치지 않고 이 트리를
// 짓고 갱신한다. 렌더러는 이 트리를 레이아웃해 canvas에 그린다.
//
// 흉내 내는 것
//   생성      createElement, createTextNode, createComment, createDocumentFragment
//   트리 조작  appendChild, insertBefore, append, prepend, after, remove, replaceChildren, cloneNode
//   탐색      parentNode, firstChild, lastChild, nextSibling, previousSibling, childNodes
//   내용      setAttribute, getAttribute, textContent, data
//   이벤트    document의 addEventListener, removeEventListener
//
// fragment를 넣으면 fragment 자신이 아니라 그 자식들이 옮겨 가고 fragment는 빈다(DOM과 같다).

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;

export class SNode {
  nodeType: number;
  ownerDocument: SDocument | null;
  parentNode: SNode | null = null;
  firstChild: SNode | null = null;
  lastChild: SNode | null = null;
  nextSibling: SNode | null = null;
  previousSibling: SNode | null = null;
  // 렌더러가 레이아웃 결과를 붙여 둔다(layout.ts의 TBox). 트리는 내용을 모른다.
  layout: unknown = null;

  constructor(nodeType: number, ownerDocument: SDocument | null) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  // 매번 새 배열이다. 런타임은 build 끝에 한 번(Array.from(fragment.childNodes))만 읽는다.
  get childNodes(): SNode[] {
    const out: SNode[] = [];
    for (let c = this.firstChild; c !== null; c = c.nextSibling) {
      out.push(c);
    }
    return out;
  }

  get textContent(): string {
    let s = "";
    for (let c = this.firstChild; c !== null; c = c.nextSibling) {
      if (c.nodeType !== COMMENT_NODE) {
        s += c.textContent;
      }
    }
    return s;
  }

  set textContent(v: unknown) {
    this.replaceChildren();
    const s = v == null ? "" : String(v);
    if (s !== "" && this.ownerDocument !== null) {
      this.appendChild(this.ownerDocument.createTextNode(s));
    }
  }

  appendChild<T extends SNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  // ref 앞에 넣는다. ref가 null이면 끝에 붙인다.
  insertBefore<T extends SNode>(child: T, ref: SNode | null): T {
    if (child.nodeType === DOCUMENT_FRAGMENT_NODE) {
      while (child.firstChild !== null) {
        this.insertBefore(child.firstChild, ref);
      }
      return child;
    }
    child.remove();
    child.parentNode = this;
    child.nextSibling = ref;
    child.previousSibling = ref === null ? this.lastChild : ref.previousSibling;
    if (child.previousSibling === null) {
      this.firstChild = child;
    } else {
      child.previousSibling.nextSibling = child;
    }
    if (ref === null) {
      this.lastChild = child;
    } else {
      ref.previousSibling = child;
    }
    this.ownerDocument?.changed(this);
    return child;
  }

  append(...nodes: SNode[]): void {
    for (const n of nodes) {
      this.appendChild(n);
    }
  }

  prepend(...nodes: SNode[]): void {
    const ref = this.firstChild;
    for (const n of nodes) {
      this.insertBefore(n, ref);
    }
  }

  // 자기 바로 뒤에 nodes를 순서대로 넣는다. 기준은 nodes에 들지 않는 첫 다음 형제다(DOM 명세와 같다).
  // [anchor, a, b]에서 anchor.after(a, b)면 기준이 a 자신이 되지 않게 b 다음(null)으로 잡는다.
  after(...nodes: SNode[]): void {
    const parent = this.parentNode;
    if (parent === null) {
      return;
    }
    let ref = this.nextSibling;
    while (ref !== null && nodes.includes(ref)) {
      ref = ref.nextSibling;
    }
    for (const n of nodes) {
      parent.insertBefore(n, ref);
    }
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent === null) {
      return;
    }
    if (this.previousSibling === null) {
      parent.firstChild = this.nextSibling;
    } else {
      this.previousSibling.nextSibling = this.nextSibling;
    }
    if (this.nextSibling === null) {
      parent.lastChild = this.previousSibling;
    } else {
      this.nextSibling.previousSibling = this.previousSibling;
    }
    this.parentNode = null;
    this.nextSibling = null;
    this.previousSibling = null;
    this.ownerDocument?.changed(parent);
  }

  replaceChildren(...nodes: SNode[]): void {
    while (this.firstChild !== null) {
      this.firstChild.remove();
    }
    this.append(...nodes);
  }

  cloneNode(deep = false): SNode {
    const copy = this.cloneSelf();
    if (deep) {
      for (let c = this.firstChild; c !== null; c = c.nextSibling) {
        copy.appendChild(c.cloneNode(true));
      }
    }
    return copy;
  }

  protected cloneSelf(): SNode {
    return new SNode(this.nodeType, this.ownerDocument);
  }
}

export class SText extends SNode {
  data: string;

  constructor(data: string, ownerDocument: SDocument) {
    super(TEXT_NODE, ownerDocument);
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(v: unknown) {
    this.data = v == null ? "" : String(v);
    this.ownerDocument?.changed(this);
  }

  protected override cloneSelf(): SNode {
    return new SText(this.data, this.ownerDocument as SDocument);
  }
}

export class SComment extends SNode {
  data: string;

  constructor(data: string, ownerDocument: SDocument) {
    super(COMMENT_NODE, ownerDocument);
    this.data = data;
  }

  protected override cloneSelf(): SNode {
    return new SComment(this.data, this.ownerDocument as SDocument);
  }
}

export class SElement extends SNode {
  // 소문자 태그 이름. DOM의 localName.
  localName: string;
  // 이름 -> 값. 넣은 순서를 지킨다(직렬화 순서가 DOM과 같도록).
  attributes = new Map<string, string>();

  constructor(localName: string, ownerDocument: SDocument) {
    super(ELEMENT_NODE, ownerDocument);
    this.localName = localName;
  }

  get tagName(): string {
    return this.localName.toUpperCase();
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
    this.ownerDocument?.changed(this);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    this.ownerDocument?.changed(this);
  }

  protected override cloneSelf(): SNode {
    const copy = new SElement(this.localName, this.ownerDocument as SDocument);
    for (const [k, v] of this.attributes) {
      copy.attributes.set(k, v);
    }
    return copy;
  }
}

export class SFragment extends SNode {
  constructor(ownerDocument: SDocument) {
    super(DOCUMENT_FRAGMENT_NODE, ownerDocument);
  }

  protected override cloneSelf(): SNode {
    return new SFragment(this.ownerDocument as SDocument);
  }
}

// 런타임이 위임 리스너에 넘기는 이벤트. 런타임은 target만 읽고 핸들러에 그대로 넘긴다.
export type TSceneEvent = { type: string; target: SNode };

export class SDocument extends SNode {
  head: SElement;
  body: SElement;
  // 트리가 바뀌면 바뀐 노드로 불린다. 렌더러가 다시 그릴 때를 안다.
  onChange: ((node: SNode) => void) | null = null;
  #listeners = new Map<string, Set<(e: TSceneEvent) => void>>();

  constructor() {
    super(DOCUMENT_NODE, null);
    this.ownerDocument = this;
    this.head = new SElement("head", this);
    this.body = new SElement("body", this);
    this.appendChild(this.head);
    this.appendChild(this.body);
  }

  createElement(localName: string): SElement {
    return new SElement(localName, this);
  }

  createTextNode(data: string): SText {
    return new SText(data, this);
  }

  createComment(data: string): SComment {
    return new SComment(data, this);
  }

  createDocumentFragment(): SFragment {
    return new SFragment(this);
  }

  addEventListener(type: string, fn: (e: TSceneEvent) => void): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (e: TSceneEvent) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }

  // target에 type 이벤트를 보낸다. 런타임은 document에만 위임 리스너를 달므로 거기 단 리스너를 부른다.
  dispatch(type: string, target: SNode): void {
    const set = this.#listeners.get(type);
    if (set === undefined) {
      return;
    }
    const event: TSceneEvent = { type, target };
    for (const fn of [...set]) {
      fn(event);
    }
  }

  changed(node: SNode): void {
    this.onChange?.(node);
  }
}

// 닫는 태그 없이 직렬화하는 요소. DOM의 innerHTML과 같다.
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

// DOM의 innerHTML과 같은 형식으로 자식들을 직렬화한다. 비교 테스트가 jsdom 결과와 견줄 때 쓴다.
export const toHTML = (node: SNode): string => {
  let s = "";
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (c instanceof SText) {
      s += c.data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
    } else if (c instanceof SComment) {
      s += `<!--${c.data}-->`;
    } else if (c instanceof SElement) {
      s += `<${c.localName}`;
      for (const [k, v] of c.attributes) {
        s += ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;")}"`;
      }
      s += VOID_ELEMENTS.has(c.localName) ? ">" : `>${toHTML(c)}</${c.localName}>`;
    }
  }
  return s;
};
