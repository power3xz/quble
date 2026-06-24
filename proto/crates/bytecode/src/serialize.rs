//! 모듈 ↔ 바이트 직렬화. 리틀엔디안, 문자열은 u16 길이 접두 + UTF-8(BYTECODE.md §4).

use crate::module::{CompDef, EventDef, Module};
use crate::pool::ConstPool;

const MAGIC: &[u8; 4] = b"QBL\0";
const VERSION: u16 = 0;

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    BadMagic,
    BadVersion(u16),
    UnexpectedEof,
    BadUtf8,
}

// ---- 인코딩 ----

pub fn encode(m: &Module) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    put_u16(&mut out, VERSION);

    // 상수풀
    put_u16(&mut out, m.pool.len() as u16);
    for s in m.pool.entries() {
        put_str(&mut out, s);
    }

    // 컴포넌트 테이블
    put_u16(&mut out, m.defs.len() as u16);
    for d in &m.defs {
        put_u16(&mut out, d.name_idx);
        put_u32(&mut out, d.code_off);
        put_u32(&mut out, d.code_len);
        // 이벤트 테이블 (BYTECODE.md §4) — event_count, [(name_idx, payload_count, [(field_idx, offset)])]
        put_u16(&mut out, d.events.len() as u16);
        for e in &d.events {
            put_u16(&mut out, e.name_idx);
            put_u16(&mut out, e.payload.len() as u16);
            for (field_idx, offset) in &e.payload {
                put_u16(&mut out, *field_idx);
                put_u16(&mut out, *offset);
            }
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
        entries.push(r.string()?);
    }
    let pool = ConstPool::from_entries(entries);

    // 컴포넌트 테이블
    let def_count = r.u16()?;
    let mut defs = Vec::with_capacity(def_count as usize);
    for _ in 0..def_count {
        let name_idx = r.u16()?;
        let code_off = r.u32()?;
        let code_len = r.u32()?;
        let event_count = r.u16()?;
        let mut events = Vec::with_capacity(event_count as usize);
        for _ in 0..event_count {
            let name_idx = r.u16()?;
            let payload_count = r.u16()?;
            let mut payload = Vec::with_capacity(payload_count as usize);
            for _ in 0..payload_count {
                payload.push((r.u16()?, r.u16()?));
            }
            events.push(EventDef { name_idx, payload });
        }
        defs.push(CompDef { name_idx, code_off, code_len, events });
    }

    // 코드
    let code_len = r.u32()? as usize;
    let code = r.take(code_len)?.to_vec();

    Ok(Module::new(pool, defs, code))
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

    fn string(&mut self) -> Result<String, DecodeError> {
        let len = self.u16()? as usize;
        let b = self.take(len)?;
        std::str::from_utf8(b)
            .map(|s| s.to_string())
            .map_err(|_| DecodeError::BadUtf8)
    }
}
