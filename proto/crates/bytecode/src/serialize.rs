//! 모듈 ↔ 바이트 직렬화. 리틀엔디안, 문자열은 u16 길이 접두 + UTF-8(BYTECODE.md §4).

use crate::module::{CompDef, ContextDef, EventDef, Field, FieldValue, Module};
use crate::pool::{Const, ConstPool};

const MAGIC: &[u8; 4] = b"QBL\0";
const VERSION: u16 = 0;

// 상수풀 엔트리 타입 태그(BYTECODE.md §4). 엔트리마다 앞에 1바이트.
const TAG_STR: u8 = 0;
const TAG_NUM: u8 = 1;
const TAG_BOOL: u8 = 2;

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    BadMagic,
    BadVersion(u16),
    UnexpectedEof,
    BadUtf8,
    BadConstTag(u8),
}

// ---- 인코딩 ----

pub fn encode(m: &Module) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    put_u16(&mut out, VERSION);

    // 상수풀 - 엔트리마다 타입 태그 1바이트 + 타입별 payload.
    put_u16(&mut out, m.pool.len() as u16);
    for c in m.pool.entries() {
        put_const(&mut out, c);
    }

    // 컴포넌트 테이블
    put_u16(&mut out, m.defs.len() as u16);
    for d in &m.defs {
        put_u16(&mut out, d.name_const_index);
        put_u32(&mut out, d.code_off);
        put_u32(&mut out, d.code_len);
        // 이벤트 테이블 (BYTECODE.md §4) - event_count, [(name_const_index, fields)]
        put_u16(&mut out, d.events.len() as u16);
        for e in &d.events {
            put_u16(&mut out, e.name_const_index);
            put_fields(&mut out, &e.fields);
        }
        // 컨텍스트 테이블 - context_count, [(name_const_index, fields)]. fields는 이벤트와 같은 인코딩.
        put_u16(&mut out, d.contexts.len() as u16);
        for c in &d.contexts {
            put_u16(&mut out, c.name_const_index);
            put_fields(&mut out, &c.fields);
        }
    }

    // 코드
    put_u32(&mut out, m.code.len() as u32);
    out.extend_from_slice(&m.code);

    out
}

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_u16(out, s.len() as u16);
    out.extend_from_slice(s.as_bytes());
}

/// 상수풀 엔트리: 타입 태그 1바이트 + payload. Str=u16 길이+UTF-8, Num=f64 8바이트(LE),
/// Bool=u8(0/1). 런타임은 태그로 뒤 바이트 해석을 정한다.
fn put_const(out: &mut Vec<u8>, c: &Const) {
    match c {
        Const::Str(s) => {
            out.push(TAG_STR);
            put_str(out, s);
        }
        Const::Num(n) => {
            out.push(TAG_NUM);
            out.extend_from_slice(&n.to_le_bytes());
        }
        Const::Bool(b) => {
            out.push(TAG_BOOL);
            out.push(*b as u8);
        }
    }
}

/// 필드 목록을 쓴다 - field_count, [(name_const_index, value)]. value는 FieldValue를 u16로
/// encode(MSB=const 여부). 이벤트 payload와 컨텍스트가 같은 인코딩을 공유한다.
fn put_fields(out: &mut Vec<u8>, fields: &[Field]) {
    put_u16(out, fields.len() as u16);
    for f in fields {
        put_u16(out, f.name_const_index);
        put_u16(out, f.value.encode());
    }
}

// ---- 디코딩 ----

pub fn decode(bytes: &[u8]) -> Result<Module, DecodeError> {
    let mut r = Reader { bytes, pos: 0 };

    if r.take(4)? != MAGIC {
        return Err(DecodeError::BadMagic);
    }
    let version = r.u16()?;
    if version != VERSION {
        return Err(DecodeError::BadVersion(version));
    }

    // 상수풀
    let pool_count = r.u16()?;
    let mut entries = Vec::with_capacity(pool_count as usize);
    for _ in 0..pool_count {
        entries.push(r.constant()?);
    }
    let pool = ConstPool::from_entries(entries);

    // 컴포넌트 테이블
    let def_count = r.u16()?;
    let mut defs = Vec::with_capacity(def_count as usize);
    for _ in 0..def_count {
        let name_const_index = r.u16()?;
        let code_off = r.u32()?;
        let code_len = r.u32()?;
        let event_count = r.u16()?;
        let mut events = Vec::with_capacity(event_count as usize);
        for _ in 0..event_count {
            let name_const_index = r.u16()?;
            events.push(EventDef { name_const_index, fields: read_fields(&mut r)? });
        }
        let context_count = r.u16()?;
        let mut contexts = Vec::with_capacity(context_count as usize);
        for _ in 0..context_count {
            let name_const_index = r.u16()?;
            contexts.push(ContextDef { name_const_index, fields: read_fields(&mut r)? });
        }
        defs.push(CompDef { name_const_index, code_off, code_len, events, contexts });
    }

    // 코드
    let code_len = r.u32()? as usize;
    let code = r.take(code_len)?.to_vec();

    Ok(Module::new(pool, defs, code))
}

/// 필드 목록을 읽는다 - field_count, [(name_const_index, value)]. value는 u16를 FieldValue로
/// decode(MSB=const 여부). 이벤트 payload와 컨텍스트가 같은 인코딩을 공유한다.
fn read_fields(r: &mut Reader) -> Result<Vec<Field>, DecodeError> {
    let field_count = r.u16()?;
    let mut fields = Vec::with_capacity(field_count as usize);
    for _ in 0..field_count {
        let name_const_index = r.u16()?;
        let value = FieldValue::decode(r.u16()?);
        fields.push(Field { name_const_index, value });
    }
    Ok(fields)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let end = self.pos.checked_add(n).ok_or(DecodeError::UnexpectedEof)?;
        let slice = self.bytes.get(self.pos..end).ok_or(DecodeError::UnexpectedEof)?;
        self.pos = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, DecodeError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    fn f64(&mut self) -> Result<f64, DecodeError> {
        let b = self.take(8)?;
        Ok(f64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn string(&mut self) -> Result<String, DecodeError> {
        let len = self.u16()? as usize;
        let b = self.take(len)?;
        std::str::from_utf8(b)
            .map(|s| s.to_string())
            .map_err(|_| DecodeError::BadUtf8)
    }

    /// 상수풀 엔트리: 태그 1바이트로 타입을 정하고 payload를 읽는다(put_const의 역).
    fn constant(&mut self) -> Result<Const, DecodeError> {
        match self.u8()? {
            TAG_STR => Ok(Const::Str(self.string()?)),
            TAG_NUM => Ok(Const::Num(self.f64()?)),
            TAG_BOOL => Ok(Const::Bool(self.u8()? != 0)),
            other => Err(DecodeError::BadConstTag(other)),
        }
    }
}
