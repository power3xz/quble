// qubb(컴파일된 바이너리) -> qubc(소스 형태) 디컴파일러.
//
// 바이트코드에는 심볼 이름이 없다 — props 변수는 scope 인덱스로만 남는다(BYTECODE.md §5).
// 그래서 변수 참조는 원래 이름을 복원할 수 없어 arg0, arg1...(인덱스)로 보여준다. 그 인덱스를
// 참조하면 props 선언이 있어야 정합하므로, 코드에서 쓰인 최대 offset까지 props { arg0..argN }을
// 함께 복원한다. 합성(RENDER)은 comp_id로 자식 def명을 복원한다(별칭은 미구현이라 일반 컴포넌트).
//
// 포맷·테이블은 runtime.js와 같아야 한다(같은 계약). 여기선 디코드만 하므로 독립 디코더를 둔다.

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
  IF: 0x0c,
  ELSE: 0x0d,
  IF_END: 0x0e,
  LOAD_RES: 0x0f,
  FOR: 0x10,
  FOR_END: 0x11,
};

// ── 디코드 (proto/BYTECODE.md 포맷) ───────────────────────────────────
class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  take(n) {
    const s = this.b.subarray(this.pos, this.pos + n);
    if (s.length !== n) {
      throw new Error("unexpected eof");
    }
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

// qubb 바이트를 모듈로 디코드한다(상수풀·def 테이블·코드).
//
// @param bytes qubb 바이트 (proto/BYTECODE.md 포맷)
// @returns     { pool, defs, code }
const decode = (bytes) => {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (!(magic[0] === 0x51 && magic[1] === 0x42 && magic[2] === 0x4c && magic[3] === 0x00)) {
    throw new Error("bad magic"); // "QBL\0"
  }
  const version = r.u16();
  if (version !== 0) {
    throw new Error("bad version " + version);
  }

  const poolCount = r.u16();
  const pool = [];
  for (let i = 0; i < poolCount; i++) {
    pool.push(r.str());
  }

  const defCount = r.u16();
  const defs = [];
  for (let i = 0; i < defCount; i++) {
    defs.push({ nameIdx: r.u16(), codeOff: r.u32(), codeLen: r.u32() });
  }

  const codeLen = r.u32();
  const code = r.take(codeLen);
  return { pool, defs, code };
};

// 속성값 안의 따옴표를 이스케이프해 qubc 문자열 리터럴로 만든다.
const quote = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// 한 def의 코드를 qubc template 본문(들여쓴 줄 배열)으로 디컴파일한다.
//
// 트리는 항상 올바르게 중첩되므로(컴파일러 보장) 깊이 카운트만으로 들여쓰기를 복원한다.
// 여는 태그(ELEM_OPEN~ELEM_CLOSE_OPEN)는 속성을 모아 한 줄로 합치고, 텍스트/변수/합성은 자식 줄로
// 흐른다. 자식이 없으면(바로 ELEM_END) 한 줄로 닫는다. 참조하는 최대 scope offset도 함께 집계해
// props 복원에 쓴다.
//
// @param module 디코드된 모듈(pool로 텍스트·자식명 복원)
// @param def    이 컴포넌트 def
// @returns      { lines: string[], maxArg: number } maxArg = 쓰인 최대 offset(-1이면 없음)
const decompileBody = (module, def) => {
  const code = module.code.subarray(def.codeOff, def.codeOff + def.codeLen);
  const lines = [];
  let pc = 0;
  let depth = 1; // template { 안 -> 기본 1단 들여쓰기
  let maxArg = -1;
  const uses = []; // 합성하는 자식 컴포넌트명(중복 없이, 등장 순서). use 선언 복원용.
  const resIds = []; // LOAD_RES가 가리킨 resId(중복 없이, 등장 순서). 경로는 qubb에 없어 placeholder.
  const argTypes = []; // offset -> "bool"|"number"|"string". seenArg가 용도로 채운다.

  const u16 = () => {
    const v = code[pc] | (code[pc + 1] << 8);
    pc += 2;
    return v;
  };
  // arg 등장을 기록한다. type은 용도("bool"=IF, "number"=FOR, "string"=그 외).
  // 같은 arg가 여러 곳이면 if/for의 강한 타입이 string을 덮어쓴다(역방향은 안 덮음).
  const seenArg = (offset, type) => {
    if (offset > maxArg) {
      maxArg = offset;
    }
    if (argTypes[offset] === undefined || type !== "string") {
      argTypes[offset] = type;
    }
    return "arg" + offset;
  };
  const pad = () => "  ".repeat(depth);
  // 자식 def명 복원(별칭 미구현 -> 일반 컴포넌트명).
  const compName = (compId) => {
    const childDef = module.defs[compId];
    return childDef ? module.pool[childDef.nameIdx] : "Comp" + compId;
  };

  // 여는 태그를 누적하는 상태. ELEM_OPEN이 열고 ATTR_*가 채우고 CLOSE_OPEN/END가 닫는다.
  let tag = null;
  let attrs = [];

  // 자식 인자 누적(PUSH_ARG -> RENDER). 자식 props offset 순서대로 쌓인다.
  let pendingArgs = [];

  // 여는 태그 한 줄을 만든다. selfClose면 한 줄로 닫고(`div() {}` 대신 빈 본문),
  // 아니면 `{`를 열고 depth를 늘린다.
  const flushOpen = (selfClose) => {
    const attrStr = attrs.join(", ");
    if (selfClose) {
      lines.push(pad() + tag + "(" + attrStr + ") {}");
    } else {
      lines.push(pad() + tag + "(" + attrStr + ") {");
      depth += 1;
    }
    tag = null;
    attrs = [];
  };

  while (pc < code.length) {
    const op = code[pc++];
    switch (op) {
      case OP.HALT:
        pc = code.length;
        break;
      case OP.ELEM_OPEN:
        tag = TAGS[u16()];
        attrs = [];
        break;
      case OP.ATTR_G:
        attrs.push(ATTRS[u16()] + "=" + quote(module.pool[u16()]));
        break;
      case OP.ATTR_L:
        attrs.push(module.pool[u16()] + "=" + quote(module.pool[u16()]));
        break;
      case OP.ATTR_G_VAR:
        attrs.push(ATTRS[u16()] + "={" + seenArg(u16(), "string") + "}");
        break;
      case OP.ATTR_L_VAR:
        attrs.push(module.pool[u16()] + "={" + seenArg(u16(), "string") + "}");
        break;
      case OP.ELEM_CLOSE_OPEN:
        flushOpen(false);
        break;
      case OP.TEXT:
        lines.push(pad() + quote(module.pool[u16()]));
        break;
      case OP.TEXT_VAR:
        lines.push(pad() + "{" + seenArg(u16(), "string") + "}");
        break;
      case OP.ELEM_END:
        depth -= 1;
        lines.push(pad() + "}");
        break;
      case OP.PUSH_ARG:
        pendingArgs.push(seenArg(u16(), "string"));
        break;
      case OP.RENDER: {
        const name = compName(u16());
        if (!uses.includes(name)) {
          uses.push(name);
        }
        // 합성 문법 복원: `자식prop={부모값}` 키워드 바인딩. 자식 prop명은 바이트코드에 없어 PUSH_ARG
        // 등장 순서 i(= 자식 offset 0,1,2…)를 arg_i로, 값은 operand의 부모 argN으로 쓴다(BYTECODE.md
        // §5: use-site가 자식 props를 자식 offset 순서로 전부 바인딩). operand가 뒤섞이거나(arg0={arg3})
        // 같은 부모값을 여러 자식 prop에 줘도(arg0={arg5} arg1={arg5}) 자식 offset은 i라 안 깨진다.
        // 자식명은 comp_id로 def 테이블에서 복원하고(compName), 슬롯은 언어상 항상 비어(컴파일러
        // parse.rs: 슬롯 미지원) {}로 닫는다.
        const binds = pendingArgs.map((parentArg, childOffset) => "arg" + childOffset + "={" + parentArg + "}");
        pendingArgs = [];
        lines.push(pad() + name + "(" + binds.join(" ") + ") {}");
        break;
      }
      case OP.IF:
        lines.push(pad() + "@if " + seenArg(u16(), "bool") + " {");
        depth += 1;
        break;
      case OP.ELSE:
        depth -= 1;
        lines.push(pad() + "} @else {");
        depth += 1;
        break;
      case OP.IF_END:
        depth -= 1;
        lines.push(pad() + "}");
        break;
      case OP.LOAD_RES: {
        // 리소스 로드는 본문이 아니라 파일 헤더의 use로 복원된다(코드 앞머리). resId만 모은다 —
        // 경로는 qubb에 없어 use "res<id>" placeholder로 낸다.
        const resId = u16();
        if (!resIds.includes(resId)) {
          resIds.push(resId);
        }
        break;
      }
      case OP.FOR:
        lines.push(pad() + "@for " + seenArg(u16(), "number") + " {");
        depth += 1;
        break;
      case OP.FOR_END:
        depth -= 1;
        lines.push(pad() + "}");
        break;
      default:
        throw new Error("bad opcode 0x" + op.toString(16));
    }
  }
  return { lines, maxArg, uses, resIds, argTypes };
};

// 한 컴포넌트 def를 완전한 qubc 소스 문자열로 디컴파일한다.
//
// props는 본문이 참조한 최대 offset까지 arg0..argN으로 복원한다(인덱스 정합). 본문이 변수를 안
// 쓰면 props 블록을 생략한다. 합성하는 자식은 상단에 use로 선언한다 — 파일 경로는 바이트코드에
// 없어 컴포넌트명의 qubc를 플랫 구조에서 참조한다고 가정한다("./<Name>.qubc").
//
// @param module 디코드된 모듈
// @param compId 컴포넌트 def 인덱스
// @returns      qubc 소스 문자열
export const decompileComponent = (module, compId) => {
  const def = module.defs[compId];
  if (!def) {
    throw new Error("bad component " + compId);
  }
  const name = module.pool[def.nameIdx];
  const { lines, maxArg, uses, resIds } = decompileBody(module, def);

  const out = [];
  // 리소스 use(경로는 qubb에 없어 resId placeholder). 컴포넌트 import보다 위에 둔다.
  for (const resId of resIds) {
    out.push('use "res' + resId + '"');
  }
  for (const childName of uses) {
    out.push('use ' + childName + ' from "./' + childName + '.qubc"');
  }
  if (uses.length > 0 || resIds.length > 0) {
    out.push("");
  }
  out.push("component " + name + " {");
  if (maxArg >= 0) {
    const args = [];
    for (let i = 0; i <= maxArg; i++) {
      args.push("arg" + i);
    }
    out.push("  props { " + args.join(", ") + " }");
  }
  out.push("  template {");
  for (const line of lines) {
    out.push("  " + line);
  }
  out.push("  }");
  out.push("}");
  return out.join("\n");
};

// 한 컴포넌트의 arg 목록을 용도 추론 타입과 함께 돌려준다(프리뷰 입력 UI용).
//
// 참조된 arg는 0..maxArg 전부 포함한다(인덱스 정합). 타입은 쓰인 위치에서 추론한다 —
// IF=bool, FOR=number, 그 외(텍스트·속성·합성 인자)=string. 한 arg가 여러 곳이면 if/for의
// 강한 타입이 우선한다(seenArg). 어디에도 안 쓰인 중간 arg는 string으로 채운다.
//
// @param module 디코드된 모듈
// @param compId 컴포넌트 def 인덱스
// @returns      Array<{ name: string, type: "bool"|"number"|"string" }>
export const componentArgs = (module, compId) => {
  const def = module.defs[compId];
  if (!def) {
    throw new Error("bad component " + compId);
  }
  const { maxArg, argTypes } = decompileBody(module, def);
  const args = [];
  for (let i = 0; i <= maxArg; i++) {
    args.push({ name: "arg" + i, type: argTypes[i] ?? "string" });
  }
  return args;
};

// qubb 바이트에서 컴포넌트 목록을 뽑는다([{ compId, name }]).
//
// @param bytes qubb 바이트
// @returns     { module, components }
export const inspect = (bytes) => {
  const module = decode(bytes);
  const components = module.defs.map((def, compId) => ({
    compId,
    name: module.pool[def.nameIdx],
  }));
  return { module, components };
};
