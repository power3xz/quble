// Quble 클라이언트 VM (JS). Rust vm 크레이트와 같은 qubb 포맷을 읽어 실제 DOM을 만든다.
// "기술 중립(어떤 언어로도 VM 구현)"의 증명 — 같은 [u8] 계약을 JS가 해석.
// 포맷/opcode는 proto/BYTECODE.md, Rust 구현은 crates/bytecode·crates/vm 참고.

// 내장 태그 테이블 (crates/bytecode/src/tags.rs와 동일 순서·고정).
const TAGS = ["div", "span", "p", "h1", "h2", "h3", "a", "ul", "li", "button", "article", "img"];

// opcode (crates/bytecode/src/opcode.rs와 동일).
const OP = {
  HALT: 0x00,
  ELEM_OPEN: 0x01,
  ATTR: 0x02,
  ELEM_CLOSE_OPEN: 0x03,
  TEXT: 0x04,
  ELEM_END: 0x05,
  RENDER: 0x06,
};

// 바이트 리더 (리틀엔디안).
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

// qubb 바이트 → 모듈 객체 { pool, defs, code }. (Rust bytecode::decode와 대응)
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

// 한 컴포넌트 정의를 실행해 DOM 노드(또는 fragment)를 만든다. (Rust vm::exec와 대응)
function exec(module, compId) {
  const def = module.defs[compId];
  if (!def) throw new Error("bad component " + compId);
  const code = module.code.subarray(def.codeOff, def.codeOff + def.codeLen);

  const fragment = document.createDocumentFragment();
  const stack = [fragment]; // 현재 부모 스택
  let pending = null; // 아직 자식 영역에 안 들어간(여는 태그 진행 중) 요소
  let pc = 0;

  const u16at = () => {
    const v = code[pc] | (code[pc + 1] << 8);
    pc += 2;
    return v;
  };
  const top = () => stack[stack.length - 1];

  while (pc < code.length) {
    const op = code[pc++];
    switch (op) {
      case OP.HALT:
        pc = code.length;
        break;
      case OP.ELEM_OPEN: {
        const tag = TAGS[u16at()];
        pending = document.createElement(tag);
        break;
      }
      case OP.ATTR: {
        const name = module.pool[u16at()];
        const value = module.pool[u16at()];
        pending.setAttribute(name, value);
        break;
      }
      case OP.ELEM_CLOSE_OPEN: {
        top().appendChild(pending);
        stack.push(pending);
        pending = null;
        break;
      }
      case OP.TEXT: {
        const text = module.pool[u16at()];
        top().appendChild(document.createTextNode(text));
        break;
      }
      case OP.ELEM_END: {
        u16at(); // 태그 ID — DOM에선 스택으로 닫으므로 사용 안 함
        stack.pop();
        break;
      }
      case OP.RENDER: {
        const child = u16at();
        top().appendChild(exec(module, child));
        break;
      }
      default:
        throw new Error("bad opcode 0x" + op.toString(16));
    }
  }
  return fragment;
}

// 공개: qubb 바이트와 진입 컴포넌트 ID로 DOM 노드를 만든다.
export function renderComponent(bytes, compId) {
  const module = decode(bytes);
  return exec(module, compId);
}
