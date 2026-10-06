//! Quble SSR 렌더러(프로토타입): qubb + 루트 props 데이터(JSON)로 HTML 문자열을 만든다.
//!
//! JS 런타임(core/web/runtime.ts)이 처음 그릴 때 만드는 DOM과 같은 모양을 문자열로 낸다 - 같은
//! 순서로 opcode를 해석하되 노드 대신 문자열을, 구독 대신 아무것도 만들지 않는다. region 앵커 주석
//! (`<!--qb:region#N-->`)도 런타임과 같은 번호로 낸다.

mod json;

use bytecode::{Const, DecodeError, ExprOp, Module, Op, TypeEntry};
pub use json::Json;

#[derive(Debug, PartialEq)]
pub enum RenderError {
    Decode(DecodeError),
    Json(String),
    BadOpcode(u8),
    BadExprOpcode(u8),
    /// 요소가 없는 인덱스(범위 밖, 음수, 정수 아님) - 런타임의 RangeError.
    IndexOutOfRange {
        index: f64,
        len: usize,
    },
    /// 짝 마커(ELSE/IF_END, FOR_END, SLOT_PLACEHOLDER_CONTENT_END)가 없다 - 손상된 바이트코드.
    Unbalanced(&'static str),
}

impl From<DecodeError> for RenderError {
    fn from(e: DecodeError) -> Self {
        RenderError::Decode(e)
    }
}

/// SSR 결과. html은 루트 인스턴스의 노드들, links는 LOAD_RES가 처음 만난 순서의 리소스 URL(중복 없음)
/// - 런타임은 `<link>`를 본문이 아니라 `document.head`에 넣으므로 따로 돌려준다.
#[derive(Debug)]
pub struct Rendered {
    pub html: String,
    pub links: Vec<String>,
}

/// qubb를 디코드해 진입점(def 0)을 data(루트 props JSON)로 렌더한다.
pub fn render(bytes: &[u8], data: &str, resources: &[String]) -> Result<Rendered, RenderError> {
    let module = bytecode::decode(bytes)?;
    let data = json::parse(data).map_err(RenderError::Json)?;
    let mut store = Store::default();
    let root_pairs = plant_root(&module, &data, &mut store);
    let def = module.def(0).expect("진입점 def 0");
    let mut r = Renderer {
        module: &module,
        store,
        resources,
        out: String::new(),
        links: Vec::new(),
        loaded_res: Vec::new(),
        next_region: 0,
    };
    // 루트도 region 하나다(런타임 compile의 rootRegion) - 앵커가 루트 노드들 맨 앞에 선다.
    r.region_anchor();
    let start = def.code_off as usize;
    r.interpret(
        &mut root_pairs.clone(),
        0,
        start,
        start + def.code_len as usize,
        &[],
    )?;
    Ok(Rendered {
        html: r.out,
        links: r.links,
    })
}

// ── 값과 store ─────────────────────────────────────────────────────────

/// store leaf 값 하나. JS 런타임의 leaf가 담는 것과 같은 종류.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

impl Val {
    fn from_const(c: &Const) -> Val {
        match c {
            Const::Str(s) => Val::Str(s.clone()),
            Const::Num(n) => Val::Num(*n),
            Const::Bool(b) => Val::Bool(*b),
        }
    }

    /// JS 참/거짓 판정.
    fn truthy(&self) -> bool {
        match self {
            Val::Undef | Val::Null => false,
            Val::Bool(b) => *b,
            Val::Num(n) => *n != 0.0 && !n.is_nan(),
            Val::Str(s) => !s.is_empty(),
        }
    }

    /// 숫자 연산의 피연산자. 타입은 컴파일타임에 맞춰져 숫자만 온다.
    fn num(&self) -> f64 {
        match self {
            Val::Num(n) => *n,
            Val::Bool(b) => *b as u8 as f64,
            _ => f64::NAN,
        }
    }

    /// DOM에 기록될 문자열 - 런타임 bindVar의 `?? ""`처럼 없는 값은 빈 문자열.
    fn dom_string(&self) -> String {
        match self {
            Val::Undef | Val::Null => String::new(),
            Val::Bool(b) => b.to_string(),
            Val::Num(n) => js_number(*n),
            Val::Str(s) => s.clone(),
        }
    }
}

/// JS `String(n)`. 정수는 소수점 없이, 지수 표기는 1e21 이상과 1e-7 미만에서만.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if n == 0.0 {
        return "0".into();
    }
    let abs = n.abs();
    if (1e-7..1e21).contains(&abs) {
        return format!("{n}");
    }
    // Rust `{:e}`는 `1e21`, JS는 `1e+21` - 양의 지수에 `+`를 붙인다.
    let s = format!("{n:e}");
    match s.find('e') {
        Some(i) if !s[i + 1..].starts_with('-') => format!("{}e+{}", &s[..i], &s[i + 1..]),
        _ => s,
    }
}

/// 런타임 store와 arrayPool에 해당. arrays[i] = i번 배열의 요소 시작 leafIndex들.
/// 배열 leaf에는 그 배열의 번호(arrayInfoIndex)가 Num으로 든다.
#[derive(Default)]
struct Store {
    leaves: Vec<Val>,
    arrays: Vec<Vec<usize>>,
}

/// 슬롯 하나의 출처(런타임 argumentSourcePairs의 (kind, ref) 한 쌍).
#[derive(Debug, Clone, Copy)]
enum Slot {
    Store(usize),
    Const(u16),
    /// 개수 반복의 회차 번호 - 번호 자체가 값이다.
    Raw(usize),
}

/// 고정부 뒤로 미룬 배열 하나(런타임 TDeferredArray).
struct Deferred<'d> {
    array_index: usize,
    value: Option<&'d Json>,
    elem_type: u16,
}

fn const_str(module: &Module, index: u16) -> &str {
    match module.pool.get(index) {
        Some(Const::Str(s)) => s,
        other => panic!("상수풀 {index}는 문자열이어야: {other:?}"),
    }
}

/// 런타임 plantFixed - value의 고정 칸만 연속으로 심고 만난 배열을 돌려준다.
fn plant_fixed<'d>(
    value: Option<&'d Json>,
    type_ref: u16,
    module: &Module,
    store: &mut Store,
) -> Vec<Deferred<'d>> {
    match &module.types[type_ref as usize] {
        TypeEntry::Scalar => {
            store.leaves.push(match value {
                None => Val::Undef,
                Some(Json::Null) => Val::Null,
                Some(Json::Bool(b)) => Val::Bool(*b),
                Some(Json::Num(n)) => Val::Num(*n),
                Some(Json::Str(s)) => Val::Str(s.clone()),
                // 스칼라 자리에 객체/배열 - 타입이 어긋난 데이터. 런타임은 그 값을 그대로 담는다.
                Some(_) => Val::Undef,
            });
            Vec::new()
        }
        TypeEntry::Array(elem_type) => {
            let array_index = store.arrays.len();
            store.arrays.push(Vec::new());
            store.leaves.push(Val::Num(array_index as f64));
            vec![Deferred {
                array_index,
                value,
                elem_type: *elem_type,
            }]
        }
        TypeEntry::Object(fields) => {
            let mut deferred = Vec::new();
            for (name, child) in fields {
                let child_value = value.and_then(|v| v.get(const_str(module, *name)));
                deferred.extend(plant_fixed(child_value, *child, module, store));
            }
            deferred
        }
    }
}

/// 런타임 plantRoot - 루트 고정부를 먼저, 배열 요소는 레벨별로 뒤에 심고 루트 슬롯들을 돌려준다.
fn plant_root(module: &Module, data: &Json, store: &mut Store) -> Vec<Slot> {
    let props_type = module.def(0).expect("진입점 def 0").props_type_ref;
    let fields = match &module.types[props_type as usize] {
        TypeEntry::Object(fields) => fields,
        other => panic!("루트 props 타입은 객체여야: {other:?}"),
    };
    let mut root_pairs = Vec::new();
    let mut pending = Vec::new();
    for (name, child) in fields {
        root_pairs.push(Slot::Store(store.leaves.len()));
        pending.extend(plant_fixed(
            data.get(const_str(module, *name)),
            *child,
            module,
            store,
        ));
    }
    while !pending.is_empty() {
        let mut next = Vec::new();
        for d in pending {
            let elems: &[Json] = match d.value {
                Some(Json::Arr(items)) => items,
                _ => &[],
            };
            for elem in elems {
                let start = store.leaves.len();
                store.arrays[d.array_index].push(start);
                next.extend(plant_fixed(Some(elem), d.elem_type, module, store));
            }
        }
        pending = next;
    }
    root_pairs
}

// ── 해석 ──────────────────────────────────────────────────────────────

/// 사용쪽이 담아 둔 슬롯 콘텐츠 - 부모 def 안의 코드 구간과 그때의 슬롯.
#[derive(Clone)]
struct SlotContent {
    start: usize,
    end: usize,
    pairs: Vec<Slot>,
    comp_id: u16,
}

struct Renderer<'m> {
    module: &'m Module,
    store: Store,
    resources: &'m [String],
    out: String,
    links: Vec<String>,
    loaded_res: Vec<u16>,
    /// 다음 region 번호. 런타임 regionPool이 처음 그릴 때 매기는 순서(앞순회)와 같다.
    next_region: usize,
}

/// 내용을 가질 수 없는 요소 - 닫는 태그를 내지 않는다.
const VOID_TAGS: [&str; 13] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

impl Renderer<'_> {
    fn region_anchor(&mut self) {
        self.out
            .push_str(&format!("<!--qb:region#{}-->", self.next_region));
        self.next_region += 1;
    }

    fn slot_value(&self, slot: Slot, offset: usize) -> Val {
        match slot {
            Slot::Const(i) => Val::from_const(self.module.pool.get(i).expect("상수풀 인덱스")),
            Slot::Raw(v) => Val::Num(v as f64),
            Slot::Store(base) => self.store.leaves[base + offset].clone(),
        }
    }

    fn interpret(
        &mut self,
        pairs: &mut Vec<Slot>,
        comp_id: u16,
        start: usize,
        end: usize,
        slot_contents: &[Option<SlotContent>],
    ) -> Result<(), RenderError> {
        let module = self.module;
        let code = &module.code;
        let def = module.def(comp_id).expect("def");
        let mut tags: Vec<&'static str> = Vec::new();
        let mut args: Vec<Slot> = Vec::new();
        let mut pending_slots: Vec<Option<SlotContent>> = Vec::new();
        let mut pc = start;
        let u16at = |pc: &mut usize| {
            let v = u16::from_le_bytes([code[*pc], code[*pc + 1]]);
            *pc += 2;
            v
        };
        while pc < end {
            let byte = code[pc];
            let op = Op::from_u8(byte).ok_or(RenderError::BadOpcode(byte))?;
            pc += 1;
            match op {
                Op::Halt => break,
                Op::LoadRes => {
                    let res_id = u16at(&mut pc);
                    if !self.loaded_res.contains(&res_id) {
                        self.loaded_res.push(res_id);
                        if let Some(url) = self.resources.get(res_id as usize) {
                            self.links.push(url.clone());
                        }
                    }
                }
                Op::ElemOpen => {
                    let tag = u16at(&mut pc);
                    let name = bytecode::tags::tag_name(tag).expect("내장 태그 ID");
                    tags.push(name);
                    self.out.push('<');
                    self.out.push_str(name);
                }
                Op::AttrG | Op::AttrL => {
                    let name = u16at(&mut pc);
                    let value = u16at(&mut pc);
                    let name = match op {
                        Op::AttrG => bytecode::attrs::attr_name(name).expect("전역 속성 ID"),
                        _ => const_str(module, name),
                    };
                    let value =
                        Val::from_const(module.pool.get(value).expect("상수풀")).dom_string();
                    emit_attr(name, &value, &mut self.out);
                }
                Op::AttrGVar | Op::AttrLVar | Op::AttrGExpr | Op::AttrLExpr => {
                    let name = u16at(&mut pc);
                    let name = match op {
                        Op::AttrGVar | Op::AttrGExpr => {
                            bytecode::attrs::attr_name(name).expect("전역 속성 ID")
                        }
                        _ => const_str(module, name),
                    };
                    let value = match op {
                        Op::AttrGVar | Op::AttrLVar => {
                            let v =
                                self.slot_value(pairs[code[pc] as usize], code[pc + 1] as usize);
                            pc += 2;
                            v
                        }
                        _ => {
                            let v = self.eval(&def.exprs[code[pc] as usize], pairs)?;
                            pc += 1;
                            v
                        }
                    };
                    emit_attr(name, &value.dom_string(), &mut self.out);
                }
                Op::BindEvent => pc += 4,
                Op::ElemCloseOpen => self.out.push('>'),
                Op::Text => {
                    let text = Val::from_const(module.pool.get(u16at(&mut pc)).expect("상수풀"));
                    escape_text(&text.dom_string(), &mut self.out);
                }
                Op::TextVar => {
                    let v = self.slot_value(pairs[code[pc] as usize], code[pc + 1] as usize);
                    pc += 2;
                    escape_text(&v.dom_string(), &mut self.out);
                }
                Op::TextExpr => {
                    let v = self.eval(&def.exprs[code[pc] as usize], pairs)?;
                    pc += 1;
                    escape_text(&v.dom_string(), &mut self.out);
                }
                Op::ElemEnd => {
                    let name = tags.pop().ok_or(RenderError::Unbalanced("ELEM_END"))?;
                    if !VOID_TAGS.contains(&name) {
                        self.out.push_str("</");
                        self.out.push_str(name);
                        self.out.push('>');
                    }
                }
                Op::PushThrough => {
                    args.push(pairs[code[pc] as usize]);
                    pc += 1;
                }
                Op::PushField => {
                    let offset = code[pc + 1] as usize;
                    args.push(match pairs[code[pc] as usize] {
                        Slot::Store(base) => Slot::Store(base + offset),
                        other => other,
                    });
                    pc += 2;
                }
                Op::PushArgLit => args.push(Slot::Const(u16at(&mut pc))),
                // 경로 세그먼트와 컨텍스트는 이벤트(클라 전용)를 위한 것 - operand만 소비한다.
                Op::PushPathSegment | Op::PushPathIndexSegment | Op::EnterContext => pc += 2,
                Op::ExitContext => {}
                Op::PushSlotPlaceholderContent => {
                    let index = u16at(&mut pc) as usize;
                    let content_end = scan_end(code, pc, Scan::SlotContent)?;
                    if pending_slots.len() <= index {
                        pending_slots.resize(index + 1, None);
                    }
                    pending_slots[index] = Some(SlotContent {
                        start: pc,
                        end: content_end,
                        pairs: pairs.clone(),
                        comp_id,
                    });
                    pc = content_end + 1;
                }
                Op::FillSlotPlaceholder => {
                    let index = u16at(&mut pc) as usize;
                    if let Some(Some(content)) = slot_contents.get(index) {
                        let content = content.clone();
                        self.interpret(
                            &mut content.pairs.clone(),
                            content.comp_id,
                            content.start,
                            content.end,
                            &[],
                        )?;
                    }
                }
                Op::Render => {
                    let child_id = u16at(&mut pc);
                    let child = module.def(child_id).expect("자식 def");
                    let mut child_pairs = std::mem::take(&mut args);
                    let child_slots = std::mem::take(&mut pending_slots);
                    let child_start = child.code_off as usize;
                    self.interpret(
                        &mut child_pairs,
                        child_id,
                        child_start,
                        child_start + child.code_len as usize,
                        &child_slots,
                    )?;
                }
                Op::If | Op::IfExpr => {
                    let cond = match op {
                        Op::If => {
                            let v =
                                self.slot_value(pairs[code[pc] as usize], code[pc + 1] as usize);
                            pc += 2;
                            v
                        }
                        _ => {
                            let v = self.eval(&def.exprs[code[pc] as usize], pairs)?;
                            pc += 1;
                            v
                        }
                    };
                    self.region_anchor();
                    let then_end = scan_end(code, pc, Scan::Branch)?;
                    let (else_start, if_end) = match Op::from_u8(code[then_end]) {
                        Some(Op::Else) => (
                            Some(then_end + 1),
                            scan_end(code, then_end + 1, Scan::Branch)?,
                        ),
                        _ => (None, then_end),
                    };
                    // 활성 가지만 그린다. 비활성 가지는 런타임이 lazy build로 남겨 두는 것과 같다.
                    match (cond.truthy(), else_start) {
                        (true, _) => self.interpret(pairs, comp_id, pc, then_end, slot_contents)?,
                        (false, Some(s)) => {
                            self.interpret(pairs, comp_id, s, if_end, slot_contents)?
                        }
                        (false, None) => {}
                    }
                    pc = if_end + 1;
                }
                Op::ForRaw | Op::ForCountVar | Op::ForArrayVar => {
                    // (반응형이라 region이 있는가, 회차 수, 회차마다 요소 시작 leaf)
                    let (reactive, count, elem_starts): (bool, usize, Option<Vec<usize>>) = match op
                    {
                        Op::ForRaw => (false, u16at(&mut pc) as usize, None),
                        Op::ForCountVar => {
                            let slot = pairs[code[pc] as usize];
                            let v = self.slot_value(slot, code[pc + 1] as usize);
                            pc += 2;
                            let count = v.num();
                            let count = if count.is_nan() || count < 0.0 {
                                0
                            } else {
                                count as usize
                            };
                            (matches!(slot, Slot::Store(_)), count, None)
                        }
                        _ => {
                            let leaf = match pairs[code[pc] as usize] {
                                Slot::Store(base) => base + code[pc + 1] as usize,
                                other => panic!("배열 @for 슬롯은 STORE여야: {other:?}"),
                            };
                            pc += 2;
                            let starts =
                                self.store.arrays[self.store.leaves[leaf].num() as usize].clone();
                            (true, starts.len(), Some(starts))
                        }
                    };
                    let body_end = scan_end(code, pc, Scan::For)?;
                    if reactive {
                        self.region_anchor();
                    }
                    for i in 0..count {
                        // 회차변수 슬롯 2칸 - item, index. 배열 @for의 item은 그 요소 leaf다.
                        let item = match &elem_starts {
                            Some(starts) => Slot::Store(starts[i]),
                            None => Slot::Raw(i),
                        };
                        pairs.push(item);
                        pairs.push(Slot::Raw(i));
                        self.interpret(pairs, comp_id, pc, body_end, slot_contents)?;
                        pairs.pop();
                        pairs.pop();
                    }
                    pc = body_end + 1;
                }
                Op::Else | Op::IfEnd | Op::ForEnd | Op::SlotPlaceholderContentEnd => {
                    return Err(RenderError::Unbalanced("stray marker"));
                }
            }
        }
        Ok(())
    }

    /// 후위 식 하나를 센다(런타임 runExpr에서 cache/reads를 뺀 것).
    fn eval(&self, expr: &[u8], pairs: &[Slot]) -> Result<Val, RenderError> {
        let mut stack: Vec<Val> = Vec::new();
        let mut pc = 0;
        let pop = |stack: &mut Vec<Val>| stack.pop().expect("식 스택");
        while pc < expr.len() {
            let byte = expr[pc];
            let op = ExprOp::from_u8(byte).ok_or(RenderError::BadExprOpcode(byte))?;
            pc += 1;
            match op {
                ExprOp::LoadVar => {
                    stack.push(self.slot_value(pairs[expr[pc] as usize], expr[pc + 1] as usize));
                    pc += 2;
                }
                ExprOp::LoadArrayLength => {
                    let leaf = match pairs[expr[pc] as usize] {
                        Slot::Store(base) => base + expr[pc + 1] as usize,
                        other => panic!("배열 길이 슬롯은 STORE여야: {other:?}"),
                    };
                    let len = self.store.arrays[self.store.leaves[leaf].num() as usize].len();
                    stack.push(Val::Num(len as f64));
                    pc += 2;
                }
                ExprOp::LoadStringLength => {
                    let s = self.slot_value(pairs[expr[pc] as usize], expr[pc + 1] as usize);
                    // JS 문자열 길이는 UTF-16 단위다.
                    stack.push(Val::Num(s.dom_string().encode_utf16().count() as f64));
                    pc += 2;
                }
                ExprOp::LoadConst => {
                    let index = u16::from_le_bytes([expr[pc], expr[pc + 1]]);
                    stack.push(Val::from_const(
                        self.module.pool.get(index).expect("상수풀"),
                    ));
                    pc += 2;
                }
                ExprOp::LoadSmallInt => {
                    stack.push(Val::Num(expr[pc] as f64));
                    pc += 1;
                }
                ExprOp::LoadTrue => stack.push(Val::Bool(true)),
                ExprOp::LoadFalse => stack.push(Val::Bool(false)),
                ExprOp::Not => {
                    let v = pop(&mut stack);
                    stack.push(Val::Bool(!v.truthy()));
                }
                ExprOp::Neg => {
                    let v = pop(&mut stack);
                    stack.push(Val::Num(-v.num()));
                }
                ExprOp::ElemAt => {
                    let index = pop(&mut stack).num();
                    let array = pop(&mut stack).num() as usize;
                    let starts = &self.store.arrays[array];
                    let ok =
                        index.fract() == 0.0 && index >= 0.0 && (index as usize) < starts.len();
                    if !ok {
                        return Err(RenderError::IndexOutOfRange {
                            index,
                            len: starts.len(),
                        });
                    }
                    stack.push(Val::Num(starts[index as usize] as f64));
                }
                ExprOp::FieldAt => {
                    let base = pop(&mut stack).num();
                    stack.push(Val::Num(base + expr[pc] as f64));
                    pc += 1;
                }
                ExprOp::ReadLeaf => {
                    let leaf = pop(&mut stack).num() as usize;
                    stack.push(self.store.leaves[leaf].clone());
                }
                binary => {
                    let right = pop(&mut stack);
                    let left = pop(&mut stack);
                    stack.push(apply_binary(binary, left, right));
                }
            }
        }
        Ok(pop(&mut stack))
    }
}

fn apply_binary(op: ExprOp, left: Val, right: Val) -> Val {
    let (l, r) = (left.num(), right.num());
    match op {
        ExprOp::Add => Val::Num(l + r),
        ExprOp::Sub => Val::Num(l - r),
        ExprOp::Mul => Val::Num(l * r),
        ExprOp::Div => Val::Num(l / r),
        ExprOp::Rem => Val::Num(l % r),
        // JS `===` - 타입까지 같아야 하고 NaN은 자기와도 다르다(PartialEq for f64가 그렇다).
        ExprOp::Eq => Val::Bool(left == right),
        ExprOp::Ne => Val::Bool(left != right),
        ExprOp::Lt => Val::Bool(l < r),
        ExprOp::Le => Val::Bool(l <= r),
        ExprOp::Gt => Val::Bool(l > r),
        ExprOp::Ge => Val::Bool(l >= r),
        // JS `&&`/`||` - 피연산자를 그대로 돌려준다.
        ExprOp::And => {
            if left.truthy() {
                right
            } else {
                left
            }
        }
        ExprOp::Or => {
            if left.truthy() {
                left
            } else {
                right
            }
        }
        other => unreachable!("이항 연산이 아니다: {other:?}"),
    }
}

/// 짝 마커를 찾는 대상. 같은 종류가 안쪽에 중첩되면 깊이를 센다.
#[derive(Clone, Copy)]
enum Scan {
    /// ELSE 또는 IF_END(깊이 0에서). IF/IF_EXPR이 깊이를 올린다.
    Branch,
    /// FOR_END. @for 여는 opcode 셋이 깊이를 올린다.
    For,
    /// SLOT_PLACEHOLDER_CONTENT_END. PUSH_SLOT_PLACEHOLDER_CONTENT가 깊이를 올린다.
    SlotContent,
}

/// from부터 op 경계를 따라가며 짝 마커의 pc를 찾는다(런타임 skipBranch/forBodyEnd/
/// slotPlaceholderContentEnd).
fn scan_end(code: &[u8], from: usize, scan: Scan) -> Result<usize, RenderError> {
    let mut pc = from;
    let mut depth = 0u32;
    while pc < code.len() {
        let at = pc;
        let op = Op::from_u8(code[pc]).ok_or(RenderError::BadOpcode(code[pc]))?;
        pc += 1 + operand_len(op);
        let (opens, closes) = match scan {
            Scan::Branch => (
                matches!(op, Op::If | Op::IfExpr),
                matches!(op, Op::IfEnd) || (matches!(op, Op::Else) && depth == 0),
            ),
            Scan::For => (
                matches!(op, Op::ForRaw | Op::ForCountVar | Op::ForArrayVar),
                matches!(op, Op::ForEnd),
            ),
            Scan::SlotContent => (
                matches!(op, Op::PushSlotPlaceholderContent),
                matches!(op, Op::SlotPlaceholderContentEnd),
            ),
        };
        if opens {
            depth += 1;
        } else if closes {
            if depth == 0 {
                return Ok(at);
            }
            depth -= 1;
        }
    }
    Err(RenderError::Unbalanced("no matching end marker"))
}

/// opcode 뒤 operand 바이트 수(런타임 operandLen).
fn operand_len(op: Op) -> usize {
    match op {
        Op::Halt
        | Op::ElemCloseOpen
        | Op::ElemEnd
        | Op::Else
        | Op::IfEnd
        | Op::ExitContext
        | Op::ForEnd
        | Op::SlotPlaceholderContentEnd => 0,
        Op::PushThrough | Op::IfExpr | Op::TextExpr => 1,
        Op::ElemOpen
        | Op::Text
        | Op::TextVar
        | Op::Render
        | Op::PushField
        | Op::PushArgLit
        | Op::PushPathSegment
        | Op::If
        | Op::LoadRes
        | Op::EnterContext
        | Op::ForRaw
        | Op::ForCountVar
        | Op::ForArrayVar
        | Op::PushPathIndexSegment
        | Op::PushSlotPlaceholderContent
        | Op::FillSlotPlaceholder => 2,
        Op::AttrGExpr | Op::AttrLExpr => 3,
        Op::AttrG | Op::AttrL | Op::AttrGVar | Op::AttrLVar | Op::BindEvent => 4,
    }
}

/// ` name="value"`.
fn emit_attr(name: &str, value: &str, out: &mut String) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out.push('"');
}

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
