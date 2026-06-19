//! Quble SSR 렌더러: 직렬화된 바이트코드(`&[u8]`)를 받아 HTML 문자열로 렌더한다.
//! 출력은 SSR 문자열(브라우저 DOM 아님). 일회성·무상태 순수 함수. 상세는 proto/BYTECODE.md.

use bytecode::{DecodeError, Module, Op};

#[derive(Debug, PartialEq, Eq)]
pub enum RenderError {
    /// 바이트코드 디코드 실패.
    Decode(DecodeError),
    /// 알 수 없는 opcode 바이트.
    BadOpcode(u8),
    /// operand 읽다가 코드 끝.
    UnexpectedEof,
    /// 범위 밖 컴포넌트 ID.
    BadComponent(u16),
    /// 범위 밖 상수풀 인덱스.
    BadConst(u16),
    /// 범위 밖 내장 태그 ID.
    BadTag(u16),
    /// 범위 밖 전역 속성명 ID.
    BadAttr(u16),
    /// 여는 태그 없이 END (스택 불균형 — 손상된 바이트코드).
    UnbalancedEnd,
    /// 범위 밖 scope 인덱스 (주입 값 부족).
    BadScope(u16),
}

impl From<DecodeError> for RenderError {
    fn from(e: DecodeError) -> Self {
        RenderError::Decode(e)
    }
}

/// 바이트코드를 디코드하고 comp_id를 진입점으로 렌더해 HTML 문자열을 만든다.
/// scope는 런타임 주입 값 배열 — `TEXT_VAR idx`가 `scope[idx]`를 참조한다.
pub fn render_to_string(bytes: &[u8], comp_id: u16, scope: &[String]) -> Result<String, RenderError> {
    let module = bytecode::decode(bytes)?;
    let mut out = String::new();
    exec(&module, comp_id, scope, &mut out)?;
    Ok(out)
}

/// 한 컴포넌트 정의의 코드를 실행한다. RENDER를 만나면 재귀한다.
fn exec(module: &Module, comp_id: u16, scope: &[String], out: &mut String) -> Result<(), RenderError> {
    let def = module.def(comp_id).ok_or(RenderError::BadComponent(comp_id))?;
    let start = def.code_off as usize;
    let end = start + def.code_len as usize;
    let code = &module.code[start..end];

    // 연 태그를 쌓아둔다. END는 operand 없이 top을 닫는다(중첩 보장).
    let mut tag_stack: Vec<&str> = Vec::new();
    // 자식에게 넘길 인자 버퍼. PUSH_ARG가 부모 scope[offset] 값을 쌓고, RENDER가 소비.
    let mut args: Vec<String> = Vec::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let op = Op::from_u8(code[pc]).ok_or(RenderError::BadOpcode(code[pc]))?;
        pc += 1;
        match op {
            Op::Halt => break,
            Op::ElemOpen => {
                let tag = read_u16(code, &mut pc)?;
                let name = bytecode::tags::tag_name(tag).ok_or(RenderError::BadTag(tag))?;
                tag_stack.push(name);
                out.push('<');
                out.push_str(name);
            }
            Op::AttrG => {
                let name = read_u16(code, &mut pc)?;
                let value = read_u16(code, &mut pc)?;
                let name = bytecode::attrs::attr_name(name).ok_or(RenderError::BadAttr(name))?;
                emit_attr(name, get_const(module, value)?, out);
            }
            Op::AttrL => {
                let name = read_u16(code, &mut pc)?;
                let value = read_u16(code, &mut pc)?;
                emit_attr(get_const(module, name)?, get_const(module, value)?, out);
            }
            Op::AttrGVar => {
                let name = read_u16(code, &mut pc)?;
                let idx = read_u16(code, &mut pc)?;
                let name = bytecode::attrs::attr_name(name).ok_or(RenderError::BadAttr(name))?;
                let val = scope.get(idx as usize).ok_or(RenderError::BadScope(idx))?;
                emit_attr(name, val, out);
            }
            Op::AttrLVar => {
                let name = read_u16(code, &mut pc)?;
                let idx = read_u16(code, &mut pc)?;
                let val = scope.get(idx as usize).ok_or(RenderError::BadScope(idx))?;
                emit_attr(get_const(module, name)?, val, out);
            }
            Op::ElemCloseOpen => out.push('>'),
            Op::Text => {
                let text = read_u16(code, &mut pc)?;
                escape_text(get_const(module, text)?, out);
            }
            Op::TextVar => {
                let idx = read_u16(code, &mut pc)?;
                let val = scope.get(idx as usize).ok_or(RenderError::BadScope(idx))?;
                escape_text(val, out);
            }
            Op::ElemEnd => {
                let name = tag_stack.pop().ok_or(RenderError::UnbalancedEnd)?;
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
            Op::PushArg => {
                let offset = read_u16(code, &mut pc)?;
                let val = scope.get(offset as usize).ok_or(RenderError::BadScope(offset))?;
                args.push(val.clone());
            }
            Op::Render => {
                let child_comp_id = read_u16(code, &mut pc)?;
                // 쌓인 인자(부모 값들)를 자식 scope로 넘기고 버퍼를 비운다.
                let child_scope = std::mem::take(&mut args);
                exec(module, child_comp_id, &child_scope, out)?;
            }
        }
    }
    Ok(())
}

fn read_u16(code: &[u8], pc: &mut usize) -> Result<u16, RenderError> {
    let b = code.get(*pc..*pc + 2).ok_or(RenderError::UnexpectedEof)?;
    *pc += 2;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

/// ` name="value"` (값 이스케이프 포함) 출력.
fn emit_attr(name: &str, value: &str, out: &mut String) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    escape_attr(value, out);
    out.push('"');
}

fn get_const(module: &Module, idx: u16) -> Result<&str, RenderError> {
    module.pool.get(idx).ok_or(RenderError::BadConst(idx))
}

/// 텍스트 노드 이스케이프: `& < >`.
fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

/// 속성값 이스케이프: 텍스트 규칙 + `"`.
fn escape_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytecode::{encode, CompDef, ConstPool, Module};

    /// 바이트코드를 손으로 짜는 어셈블러 (파서 전까지 테스트용).
    struct Asm {
        code: Vec<u8>,
    }
    impl Asm {
        fn new() -> Self {
            Self { code: Vec::new() }
        }
        fn open(&mut self, tag: u16) -> &mut Self {
            self.code.push(Op::ElemOpen as u8);
            self.code.extend_from_slice(&tag.to_le_bytes());
            self
        }
        fn attr(&mut self, n: u16, v: u16) -> &mut Self {
            self.code.push(Op::AttrL as u8);
            self.code.extend_from_slice(&n.to_le_bytes());
            self.code.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn close_open(&mut self) -> &mut Self {
            self.code.push(Op::ElemCloseOpen as u8);
            self
        }
        fn text(&mut self, t: u16) -> &mut Self {
            self.code.push(Op::Text as u8);
            self.code.extend_from_slice(&t.to_le_bytes());
            self
        }
        fn text_var(&mut self, idx: u16) -> &mut Self {
            self.code.push(Op::TextVar as u8);
            self.code.extend_from_slice(&idx.to_le_bytes());
            self
        }
        /// 전역 속성명 ID + scope offset.
        fn attr_g_var(&mut self, name: u16, idx: u16) -> &mut Self {
            self.code.push(Op::AttrGVar as u8);
            self.code.extend_from_slice(&name.to_le_bytes());
            self.code.extend_from_slice(&idx.to_le_bytes());
            self
        }
        /// 컴포넌트 상수풀 속성명 인덱스 + scope offset.
        fn attr_l_var(&mut self, name: u16, idx: u16) -> &mut Self {
            self.code.push(Op::AttrLVar as u8);
            self.code.extend_from_slice(&name.to_le_bytes());
            self.code.extend_from_slice(&idx.to_le_bytes());
            self
        }
        fn end(&mut self) -> &mut Self {
            self.code.push(Op::ElemEnd as u8);
            self
        }
        fn render(&mut self, id: u16) -> &mut Self {
            self.code.push(Op::Render as u8);
            self.code.extend_from_slice(&id.to_le_bytes());
            self
        }
        /// 부모 offset을 자식 인자로 push.
        fn push_arg(&mut self, offset: u16) -> &mut Self {
            self.code.push(Op::PushArg as u8);
            self.code.extend_from_slice(&offset.to_le_bytes());
            self
        }
        fn halt(&mut self) -> &mut Self {
            self.code.push(Op::Halt as u8);
            self
        }
    }

    fn t(name: &str) -> u16 {
        bytecode::tags::tag_id(name).unwrap()
    }

    /// BYTECODE.md §6 hello 예시. encode로 바이트화한 뒤 render에 넘긴다.
    #[test]
    fn renders_hello() {
        let mut pool = ConstPool::new();
        let class = pool.intern("class");
        let greeting = pool.intern("greeting");
        let hello = pool.intern("Hello");
        let sub = pool.intern("sub");
        let world = pool.intern("world");

        let mut a = Asm::new();
        a.open(t("div"))
            .attr(class, greeting)
            .close_open()
            .open(t("h1"))
            .close_open()
            .text(hello)
            .end()
            .open(t("p"))
            .attr(class, sub)
            .close_open()
            .text(world)
            .end()
            .end()
            .halt();

        let code = a.code;
        let defs = vec![CompDef {
            name_idx: hello,
            code_off: 0,
            code_len: code.len() as u32,
        }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(
            render_to_string(&bytes, 0, &[]).unwrap(),
            r#"<div class="greeting"><h1>Hello</h1><p class="sub">world</p></div>"#
        );
    }

    #[test]
    fn escapes_text_and_attr() {
        let mut pool = ConstPool::new();
        let title = pool.intern("title");
        let attr_val = pool.intern(r#"a"b<c"#);
        let body = pool.intern("x < y & z");
        let name = pool.intern("C");

        let mut a = Asm::new();
        a.open(t("div"))
            .attr(title, attr_val)
            .close_open()
            .text(body)
            .end()
            .halt();

        let code = a.code;
        let defs = vec![CompDef { name_idx: name, code_off: 0, code_len: code.len() as u32 }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(
            render_to_string(&bytes, 0, &[]).unwrap(),
            r#"<div title="a&quot;b&lt;c">x &lt; y &amp; z</div>"#
        );
    }

    /// RENDER로 자식 컴포넌트 합성 (프로토타입 코드엔 없지만 opcode 동작 검증).
    #[test]
    fn renders_child_via_render_op() {
        let mut pool = ConstPool::new();
        let parent = pool.intern("Parent");
        let child = pool.intern("Child");
        let hi = pool.intern("hi");

        let mut c = Asm::new();
        c.open(t("span")).close_open().text(hi).end().halt();
        let mut p = Asm::new();
        p.open(t("div")).close_open().render(1).end().halt();

        let child_len = c.code.len() as u32;
        let parent_len = p.code.len() as u32;

        let mut code = c.code;
        code.extend_from_slice(&p.code);

        let defs = vec![
            CompDef { name_idx: parent, code_off: child_len, code_len: parent_len },
            CompDef { name_idx: child, code_off: 0, code_len: child_len },
        ];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[]).unwrap(), "<div><span>hi</span></div>");
    }

    /// 합성 + PUSH_ARG: 부모가 자기 scope의 일부를 자식에게 넘긴다.
    /// 부모 div() { {a} Comp(name={b}) } — 부모 scope=["A","B"], 자식은 b만 받아 출력.
    #[test]
    fn render_passes_args_to_child() {
        let mut pool = ConstPool::new();
        let parent = pool.intern("Parent");
        let child = pool.intern("Child");

        // 자식: span() { {0} }  — 받은 scope[0]을 출력.
        let mut c = Asm::new();
        c.open(t("span")).close_open().text_var(0).end().halt();
        // 부모: div() { {0} PUSH_ARG 1; RENDER child }  — 자기 scope[0] 출력 + 자식엔 scope[1] 전달.
        let mut p = Asm::new();
        p.open(t("div"))
            .close_open()
            .text_var(0)
            .push_arg(1)
            .render(1)
            .end()
            .halt();

        let child_len = c.code.len() as u32;
        let parent_len = p.code.len() as u32;
        let mut code = c.code;
        code.extend_from_slice(&p.code);

        let defs = vec![
            CompDef { name_idx: parent, code_off: child_len, code_len: parent_len },
            CompDef { name_idx: child, code_off: 0, code_len: child_len },
        ];
        let bytes = encode(&Module::new(pool, defs, code));

        let scope = vec!["A".to_string(), "B".to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &scope).unwrap(),
            "<div>A<span>B</span></div>"
        );
    }

    /// TEXT_VAR가 scope[idx] 값을 출력하고, 텍스트 이스케이프를 적용한다.
    #[test]
    fn renders_text_var_from_scope() {
        let mut pool = ConstPool::new();
        let name = pool.intern("Greeting");

        let mut a = Asm::new();
        a.open(t("h1")).close_open().text_var(0).end().halt();

        let code = a.code;
        let defs = vec![CompDef { name_idx: name, code_off: 0, code_len: code.len() as u32 }];
        let bytes = encode(&Module::new(pool, defs, code));

        let scope = vec!["세계 <b>".to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &scope).unwrap(),
            "<h1>세계 &lt;b&gt;</h1>"
        );
    }

    /// 속성값 변수: 전역 name(class)·로컬 name(data-x) 둘 다 scope에서 채우고 속성 이스케이프를 적용.
    #[test]
    fn renders_attr_var_global_and_local() {
        let mut pool = ConstPool::new();
        let name = pool.intern("C");
        let data_x = pool.intern("data-x"); // 전역 테이블에 없는 속성명 → 로컬
        let class_g = bytecode::attrs::attr_id("class").unwrap();

        let mut a = Asm::new();
        a.open(t("div"))
            .attr_g_var(class_g, 0)
            .attr_l_var(data_x, 1)
            .close_open()
            .end()
            .halt();

        let code = a.code;
        let defs = vec![CompDef { name_idx: name, code_off: 0, code_len: code.len() as u32 }];
        let bytes = encode(&Module::new(pool, defs, code));

        let scope = vec!["card".to_string(), r#"a"b"#.to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &scope).unwrap(),
            r#"<div class="card" data-x="a&quot;b"></div>"#
        );
    }

    /// 속성값 변수도 scope 범위를 벗어나면 BadScope.
    #[test]
    fn attr_var_out_of_scope() {
        let mut pool = ConstPool::new();
        let name = pool.intern("C");
        let class_g = bytecode::attrs::attr_id("class").unwrap();
        let mut a = Asm::new();
        a.open(t("div")).attr_g_var(class_g, 0).close_open().end().halt();
        let code = a.code;
        let defs = vec![CompDef { name_idx: name, code_off: 0, code_len: code.len() as u32 }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[]), Err(RenderError::BadScope(0)));
    }

    /// scope에 값이 없으면 BadScope.
    #[test]
    fn text_var_out_of_scope() {
        let mut pool = ConstPool::new();
        let name = pool.intern("C");
        let mut a = Asm::new();
        a.open(t("p")).close_open().text_var(0).end().halt();
        let code = a.code;
        let defs = vec![CompDef { name_idx: name, code_off: 0, code_len: code.len() as u32 }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[]), Err(RenderError::BadScope(0)));
    }

    #[test]
    fn bad_component_id() {
        let bytes = encode(&Module::new(ConstPool::new(), vec![], vec![]));
        assert_eq!(render_to_string(&bytes, 0, &[]), Err(RenderError::BadComponent(0)));
    }

    #[test]
    fn rejects_bad_bytes() {
        assert!(matches!(render_to_string(b"nope", 0, &[]), Err(RenderError::Decode(_))));
    }
}
