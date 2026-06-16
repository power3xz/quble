//! Opcode 정의. 값은 BYTECODE.md §5와 일치해야 한다.

/// 1바이트 opcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Op {
    Halt = 0x00,
    ElemOpen = 0x01,
    Attr = 0x02,
    ElemCloseOpen = 0x03,
    Text = 0x04,
    ElemEnd = 0x05,
    Render = 0x06,
}

impl Op {
    /// 바이트에서 opcode로. 알 수 없는 값이면 None.
    pub fn from_u8(b: u8) -> Option<Op> {
        Some(match b {
            0x00 => Op::Halt,
            0x01 => Op::ElemOpen,
            0x02 => Op::Attr,
            0x03 => Op::ElemCloseOpen,
            0x04 => Op::Text,
            0x05 => Op::ElemEnd,
            0x06 => Op::Render,
            _ => return None,
        })
    }
}
