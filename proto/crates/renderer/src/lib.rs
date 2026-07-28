//! Quble SSR 렌더러: 직렬화된 바이트코드(`&[u8]`)를 받아 HTML 문자열로 렌더한다.
//! 출력은 SSR 문자열(브라우저 DOM 아님). 일회성/무상태 순수 함수. 상세는 proto/BYTECODE.md.

use bytecode::{DecodeError, Module, Op};
use std::collections::HashSet;

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
    /// 여는 태그 없이 END (스택 불균형 - 손상된 바이트코드).
    UnbalancedEnd,
    /// 범위 밖 scope 인덱스 (주입 값 부족).
    BadScope(u16),
    /// 범위 밖 리소스 ID (res_paths 부족).
    BadResource(u16),
}

impl From<DecodeError> for RenderError {
    fn from(e: DecodeError) -> Self {
        RenderError::Decode(e)
    }
}

/// 바이트코드를 디코드하고 comp_id를 진입점으로 렌더해 HTML 문자열을 만든다.
/// scope는 런타임 주입 값 배열 - `TEXT_VAR index`가 `scope[index]`를 참조한다.
/// res_paths는 resId -> 리소스 경로(resmap) - `LOAD_RES resId`를 `<link href>`로 인라인한다.
pub fn render_to_string(
    bytes: &[u8],
    comp_id: u16,
    scope: &[String],
    res_paths: &[String],
) -> Result<String, RenderError> {
    let module = bytecode::decode(bytes)?;
    let mut out = String::new();
    // 이미 <link>로 낸 resId - 여러 컴포넌트가 같은 리소스를 써도 한 번만 낸다.
    let mut emitted = HashSet::new();
    exec(&module, comp_id, scope, res_paths, &mut emitted, &mut out)?;
    Ok(out)
}

/// 한 컴포넌트 정의의 코드를 실행한다. RENDER를 만나면 재귀한다.
/// emitted는 재귀 전체에서 공유되는 <link> dedup 집합.
fn exec(
    module: &Module,
    comp_id: u16,
    scope: &[String],
    res_paths: &[String],
    emitted: &mut HashSet<u16>,
    out: &mut String,
) -> Result<(), RenderError> {
    let def = module.def(comp_id).ok_or(RenderError::BadComponent(comp_id))?;
    let start = def.code_off as usize;
    let end = start + def.code_len as usize;
    let code = &module.code[start..end];

    // 연 태그를 쌓아둔다. END는 operand 없이 top을 닫는다(중첩 보장).
    let mut tag_stack: Vec<&str> = Vec::new();
    // 자식에게 넘길 인자 버퍼. PUSH_ARG가 부모 scope[scope_index] 값을 쌓고, RENDER가 소비.
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
                let value_const_index = read_u16(code, &mut pc)?;
                let name = bytecode::attrs::attr_name(name).ok_or(RenderError::BadAttr(name))?;
                emit_attr(name, get_const(module, value_const_index)?, out);
            }
            Op::AttrL => {
                let name_const_index = read_u16(code, &mut pc)?;
                let value_const_index = read_u16(code, &mut pc)?;
                emit_attr(get_const(module, name_const_index)?, get_const(module, value_const_index)?, out);
            }
            Op::AttrGVar => {
                let name = read_u16(code, &mut pc)?;
                let scope_index = read_u16(code, &mut pc)?;
                let name = bytecode::attrs::attr_name(name).ok_or(RenderError::BadAttr(name))?;
                let val = scope.get(scope_index as usize).ok_or(RenderError::BadScope(scope_index))?;
                emit_attr(name, val, out);
            }
            Op::AttrLVar => {
                let name_const_index = read_u16(code, &mut pc)?;
                let scope_index = read_u16(code, &mut pc)?;
                let val = scope.get(scope_index as usize).ok_or(RenderError::BadScope(scope_index))?;
                emit_attr(get_const(module, name_const_index)?, val, out);
            }
            Op::ElemCloseOpen => out.push('>'),
            Op::Text => {
                let text_const_index = read_u16(code, &mut pc)?;
                escape_text(get_const(module, text_const_index)?, out);
            }
            Op::TextVar => {
                let scope_index = read_u16(code, &mut pc)?;
                let val = scope.get(scope_index as usize).ok_or(RenderError::BadScope(scope_index))?;
                escape_text(val, out);
            }
            Op::ElemEnd => {
                let name = tag_stack.pop().ok_or(RenderError::UnbalancedEnd)?;
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
            Op::PushThrough => {
                let scope_index = read_u16(code, &mut pc)?;
                let val = scope.get(scope_index as usize).ok_or(RenderError::BadScope(scope_index))?;
                args.push(val.clone());
            }
            // 리터럴 인자: 상수풀 값을 그대로 자식 scope로 넘긴다. SSR은 정적 렌더라 자식이
            // 수정하든 말든 상관없어(leaf/반응성 없음) 변수 인자와 같은 문자열로 취급한다.
            Op::PushArgLit => {
                let value_const_index = read_u16(code, &mut pc)?;
                args.push(get_const(module, value_const_index)?.to_string());
            }
            Op::Render => {
                let child_comp_id = read_u16(code, &mut pc)?;
                // 쌓인 인자(부모 값들)를 자식 scope로 넘기고 버퍼를 비운다.
                let child_scope = std::mem::take(&mut args);
                exec(module, child_comp_id, &child_scope, res_paths, emitted, out)?;
            }
            Op::If => {
                let cond_scope_index = read_u16(code, &mut pc)?;
                let val = scope.get(cond_scope_index as usize).ok_or(RenderError::BadScope(cond_scope_index))?;
                if !truthy(val) {
                    // then을 통 스킵. pc는 매칭 ELSE 다음(else 본문 시작)이나 IF_END 다음에 선다.
                    skip_branch(code, &mut pc)?;
                }
                // truthy면 다음 op부터 then을 정상 해석한다.
            }
            // truthy로 then을 해석하고 ELSE에 도달한 경우. else 가지를 통 스킵 -> IF_END 다음에 선다
            // (else 본문엔 매칭 ELSE가 없어 IF_END에서 멈춘다).
            Op::Else => skip_branch(code, &mut pc)?,
            // 정상 종료 마커. 할 일 없음.
            Op::IfEnd => {}
            // 외부 리소스 로드. resId의 리소스 경로를 <link>로 인라인한다(중복 resId 스킵).
            // head 조립 계층이 없어 조각 자리에 인라인 - <link>는 body에서도 브라우저가 처리한다.
            Op::LoadRes => {
                let res_id = read_u16(code, &mut pc)?;
                if emitted.insert(res_id) {
                    let path = res_paths
                        .get(res_id as usize)
                        .ok_or(RenderError::BadResource(res_id))?;
                    out.push_str("<link rel=\"stylesheet\" href=\"");
                    escape_attr(path, out);
                    out.push_str("\">");
                }
            }
            // 이벤트 배선. SSR은 정적 HTML이라 리스너가 없다 - operand만 소비하고 무시한다
            // (이벤트는 클라 런타임이 단다). event_type/event_index 4바이트.
            Op::BindEvent => {
                read_u16(code, &mut pc)?;
                read_u16(code, &mut pc)?;
            }
            // 합성 경로 세그먼트. fullname은 이벤트(클라 전용)를 위한 것이라 SSR엔 무의미 -
            // operand만 소비하고 무시한다.
            Op::PushPathSegment => {
                read_u16(code, &mut pc)?;
            }
            // 컨텍스트는 핸들러로 가는 메타데이터(클라 전용)라 DOM 출력엔 영향 없다 -
            // ENTER는 context_index만 소비하고, EXIT는 operand 없이 무시한다.
            Op::EnterContext => {
                read_u16(code, &mut pc)?;
            }
            Op::ExitContext => {}
        }
    }
    Ok(())
}

fn read_u16(code: &[u8], pc: &mut usize) -> Result<u16, RenderError> {
    let b = code.get(*pc..*pc + 2).ok_or(RenderError::UnexpectedEof)?;
    *pc += 2;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

/// 불리언 scope 값의 truthy 판정. 빈 문자열/"false"/"0"은 falsy, 그 외 truthy.
/// (cond는 불리언 scope index 하나 - BYTECODE.md §5.1)
fn truthy(val: &str) -> bool {
    !(val.is_empty() || val == "false" || val == "0")
}

/// opcode의 operand 바이트 수. 스킵 시 op 경계를 짚어 마커(IF/ELSE/IF_END)를 operand 값과
/// 혼동하지 않게 한다.
fn operand_len(op: Op) -> usize {
    match op {
        Op::Halt | Op::ElemCloseOpen | Op::ElemEnd | Op::Else | Op::IfEnd | Op::ExitContext => 0,
        Op::ElemOpen | Op::Text | Op::TextVar | Op::Render | Op::PushThrough | Op::PushArgLit | Op::PushPathSegment | Op::If | Op::LoadRes | Op::EnterContext => 2,
        Op::AttrG | Op::AttrL | Op::AttrGVar | Op::AttrLVar | Op::BindEvent => 4,
    }
}

/// 현재 가지를 통 스킵한다. op 경계를 따라 전진하며 중첩 깊이를 세고, 같은 깊이(depth 0)에서
/// 만난 ELSE 또는 IF_END **다음**에 pc를 둔다. ELSE에서 멈추면 호출자는 else 본문을, IF_END에서
/// 멈추면 if 블록 다음을 이어 해석한다.
fn skip_branch(code: &[u8], pc: &mut usize) -> Result<(), RenderError> {
    let mut depth = 0u32;
    while *pc < code.len() {
        let op = Op::from_u8(code[*pc]).ok_or(RenderError::BadOpcode(code[*pc]))?;
        *pc += 1;
        match op {
            Op::If => {
                depth += 1;
                *pc += operand_len(Op::If); // cond operand 건너뛰기
            }
            Op::IfEnd if depth == 0 => return Ok(()),
            Op::IfEnd => depth -= 1,
            Op::Else if depth == 0 => return Ok(()),
            _ => *pc += operand_len(op),
        }
    }
    // 매칭 마커 없이 코드 끝 - 손상된 바이트코드.
    Err(RenderError::UnbalancedEnd)
}

/// ` name="value"` (값 이스케이프 포함) 출력.
fn emit_attr(name: &str, value: &str, out: &mut String) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    escape_attr(value, out);
    out.push('"');
}

fn get_const(module: &Module, index: u16) -> Result<&str, RenderError> {
    module.pool.get(index).ok_or(RenderError::BadConst(index))
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
        fn text_var(&mut self, index: u16) -> &mut Self {
            self.code.push(Op::TextVar as u8);
            self.code.extend_from_slice(&index.to_le_bytes());
            self
        }
        /// 전역 속성명 ID + scope index.
        fn attr_g_var(&mut self, name: u16, index: u16) -> &mut Self {
            self.code.push(Op::AttrGVar as u8);
            self.code.extend_from_slice(&name.to_le_bytes());
            self.code.extend_from_slice(&index.to_le_bytes());
            self
        }
        /// 컴포넌트 상수풀 속성명 인덱스 + scope index.
        fn attr_l_var(&mut self, name: u16, index: u16) -> &mut Self {
            self.code.push(Op::AttrLVar as u8);
            self.code.extend_from_slice(&name.to_le_bytes());
            self.code.extend_from_slice(&index.to_le_bytes());
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
        /// 부모 scope index를 자식 인자로 push.
        fn push_arg(&mut self, scope_index: u16) -> &mut Self {
            self.code.push(Op::PushThrough as u8);
            self.code.extend_from_slice(&scope_index.to_le_bytes());
            self
        }
        fn halt(&mut self) -> &mut Self {
            self.code.push(Op::Halt as u8);
            self
        }
        fn if_(&mut self, cond: u16) -> &mut Self {
            self.code.push(Op::If as u8);
            self.code.extend_from_slice(&cond.to_le_bytes());
            self
        }
        fn else_(&mut self) -> &mut Self {
            self.code.push(Op::Else as u8);
            self
        }
        fn if_end(&mut self) -> &mut Self {
            self.code.push(Op::IfEnd as u8);
            self
        }
        fn load_res(&mut self, res_id: u16) -> &mut Self {
            self.code.push(Op::LoadRes as u8);
            self.code.extend_from_slice(&res_id.to_le_bytes());
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
            name_const_index: hello,
            code_off: 0,
            code_len: code.len() as u32,
            events: vec![],
            contexts: vec![],
        }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(
            render_to_string(&bytes, 0, &[], &[]).unwrap(),
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
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(
            render_to_string(&bytes, 0, &[], &[]).unwrap(),
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
            CompDef { name_const_index: parent, code_off: child_len, code_len: parent_len, events: vec![], contexts: vec![] },
            CompDef { name_const_index: child, code_off: 0, code_len: child_len, events: vec![], contexts: vec![] },
        ];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[], &[]).unwrap(), "<div><span>hi</span></div>");
    }

    /// LOAD_RES가 정의 앞머리에서 <link>를 인라인한다. res_paths[resId]가 href.
    #[test]
    fn load_res_inlines_link() {
        let mut pool = ConstPool::new();
        let name = pool.intern("Styled");

        // LOAD_RES 0; span() {} - 정의 앞머리에 리소스 로드.
        let mut a = Asm::new();
        a.load_res(0).open(t("span")).close_open().end().halt();
        let code = a.code;
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        let res_paths = vec!["/res/styled.abc.css".to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &[], &res_paths).unwrap(),
            r#"<link rel="stylesheet" href="/res/styled.abc.css"><span></span>"#
        );
    }

    /// 부모와 자식이 같은 resId를 LOAD_RES하면 <link>는 한 번만 난다(재귀 전체 dedup).
    #[test]
    fn load_res_dedups_across_render() {
        let mut pool = ConstPool::new();
        let parent = pool.intern("Parent");
        let child = pool.intern("Child");

        // 자식: LOAD_RES 0; span() {}
        let mut c = Asm::new();
        c.load_res(0).open(t("span")).close_open().end().halt();
        // 부모: LOAD_RES 0; div() { RENDER child }
        let mut p = Asm::new();
        p.load_res(0).open(t("div")).close_open().render(1).end().halt();

        let child_len = c.code.len() as u32;
        let parent_len = p.code.len() as u32;
        let mut code = c.code;
        code.extend_from_slice(&p.code);
        let defs = vec![
            CompDef { name_const_index: parent, code_off: child_len, code_len: parent_len, events: vec![], contexts: vec![] },
            CompDef { name_const_index: child, code_off: 0, code_len: child_len, events: vec![], contexts: vec![] },
        ];
        let bytes = encode(&Module::new(pool, defs, code));

        let res_paths = vec!["/res/x.css".to_string()];
        // 부모가 먼저 <link>를 내고, 자식의 같은 resId는 스킵된다.
        assert_eq!(
            render_to_string(&bytes, 0, &[], &res_paths).unwrap(),
            r#"<link rel="stylesheet" href="/res/x.css"><div><span></span></div>"#
        );
    }

    /// res_paths 범위 밖 resId면 BadResource.
    #[test]
    fn load_res_out_of_range_errors() {
        let mut pool = ConstPool::new();
        let name = pool.intern("Styled");
        let mut a = Asm::new();
        a.load_res(5).open(t("span")).close_open().end().halt();
        let code = a.code;
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[], &[]), Err(RenderError::BadResource(5)));
    }

    /// 합성 + PUSH_ARG: 부모가 자기 scope의 일부를 자식에게 넘긴다.
    /// 부모 div() { {a} Comp(name={b}) } - 부모 scope=["A","B"], 자식은 b만 받아 출력.
    #[test]
    fn render_passes_args_to_child() {
        let mut pool = ConstPool::new();
        let parent = pool.intern("Parent");
        let child = pool.intern("Child");

        // 자식: span() { {0} }  - 받은 scope[0]을 출력.
        let mut c = Asm::new();
        c.open(t("span")).close_open().text_var(0).end().halt();
        // 부모: div() { {0} PUSH_ARG 1; RENDER child }  - 자기 scope[0] 출력 + 자식엔 scope[1] 전달.
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
            CompDef { name_const_index: parent, code_off: child_len, code_len: parent_len, events: vec![], contexts: vec![] },
            CompDef { name_const_index: child, code_off: 0, code_len: child_len, events: vec![], contexts: vec![] },
        ];
        let bytes = encode(&Module::new(pool, defs, code));

        let scope = vec!["A".to_string(), "B".to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &scope, &[]).unwrap(),
            "<div>A<span>B</span></div>"
        );
    }

    /// TEXT_VAR가 scope[index] 값을 출력하고, 텍스트 이스케이프를 적용한다.
    #[test]
    fn renders_text_var_from_scope() {
        let mut pool = ConstPool::new();
        let name = pool.intern("Greeting");

        let mut a = Asm::new();
        a.open(t("h1")).close_open().text_var(0).end().halt();

        let code = a.code;
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        let scope = vec!["세계 <b>".to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &scope, &[]).unwrap(),
            "<h1>세계 &lt;b&gt;</h1>"
        );
    }

    /// 속성값 변수: 전역 name(class)/로컬 name(data-x) 둘 다 scope에서 채우고 속성 이스케이프를 적용.
    #[test]
    fn renders_attr_var_global_and_local() {
        let mut pool = ConstPool::new();
        let name = pool.intern("C");
        let data_x = pool.intern("data-x"); // 전역 테이블에 없는 속성명 -> 로컬
        let class_g = bytecode::attrs::attr_id("class").unwrap();

        let mut a = Asm::new();
        a.open(t("div"))
            .attr_g_var(class_g, 0)
            .attr_l_var(data_x, 1)
            .close_open()
            .end()
            .halt();

        let code = a.code;
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        let scope = vec!["card".to_string(), r#"a"b"#.to_string()];
        assert_eq!(
            render_to_string(&bytes, 0, &scope, &[]).unwrap(),
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
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[], &[]), Err(RenderError::BadScope(0)));
    }

    /// scope에 값이 없으면 BadScope.
    #[test]
    fn text_var_out_of_scope() {
        let mut pool = ConstPool::new();
        let name = pool.intern("C");
        let mut a = Asm::new();
        a.open(t("p")).close_open().text_var(0).end().halt();
        let code = a.code;
        let defs = vec![CompDef { name_const_index: name, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));

        assert_eq!(render_to_string(&bytes, 0, &[], &[]), Err(RenderError::BadScope(0)));
    }

    /// 한 컴포넌트 정의를 인코딩해 렌더 (단일 def, scope 주입). if 테스트 공용.
    fn render_one(pool: ConstPool, code: Vec<u8>, scope: &[String]) -> String {
        let defs = vec![CompDef { name_const_index: 0, code_off: 0, code_len: code.len() as u32, events: vec![], contexts: vec![] }];
        let bytes = encode(&Module::new(pool, defs, code));
        render_to_string(&bytes, 0, scope, &[]).unwrap()
    }

    /// if true -> then 가지를, false -> else 가지를 출력. div() { @if c { "T" } @else { "F" } }
    #[test]
    fn if_else_picks_branch() {
        let make = || {
            let mut pool = ConstPool::new();
            let tt = pool.intern("T");
            let ff = pool.intern("F");
            let mut a = Asm::new();
            a.open(t("div")).close_open()
                .if_(0).text(tt).else_().text(ff).if_end()
                .end().halt();
            (pool, a.code)
        };
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["true".into()]), "<div>T</div>");
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["false".into()]), "<div>F</div>");
    }

    /// else 없는 if. false면 then을 통째로 건너뛰고 아무것도 안 남긴다.
    #[test]
    fn if_only_skips_when_false() {
        let make = || {
            let mut pool = ConstPool::new();
            let hi = pool.intern("hi");
            let mut a = Asm::new();
            a.open(t("div")).close_open()
                .if_(0).open(t("span")).close_open().text(hi).end().if_end()
                .end().halt();
            (pool, a.code)
        };
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["true".into()]), "<div><span>hi</span></div>");
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["false".into()]), "<div></div>");
    }

    /// 중첩 if - 바깥 then 안의 안쪽 if/else가 바깥 ELSE를 침범하지 않는지(depth 카운팅).
    /// @if a { @if b { "AB" } @else { "Ab" } } @else { "x" }
    #[test]
    fn nested_if_depth() {
        let make = || {
            let mut pool = ConstPool::new();
            let ab = pool.intern("AB");
            let ab2 = pool.intern("Ab");
            let x = pool.intern("x");
            let mut a = Asm::new();
            a.if_(0) // a
                .if_(1).text(ab).else_().text(ab2).if_end() // 안쪽 b
                .else_().text(x) // 바깥 else
                .if_end()
                .halt();
            (pool, a.code)
        };
        // a=true, b=true -> AB
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["true".into(), "true".into()]), "AB");
        // a=true, b=false -> Ab
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["true".into(), "false".into()]), "Ab");
        // a=false -> x (안쪽은 통째로 스킵, 바깥 ELSE를 정확히 찾아야 함)
        let (pool, code) = make();
        assert_eq!(render_one(pool, code, &["false".into(), "true".into()]), "x");
    }

    #[test]
    fn bad_component_id() {
        let bytes = encode(&Module::new(ConstPool::new(), vec![], vec![]));
        assert_eq!(render_to_string(&bytes, 0, &[], &[]), Err(RenderError::BadComponent(0)));
    }

    #[test]
    fn rejects_bad_bytes() {
        assert!(matches!(render_to_string(b"nope", 0, &[], &[]), Err(RenderError::Decode(_))));
    }
}
