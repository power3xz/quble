// canvas 실험의 CSS 부분 해석. canvas에는 CSS가 적용되지 않으므로, CSS 파일을 읽어 선택자를 장면 트리 요소에
// 맞추고 선언을 레이아웃 스타일(TStyle)로 옮긴다.
//
// 다루는 것
//   규칙      선택자 목록 { 선언 }. :root의 사용자 정의 속성(--x)과 var(--x)
//   @media    (prefers-color-scheme: dark)만. 나머지 @규칙은 건너뛴다
//   선택자    태그, *, #id, .class, [attr="v"], :root, 자손( ), 자식(>). 그 밖의 의사 클래스가 붙은
//             선택자(:hover, :disabled)는 맞지 않는 것으로 본다
//   우선순위  명시도(id, class와 속성, 태그) 다음 나온 순서
//   속성      display, flex-wrap, gap, grid-template-columns(px, fr), padding, margin, margin-bottom, border,
//             border-bottom, border-radius, background, background-color, color, font-weight, text-align,
//             visibility
// 다루지 않는 속성은 무시하고 처음 한 번 경고한다. 길이는 px만 읽는다.

import type { TStyle } from "./layout.ts";
import type { SElement } from "./scene.ts";

type TCompound = {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: [string, string | null][];
  root: boolean;
};
// 오른쪽(대상 요소)부터 왼쪽으로. combinator는 그 마디와 왼쪽 마디 사이의 관계다.
type TSelector = { parts: { compound: TCompound; combinator: " " | ">" | null }[]; specificity: number };
type TRule = { selector: TSelector; decls: [string, string][]; order: number };

export type TStyleSheet = { rules: TRule[]; vars: Map<string, string>; attrNames: Set<string> };

const UNSUPPORTED_PSEUDO = /:(?!root\b)[\w-]+|::/;

const parseCompound = (s: string): TCompound | null => {
  if (UNSUPPORTED_PSEUDO.test(s)) {
    return null;
  }
  const c: TCompound = { tag: null, id: null, classes: [], attrs: [], root: false };
  const re = /(\*)|(:root)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|([a-zA-Z][\w-]*)/g;
  let consumed = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    consumed += m[0].length;
    if (m[2]) {
      c.root = true;
    } else if (m[3]) {
      c.id = m[3];
    } else if (m[4]) {
      c.classes.push(m[4]);
    } else if (m[5]) {
      c.attrs.push([m[5], m[6] ?? null]);
    } else if (m[7]) {
      c.tag = m[7].toLowerCase();
    }
  }
  return consumed === s.length ? c : null;
};

const parseSelector = (text: string): TSelector | null => {
  const tokens = text
    .trim()
    .replace(/\s*>\s*/g, " > ")
    .split(/\s+/);
  const parts: TSelector["parts"] = [];
  let combinator: " " | ">" | null = null;
  let specificity = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === ">") {
      combinator = ">";
      continue;
    }
    const compound = parseCompound(tokens[i]);
    if (compound === null) {
      return null;
    }
    if (parts.length > 0) {
      parts[parts.length - 1].combinator = combinator ?? " ";
    }
    parts.push({ compound, combinator: null });
    combinator = null;
    specificity +=
      (compound.id ? 10000 : 0) +
      (compound.classes.length + compound.attrs.length + (compound.root ? 1 : 0)) * 100 +
      (compound.tag ? 1 : 0);
  }
  return { parts, specificity };
};

// css를 규칙 목록으로 읽는다. dark면 (prefers-color-scheme: dark) 블록도 읽는다.
export const parseCss = (css: string, dark: boolean): TStyleSheet => {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: TRule[] = [];
  const vars = new Map<string, string>();
  const attrNames = new Set<string>();
  let order = 0;
  const parseBlock = (text: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) {
        return;
      }
      const head = text.slice(i, open).trim();
      // 짝 맞는 닫는 괄호
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") {
          depth++;
        } else if (text[j] === "}") {
          depth--;
        }
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (head.startsWith("@")) {
        if (/^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/.test(head) && dark) {
          parseBlock(body);
        }
        continue;
      }
      const decls: [string, string][] = [];
      for (const d of body.split(";")) {
        const colon = d.indexOf(":");
        if (colon > 0) {
          decls.push([d.slice(0, colon).trim().toLowerCase(), d.slice(colon + 1).trim()]);
        }
      }
      for (const selText of head.split(",")) {
        const selector = parseSelector(selText);
        if (selector === null) {
          continue;
        }
        for (const p of selector.parts) {
          for (const [name] of p.compound.attrs) {
            attrNames.add(name);
          }
        }
        // :root의 사용자 정의 속성은 전역 변수로 모은다(뒤에 나온 것이 이긴다).
        if (selector.parts.length === 1 && selector.parts[0].compound.root) {
          for (const [k, v] of decls) {
            if (k.startsWith("--")) {
              vars.set(k, v);
            }
          }
        }
        rules.push({ selector, decls, order: order++ });
      }
    }
  };
  parseBlock(src);
  rules.sort((a, b) => a.selector.specificity - b.selector.specificity || a.order - b.order);
  return { rules, vars, attrNames };
};

const matchCompound = (c: TCompound, el: SElement): boolean => {
  if (c.root) {
    return false; // 장면 트리에 html 요소가 없다. :root는 변수만 준다.
  }
  if (c.tag !== null && c.tag !== el.localName) {
    return false;
  }
  if (c.id !== null && el.getAttribute("id") !== c.id) {
    return false;
  }
  if (c.classes.length > 0) {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/);
    for (const k of c.classes) {
      if (!cls.includes(k)) {
        return false;
      }
    }
  }
  for (const [name, value] of c.attrs) {
    const v = el.getAttribute(name);
    if (v === null || (value !== null && v !== value)) {
      return false;
    }
  }
  return true;
};

const isElement = (n: unknown): n is SElement => (n as SElement | null)?.nodeType === 1;

const matchSelector = (sel: TSelector, el: SElement): boolean => {
  if (!matchCompound(sel.parts[0].compound, el)) {
    return false;
  }
  let cur: SElement = el;
  for (let i = 0; i < sel.parts.length - 1; i++) {
    const combinator = sel.parts[i].combinator;
    const next = sel.parts[i + 1].compound;
    let p = cur.parentNode;
    if (combinator === ">") {
      if (!isElement(p) || !matchCompound(next, p)) {
        return false;
      }
      cur = p;
    } else {
      while (isElement(p) && !matchCompound(next, p)) {
        p = p.parentNode;
      }
      if (!isElement(p)) {
        return false;
      }
      cur = p;
    }
  }
  return true;
};

const BLOCK_TAGS = new Set([
  "div",
  "p",
  "main",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "form",
  "table",
  "body",
]);
const SUPPORTED = new Set([
  "display",
  "flex-wrap",
  "gap",
  "grid-template-columns",
  "padding",
  "margin",
  "margin-bottom",
  "border",
  "border-bottom",
  "border-radius",
  "background",
  "background-color",
  "color",
  "font-weight",
  "text-align",
  "visibility",
]);
const warned = new Set<string>();

const px = (v: string): number => {
  const m = /^(-?[\d.]+)(px)?$/.exec(v.trim());
  return m === null ? 0 : Number(m[1]);
};

// 1~4개 값의 축약(padding, margin)을 위, 오른쪽, 아래, 왼쪽으로
const box4 = (v: string): [number, number, number, number] => {
  const n = v.split(/\s+/).map(px);
  const [t, r = t, b = t, l = r] = n;
  return [t, r, b, l];
};

// border 축약에서 색만 꺼낸다. 두께는 1px로 본다. none이나 0이면 테두리 없음(undefined).
const borderColor = (v: string): string | undefined => {
  if (/^(none|0)$/.test(v.trim())) {
    return undefined;
  }
  // 괄호 안 공백(rgb(1, 2, 3))에서 나뉘지 않게 괄호째 한 토큰으로 본다.
  const tokens = v.match(/[\w#.-]+\([^)]*\)|[^\s]+/g) ?? [];
  const color = tokens.find((t) => !/^(-?[\d.]+(px)?|solid|dashed|dotted|double|none|thin|medium|thick)$/.test(t));
  return color ?? "currentColor";
};

// 선언들(이긴 순서대로 덮어쓴 결과)을 TStyle로 옮긴다.
const toStyle = (decls: Map<string, string>, tag: string): TStyle => {
  const s: TStyle = { display: BLOCK_TAGS.has(tag) ? "block" : "inline" };
  // 브라우저 기본 스타일(UA) 중 결과에 보이는 것
  if (tag === "button") {
    s.align = "center";
  }
  for (const [k, v] of decls) {
    switch (k) {
      case "display":
        s.display = v === "flex" ? "row" : v === "grid" ? "grid" : v === "block" ? "block" : "inline";
        break;
      case "flex-wrap":
        s.wrap = v === "wrap";
        break;
      case "gap":
        s.gap = px(v.split(/\s+/)[0]);
        break;
      case "grid-template-columns":
        s.columns = v.split(/\s+/).map((t) => (t.endsWith("fr") ? 0 : px(t)));
        break;
      case "padding":
        s.padding = box4(v);
        break;
      case "margin":
        s.marginBottom = box4(v)[2];
        break;
      case "margin-bottom":
        s.marginBottom = px(v);
        break;
      case "border":
        s.border = borderColor(v);
        break;
      case "border-bottom":
        s.borderBottom = borderColor(v);
        break;
      case "border-radius":
        s.radius = px(v);
        break;
      case "background":
      case "background-color":
        s.background = v;
        break;
      case "color":
        s.color = v;
        break;
      case "font-weight":
        s.bold = v === "bold" || Number(v) >= 600;
        break;
      case "text-align":
        s.align = v === "right" ? "right" : v === "center" ? "center" : "left";
        break;
      case "visibility":
        s.hidden = v === "hidden";
        break;
    }
  }
  return s;
};

const resolveVars = (v: string, vars: Map<string, string>): string =>
  v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name: string, fallback?: string) =>
    resolveVars(vars.get(name) ?? fallback ?? "", vars),
  );

// 요소의 스타일을 돌려주는 함수를 만든다. 결과를 "부모의 결과 + 자기 태그, id, class, 선택자가 보는 속성"으로
// 캐시한다 - 같은 모양의 요소(1만 행의 같은 칸)는 매칭을 다시 하지 않는다.
export const createStyleOf = (sheet: TStyleSheet): ((el: SElement) => TStyle) => {
  const cache = new Map<string, { id: number; style: TStyle }>();
  const keyOf = (el: SElement): string => {
    let key = `${el.localName}#${el.getAttribute("id") ?? ""}.${el.getAttribute("class") ?? ""}`;
    for (const name of sheet.attrNames) {
      key += `[${el.getAttribute(name) ?? ""}]`;
    }
    return key;
  };
  const entryOf = (el: SElement): { id: number; style: TStyle } => {
    const parent = el.parentNode;
    const parentId = isElement(parent) ? entryOf(parent).id : -1;
    const key = `${parentId}|${keyOf(el)}`;
    let entry = cache.get(key);
    if (entry === undefined) {
      const decls = new Map<string, string>();
      for (const rule of sheet.rules) {
        if (matchSelector(rule.selector, el)) {
          for (const [k, v] of rule.decls) {
            if (k.startsWith("--")) {
              continue;
            }
            if (!SUPPORTED.has(k)) {
              if (!warned.has(k)) {
                warned.add(k);
                console.warn(`canvas css: ${k} 무시`);
              }
              continue;
            }
            decls.delete(k); // 나중에 이긴 선언이 Map 순서에서도 뒤로 가게
            decls.set(k, resolveVars(v, sheet.vars));
          }
        }
      }
      entry = { id: cache.size, style: toStyle(decls, el.localName) };
      cache.set(key, entry);
    }
    return entry;
  };
  return (el) => entryOf(el).style;
};
