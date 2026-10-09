// qubb 바이트를 TModule로 디코드한다. 포맷은 core/BYTECODE.md.

// FieldValue ref 출처 태그(Rust serialize <REF>와 대칭). ref마다 태그 1바이트 + payload.
// 슬롯 해석방법(STORE/CONST)과 다른 층이다 - Scope 슬롯의 실제 kind는 argumentSourcePairs가 정한다.
const FV_SCOPE = 0;
export const FV_CONST = 1;
export const FV_RAW = 2;
export const FV_EXPR = 3;

// 타입 테이블 엔트리 태그(BYTECODE.md #4). Rust read_type 대칭.
const TYPE_SCALAR = 0;
const TYPE_OBJECT = 1;
const TYPE_ARRAY = 2;

export type TField = [number, number];
export type TType = { tag: "scalar" } | { tag: "object"; fields: TField[] } | { tag: "array"; elemTypeRef: number };
export type TRef = { kind: number; ref: number; offset: number };
export type TFieldEntry = { nameConstIndex: number; typeRef: number; ref: TRef };
export type TEventEntry = { nameConstIndex: number; fields: TFieldEntry[] };
// 조립 step 하나 - [STEP_*, key, elemSteps?]. STEP_* 상수와 의미는 runtime.ts.
export type TStep = [number, string | null, TStep[]?];
type TDef = {
  nameConstIndex: number;
  propsTypeRef: number;
  codeOff: number;
  codeLen: number;
  events: TEventEntry[];
  contexts: TEventEntry[];
  // 이 def가 쓰는 표현식들(후위 표기 바이트). IF_EXPR의 expr_index가 이 배열의 인덱스.
  exprs: Uint8Array[];
};
export type TModule = {
  code: Uint8Array;
  constpool: (string | number | boolean)[];
  types: TType[];
  compiledSteps: TStep[][];
  leafCounts: number[];
  defs: TDef[];
};

class Reader {
  bytes: Uint8Array;
  pos: number;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.pos = 0;
  }
  take(n: number): Uint8Array {
    const subarray = this.bytes.subarray(this.pos, this.pos + n);
    if (subarray.length !== n) {
      throw new Error("unexpected eof");
    }
    this.pos += n;
    return subarray;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u16(): number {
    const s = this.take(2);
    return s[0] | (s[1] << 8);
  }
  u32(): number {
    const s = this.take(4);
    return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0;
  }
  f64(): number {
    const s = this.take(8);
    return new DataView(s.buffer, s.byteOffset, 8).getFloat64(0, true);
  }
  str(): string {
    const len = this.u16();
    return new TextDecoder().decode(this.take(len));
  }
  // 상수풀 엔트리: 태그 1바이트로 타입을 정해 payload를 읽는다(Rust put_const의 역).
  // 런타임 값이 그대로 JS 값(string/number/boolean)이라 소비 지점은 타입을 다시 안 본다.
  constant(): string | number | boolean {
    const tag = this.u8();
    if (tag === 0) {
      return this.str();
    }
    if (tag === 1) {
      return this.f64();
    }
    if (tag === 2) {
      return this.u8() !== 0;
    }
    throw new Error(`bad const tag ${tag}`);
  }
}

// 타입 테이블 엔트리 하나를 읽는다. Scalar는 payload 없음, Object는 field_count +
// [(nameConstIndex, typeRef)], Array는 elem_type_ref. typeRef로 자식을 가리켜 중첩/공유(Rust put_type 대칭).
//
// @param r Reader
// @returns { tag: "scalar" } | { tag: "object", fields } | { tag: "array", elemTypeRef }
const readType = (reader: Reader): TType => {
  const tag = reader.u8();
  if (tag === TYPE_SCALAR) {
    return { tag: "scalar" };
  }
  if (tag === TYPE_OBJECT) {
    const count = reader.u16();
    const fields: TField[] = [];
    for (let i = 0; i < count; i++) {
      fields.push([reader.u16(), reader.u16()]);
    }
    return { tag: "object", fields };
  }
  if (tag === TYPE_ARRAY) {
    return { tag: "array", elemTypeRef: reader.u16() };
  }
  throw new Error(`bad type tag ${tag}`);
};

// field ref 하나를 읽는다 - 태그 1바이트 + payload(Rust read_ref 대칭). Scope는 부모 슬롯
// 위치(scopeIndex, offset), Const/Raw는 값 하나(u16), Expr는 exprIndex(u8). offset은 Scope만
// 의미 있어 나머진 0.
//
// @param r Reader
// @returns { kind, ref, offset } - ref: Scope=scopeIndex/Const=상수풀 인덱스/Raw=값/Expr=exprIndex
const readRef = (reader: Reader): TRef => {
  const tag = reader.u8();
  if (tag === FV_SCOPE) {
    return { kind: FV_SCOPE, ref: reader.u8(), offset: reader.u8() };
  }
  if (tag === FV_CONST) {
    return { kind: FV_CONST, ref: reader.u16(), offset: 0 };
  }
  if (tag === FV_RAW) {
    return { kind: FV_RAW, ref: reader.u16(), offset: 0 };
  }
  if (tag === FV_EXPR) {
    return { kind: FV_EXPR, ref: reader.u8(), offset: 0 };
  }
  throw new Error(`bad ref tag ${tag}`);
};

// 필드 목록을 읽는다 - field_count, [(nameConstIndex, typeRef, ref)]. 이벤트 payload와
// 컨텍스트가 같은 인코딩(Rust read_fields 대칭). 슬롯을 안 펼쳐 field당 ref 하나.
//
// @param r Reader
// @returns [{ nameConstIndex, typeRef, ref }]
const readFields = (reader: Reader): TFieldEntry[] => {
  const count = reader.u16();
  const fields: TFieldEntry[] = [];
  for (let i = 0; i < count; i++) {
    const nameConstIndex = reader.u16();
    const typeRef = reader.u16();
    const ref = readRef(reader);
    fields.push({ nameConstIndex, typeRef, ref });
  }
  return fields;
};

// qubb 바이트를 TModule로 디코드한다(core/BYTECODE.md 포맷).
export const decode = (bytes: Uint8Array): TModule => {
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (!(magic[0] === 0x51 && magic[1] === 0x42 && magic[2] === 0x4c && magic[3] === 0x00)) {
    throw new Error("bad magic"); // "QBL\0"
  }
  const version = r.u16();
  if (version !== 0) {
    throw new Error(`bad version ${version}`);
  }

  const poolCount = r.u16();
  const constpool = [];
  for (let i = 0; i < poolCount; i++) {
    constpool.push(r.constant());
  }

  // 타입 테이블(모듈 전역) - type_count, [ (tag, payload) ]. Rust read_type 대칭.
  const typeCount = r.u16();
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    types.push(readType(r));
  }

  const defCount = r.u16();
  const defs = [];
  for (let i = 0; i < defCount; i++) {
    const nameConstIndex = r.u16();
    // 이 comp props를 묶은 Object 타입(types 인덱스). defs[0]이 진입점 풀필 구조.
    const propsTypeRef = r.u16();
    const codeOff = r.u32();
    const codeLen = r.u32();
    // 이벤트 테이블 (BYTECODE.md #4) - event_count, [(nameConstIndex, fields)]
    const eventCount = r.u16();
    const events = [];
    for (let i = 0; i < eventCount; i++) {
      events.push({ nameConstIndex: r.u16(), fields: readFields(r) });
    }
    // 컨텍스트 테이블 - context_count, [(nameConstIndex, fields)]. fields는 이벤트와 같은 인코딩.
    const contextCount = r.u16();
    const contexts = [];
    for (let i = 0; i < contextCount; i++) {
      contexts.push({ nameConstIndex: r.u16(), fields: readFields(r) });
    }
    // 표현식 테이블 - expr_count:u8, [(len:u8, code)]. IF_EXPR의 expr_index가 이 배열의 인덱스.
    const exprCount = r.u8();
    const exprs = [];
    for (let i = 0; i < exprCount; i++) {
      exprs.push(r.take(r.u8()));
    }
    defs.push({ nameConstIndex, propsTypeRef, codeOff, codeLen, events, contexts, exprs });
  }

  const codeLen = r.u32();
  const code = r.take(codeLen);
  // compiledSteps: type_ref -> 조립 step 열 캐시. 발생 시점에 lazy로 채운다(안 터지는 이벤트의
  // 타입은 컴파일 안 함 - lazy build 결). 같은 type_ref는 한 번만 컴파일(dedup 이점 유지).
  // leafCounts: type_ref -> leaf 칸 수 캐시(refToSourcePairs가 객체를 몇 칸 펼칠지).
  return { constpool, types, defs, code, compiledSteps: [], leafCounts: [] };
};
