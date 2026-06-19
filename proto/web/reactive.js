// Quble 반응성 런타임 (실험). runtime.js(죽은 렌더)와 별개로, 살아있는 인스턴스를 만든다.
//
// 차이: renderComponent는 qubb를 한 번 실행해 DOM을 토해내고 끝(죽은 출력). 여기 createComponent는
// 정의를 준비하고 render 함수를 돌려준다. render(store, paths)가 살아있는 DOM을 만들고, TEXT_VAR
// 자리마다 "값이 바뀌면 그 노드를 갱신하는 함수"를 leafIndex에 구독시킨다. 이후 set(leafIndex, v)가
// 그 함수들을 호출한다.
//
// 세 인덱스 (REACTIVITY.md §1~§3):
//   offset    — 컴포넌트 로컬 (qubb의 TEXT_VAR idx). paths의 배열 인덱스.
//   path      — store 내 경로 ('a', 'list.0.name'). use-site가 render에 넘긴다.
//   leafIndex — 평탄 전역 (set이 쓰는 것). resolve가 path에 lazy 발급.
// offset→path는 render 인자(paths), path→leafIndex는 resolve(lazy·캐시·공유)가 잇는다.
//
// 포맷/opcode는 runtime.js와 동일한 qubb 계약. 기존 코드 불변 — 여기 독립 구현.

const TAGS = ["div", "span", "p", "h1", "h2", "h3", "a", "ul", "li", "button", "article", "img"];
const ATTRS = ["class", "id", "src", "alt", "href", "type", "name", "value", "title", "style", "placeholder"];

const OP = {
  HALT: 0x00,
  ELEM_OPEN: 0x01,
  ATTR_G: 0x02,
  ELEM_CLOSE_OPEN: 0x03,
  TEXT: 0x04,
  ELEM_END: 0x05,
  RENDER: 0x06,
  ATTR_L: 0x07,
  TEXT_VAR: 0x08,
  ATTR_G_VAR: 0x09,
  ATTR_L_VAR: 0x0a,
  PUSH_ARG: 0x0b,
};

// ── pub/sub ───────────────────────────────────────────────────────────
// leaves[leafIndex] = 평탄 원시값. subscribers[leafIndex] = 갱신 함수들((v)=>...).
// pathCache[path] = leafIndex. 같은 path는 한 leafIndex로 귀결(공유).

const leaves = [];
const subscribers = []; // leafIndex → [(v)=>void, ...]
const pathCache = new Map(); // path → leafIndex

// publish: 리프값을 갱신하고 구독 함수를 모두 호출. (diff 없음 — 구독자만 직접 실행)
export function set(leafIndex, value) {
  leaves[leafIndex] = value;
  const subs = subscribers[leafIndex];
  if (subs) {
    for (const fn of subs) fn(value);
  }
}

function subscribe(leafIndex, fn) {
  (subscribers[leafIndex] ??= []).push(fn);
}

// path를 leafIndex로 해석(lazy). 처음 보는 path면 새 leafIndex를 발급하고 store에서 값을 적재한다.
// 이미 본 path면 그 leafIndex를 재사용 → 다른 컴포넌트가 같은 path를 바인딩하면 같은 리프(공유).
function resolve(store, path) {
  let leafIndex = pathCache.get(path);
  if (leafIndex !== undefined) return leafIndex;
  leafIndex = leaves.length;
  leaves[leafIndex] = readPath(store, path);
  pathCache.set(path, leafIndex);
  return leafIndex;
}

// 'a.b.0' 같은 점-경로로 store를 따라 내려가 원시값을 읽는다.
function readPath(store, path) {
  let cur = store;
  for (const key of path.split(".")) cur = cur[key];
  return cur;
}

// ── 디코드 (runtime.js decode와 동일 포맷) ────────────────────────────

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  take(n) {
    const s = this.b.subarray(this.pos, this.pos + n);
    if (s.length !== n) throw new Error("unexpected eof");
    this.pos += n;
    return s;
  }
  u16() {
    const s = this.take(2);
    return s[0] | (s[1] << 8);
  }
  u32() {
    const s = this.take(4);
    return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0;
  }
  str() {
    const len = this.u16();
    return new TextDecoder().decode(this.take(len));
  }
}

function decode(bytes) {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (!(magic[0] === 0x51 && magic[1] === 0x42 && magic[2] === 0x4c && magic[3] === 0x00)) {
    throw new Error("bad magic"); // "QBL\0"
  }
  const version = r.u16();
  if (version !== 0) throw new Error("bad version " + version);

  const poolCount = r.u16();
  const pool = [];
  for (let i = 0; i < poolCount; i++) pool.push(r.str());

  const defCount = r.u16();
  const defs = [];
  for (let i = 0; i < defCount; i++) {
    defs.push({ nameIdx: r.u16(), codeOff: r.u32(), codeLen: r.u32() });
  }

  const codeLen = r.u32();
  const code = r.take(codeLen);
  return { pool, defs, code };
}

// ── 인스턴스화 ────────────────────────────────────────────────────────
// build: 한 정의를 실행해 살아있는 DOM을 만든다. TEXT_VAR 자리는 path를 resolve해 구독한다.
//   store: 원본 데이터 객체.  paths: offset → store path 매핑(배열, 인덱스=offset).

function build(module, compId, store, paths) {
  const def = module.defs[compId];
  if (!def) throw new Error("bad component " + compId);
  const code = module.code.subarray(def.codeOff, def.codeOff + def.codeLen);

  const fragment = document.createDocumentFragment();
  const stack = [fragment];
  let pending = null;
  // 자식에게 넘길 인자 버퍼. PUSH_ARG가 부모 paths[offset]을 쌓고, RENDER가 소비.
  let args = [];
  let pc = 0;

  const u16at = () => {
    const v = code[pc] | (code[pc + 1] << 8);
    pc += 2;
    return v;
  };
  const top = () => stack[stack.length - 1];

  // 변수 바인딩 공통부: offset → leafIndex로 해석하고 초기값을 돌려준다. update는 호출처가 준다
  // (텍스트면 textContent, 속성이면 setAttribute) — 그 함수를 그 리프에 구독시킨다.
  const bindVar = (offset, update) => {
    const path = paths[offset];
    if (path === undefined) throw new Error("no path for offset " + offset);
    const leafIndex = resolve(store, path);
    const initial = leaves[leafIndex] ?? "";
    subscribe(leafIndex, update);
    return initial;
  };

  while (pc < code.length) {
    const op = code[pc++];
    switch (op) {
      case OP.HALT:
        pc = code.length;
        break;
      case OP.ELEM_OPEN: {
        pending = document.createElement(TAGS[u16at()]);
        break;
      }
      case OP.ATTR_G: {
        const name = ATTRS[u16at()];
        pending.setAttribute(name, module.pool[u16at()]);
        break;
      }
      case OP.ATTR_L: {
        const name = module.pool[u16at()];
        pending.setAttribute(name, module.pool[u16at()]);
        break;
      }
      case OP.ATTR_G_VAR: {
        const name = ATTRS[u16at()];
        const el = pending;
        const v = bindVar(u16at(), (v) => el.setAttribute(name, v));
        el.setAttribute(name, v);
        break;
      }
      case OP.ATTR_L_VAR: {
        const name = module.pool[u16at()];
        const el = pending;
        const v = bindVar(u16at(), (v) => el.setAttribute(name, v));
        el.setAttribute(name, v);
        break;
      }
      case OP.ELEM_CLOSE_OPEN: {
        top().appendChild(pending);
        stack.push(pending);
        pending = null;
        break;
      }
      case OP.TEXT: {
        top().appendChild(document.createTextNode(module.pool[u16at()]));
        break;
      }
      case OP.TEXT_VAR: {
        const node = document.createTextNode("");
        // 구독자 = 이 노드를 갱신하는 함수. set(leafIndex, v)가 이걸 호출한다.
        node.textContent = bindVar(u16at(), (v) => (node.textContent = v));
        top().appendChild(node);
        break;
      }
      case OP.ELEM_END: {
        stack.pop();
        break;
      }
      case OP.PUSH_ARG: {
        // 부모 offset → 부모 paths[offset](path 문자열)을 자식 인자로 쌓는다.
        const parentOffset = u16at();
        const path = paths[parentOffset];
        if (path === undefined) throw new Error("no path for offset " + parentOffset);
        args.push(path);
        break;
      }
      case OP.RENDER: {
        const childCompId = u16at();
        // 쌓인 인자(부모 path들)를 자식 paths로 넘겨 인스턴스화. store는 같은 루트를 공유하므로
        // 같은 path는 자식에서도 같은 leafIndex로 resolve된다(공유 성립). 인자 버퍼는 비운다.
        const childPaths = args;
        args = [];
        top().appendChild(build(module, childCompId, store, childPaths));
        break;
      }
      default:
        throw new Error("bad opcode 0x" + op.toString(16));
    }
  }
  return fragment;
}

// 공개: qubb 바이트·진입 컴포넌트 ID로 정의를 준비하고 render 함수를 돌려준다.
// render(store, paths) — store는 원본 데이터, paths[offset]는 그 offset이 가리키는 store 경로.
export function createComponent(bytes, compId) {
  const module = decode(bytes);
  return (store, paths) => build(module, compId, store, paths);
}
