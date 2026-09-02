//! AST -> 바이트코드 Module. 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간.

use crate::ast::{
    BinaryOp, Context, Event, Expr, ForCount, Ident, Lit, Node, Prop, SlotPlaceholderContent, Type,
    UnaryOp,
};
use crate::expr_type::{require_expr_type, type_name, ExprTypeError, ExprTypeErrorKind};
use crate::flatten::{FlatComp, Sourced};
use crate::scope::{
    lookup_var_ref, require_leaf_var_ref, var_ref_display, ForVar, ScopeError, ScopeErrorKind,
};
use crate::src_range::SrcRange;
use bytecode::{
    encode, tags, CompDef, Const, ConstPool, ContextDef, EventDef, ExprOp, Field, FieldValue,
    Module, Op, TypeEntry,
};

#[derive(Debug, PartialEq, Eq)]
pub enum CodegenErrorKind {
    /// 스코프 조회가 낸 실패(없는 이름/필드, leaf 아님, 슬롯 초과) - scope.rs가 정의한다.
    Scope(ScopeErrorKind),
    /// 표현식 타입 검사가 낸 실패 - expr_type.rs가 정의한다. 조회 실패와 갈래를 나누는 건
    /// 경로가 달라서다(여긴 식을 거쳐 왔고, Scope는 codegen이 참조를 직접 조회한 것).
    ExprType(ExprTypeErrorKind),
    /// 내장 태그 테이블에 없는 태그.
    UnknownTag(String),
    /// 호출했지만 파일에 정의가 없는 컴포넌트.
    UnknownComponent(String),
    /// 자식 prop명이 자식 props 선언에 없음 (use-site 바인딩 오류).
    UnknownArg { comp: String, prop: String },
    /// 자식이 선언한 prop을 안 넘겼다. 지금은 props가 전부 필수라(SYNTAX #3.3 - 슬롯과 다르다)
    /// 하나라도 빠지면 에러다. 선택적 prop이 생기면 그 표시가 없는 것에만 걸린다.
    /// 빠진 것의 자리는 소스에 없어 합성 호출을 탓한다.
    MissingArg { comp: String, prop: String },
    /// `@click:EVENT`이 이 컴포넌트 events에 없는 이벤트명을 가리킴.
    UnknownEvent(String),
    /// `@with Context`가 이 컴포넌트 contexts에 없는 컨텍스트명을 가리킴.
    UnknownContext(String),
    /// 합성 인자로 넘긴 값의 타입이 자식 prop 타입과 다르다. 변수 바인딩(`user={user}`)과
    /// 리터럴(`count="abc"`) 둘 다다. 객체는 leaf를 순서로 짝지으므로 필드 이름/순서/타입이
    /// 모두 일치해야 한다. Type은 Object(Vec)을 품어 Box로 든다.
    PropTypeMismatch {
        comp: String,
        prop: String,
        want: Box<Type>,
        got: Box<Type>,
    },
    /// @for 회차변수 이름이 prop 또는 바깥 회차변수와 겹친다. 섀도잉을 막아 이름 조회를
    /// 순서 무관하게(매치 최대 하나) 유지한다 - 다른 이름을 쓰라는 컴파일 에러.
    DuplicateBinding(String),
    /// `@for (x of arr)`의 count가 배열도 숫자도 아니다(bool/객체 등 - 반복 횟수로 못 쓴다).
    ForCountNotIterable(String),
    /// 조건이 소스 리터럴만으로 되어 컴파일타임에 값이 정해지고, 그래서 한쪽 가지가 절대
    /// 안 그려진다. 담은 값은 그 조건이 참인지 - 참이면 `@else`가, 거짓이면 then이 죽는다.
    /// 참인데 `@else`가 없으면 죽는 가지가 없어 에러가 아니다(조건을 접고 몸체만 낸다).
    ConstantCondition(bool),
    /// 한 컴포넌트가 쓰는 표현식이 255개를 넘었다 - `expr_count`가 u8이라 그 위는 안 담긴다.
    TooManyExprs,
    /// 식 하나가 255바이트를 넘었다 - 표현식 테이블의 len이 u8이다.
    ExprTooLong,
    /// 자식이 정의하지 않은 슬롯을 채웠다(`Header << ...`인데 자식에 `@slot(Header)` 없음,
    /// 또는 자식이 `@slot()`을 안 뒀는데 자식 블록을 준 경우).
    ///
    /// 무엇을 채웠는지는 안 담는다 - 밑줄이 이미 그 자리를 짚고, 답은 자식이 무엇을 받느냐다.
    /// declared가 자식이 선언한 슬롯들(선언 순서, 무기명은 None)이다.
    UnknownSlotPlaceholder {
        comp: String,
        declared: Vec<Option<String>>,
    },
    /// 한 컴포넌트가 같은 슬롯 자리를 두 번 선언했다(`@slot()` 둘, 또는 같은 이름 `@slot(H)` 둘).
    /// 콘텐츠는 한 덩이라 어느 자리로 갈지 정할 수 없다 - 복제하지 않고 막는다.
    DuplicateSlotPlaceholderDef {
        comp: String,
        slot_placeholder: Option<String>,
    },
    /// 값 자리에 연산자가 붙은 식이 왔다. 지금 식을 평가하는 건 `@if` 조건뿐이고
    /// 나머지 값 자리(속성값/합성 인자/payload/context)는 잎 하나만 받는다.
    UnsupportedValueExpr,
    /// 속성값 리터럴이 문자열이 아니다(`width={100}`). DOM 속성값은 문자열이라 갈 곳이 없다.
    AttrValueNotString,
}

impl std::fmt::Display for CodegenErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            CodegenErrorKind::Scope(e) => e.fmt(f),
            CodegenErrorKind::ExprType(e) => e.fmt(f),
            CodegenErrorKind::UnknownTag(tag) => write!(f, "unknown builtin tag `{tag}`"),
            CodegenErrorKind::UnknownComponent(name) => {
                write!(f, "cannot find component `{name}`")
            }
            CodegenErrorKind::UnknownArg { comp, prop } => {
                write!(f, "`{comp}` has no prop `{prop}`")
            }
            CodegenErrorKind::MissingArg { comp, prop } => {
                write!(f, "`{comp}` requires prop `{prop}`")
            }
            CodegenErrorKind::UnknownEvent(name) => {
                write!(f, "`{name}` is not declared in events")
            }
            CodegenErrorKind::UnknownContext(name) => {
                write!(f, "`{name}` is not declared in contexts")
            }
            CodegenErrorKind::PropTypeMismatch {
                comp,
                prop,
                want,
                got,
            } => write!(
                f,
                "value passed to prop `{prop}` of `{comp}`: expected {}, found {}",
                type_name(want),
                type_name(got)
            ),
            CodegenErrorKind::DuplicateBinding(name) => write!(
                f,
                "@for binding `{name}` shadows a prop or an outer binding: use another name"
            ),
            CodegenErrorKind::ForCountNotIterable(path) => write!(
                f,
                "`{path}` is neither an array nor a number: it cannot drive @for"
            ),
            // 무엇이 죽었는지를 말한다 - 조건을 고칠지 죽은 가지를 지울지는 그 다음이다.
            CodegenErrorKind::ConstantCondition(value) => match value {
                true => write!(
                    f,
                    "condition is always true: the @else branch is never rendered"
                ),
                false => write!(f, "condition is always false: this branch is never rendered"),
            },
            CodegenErrorKind::TooManyExprs => {
                write!(f, "a component can use at most 255 expressions")
            }
            CodegenErrorKind::ExprTooLong => {
                write!(f, "an expression is too long: split it into smaller ones")
            }
            // 없는 것보다 쓸 수 있는 것을 말한다 - 고칠 방법이 문장 안에 있어야 한다.
            CodegenErrorKind::UnknownSlotPlaceholder { comp, declared } => {
                let named: Vec<String> =
                    declared.iter().flatten().map(|n| format!("`{n}`")).collect();
                match (declared.is_empty(), named.is_empty()) {
                    // 슬롯이 아예 없다 - 대안이 없으니 할 일을 알려준다.
                    (true, _) => write!(f, "`{comp}` has no slot: use self-close (`{comp}( /)`)"),
                    // 선언한 게 무기명뿐이다.
                    (_, true) => write!(f, "`{comp}` only takes unnamed slot content"),
                    _ => write!(f, "`{comp}` only takes named slots: {}", named.join(", ")),
                }
            }
            CodegenErrorKind::DuplicateSlotPlaceholderDef {
                comp,
                slot_placeholder,
            } => match slot_placeholder {
                Some(slot) => write!(
                    f,
                    "`{comp}` declares slot `{slot}` twice: the content has no single place to go"
                ),
                None => write!(
                    f,
                    "`{comp}` declares the unnamed slot twice: the content has no single place to go"
                ),
            },
            CodegenErrorKind::UnsupportedValueExpr => {
                write!(f, "this value takes a single reference or literal")
            }
            CodegenErrorKind::AttrValueNotString => {
                write!(f, "attribute values are strings")
            }
        }
    }
}

/// codegen 실패 - 무엇이(kind) 어디서(range) 틀렸나.
///
/// range는 Option이 아니다 - 모든 codegen 에러가 탓할 자리를 안다. 소스에 없는 것을 탓하는
/// 에러(안 넘긴 prop, 무기명 슬롯)도 그것을 감싼 노드를 짚는다(합성 호출, `@slot()`).
#[derive(Debug, PartialEq, Eq)]
pub struct CodegenError {
    pub kind: CodegenErrorKind,
    pub range: SrcRange,
}

impl CodegenErrorKind {
    fn at(self, range: SrcRange) -> CodegenError {
        CodegenError { kind: self, range }
    }
}

/// 스코프 조회 실패를 codegen 실패로 싣는다 - 자리는 그대로 두고 갈래만 감싼다.
/// `?`가 이걸 자동으로 부르므로 호출부는 변환을 안 적는다.
impl From<ScopeError> for CodegenError {
    fn from(e: ScopeError) -> Self {
        CodegenErrorKind::Scope(e.kind).at(e.range)
    }
}

/// 표현식 타입 검사 실패도 같은 축으로 싣는다.
impl From<ExprTypeError> for CodegenError {
    fn from(e: ExprTypeError) -> Self {
        CodegenErrorKind::ExprType(e.kind).at(e.range)
    }
}

/// 컴포넌트 하나의 선언. 맵이 슬롯 선언을 소유한다.
type CompEntry<'a> = (
    u16,                  /* 컴포넌트 ID(정의 순서) - RENDER에 박는다 */
    &'a [Prop],           /* 자식 props 선언 - PUSH_ARG를 이 순서로 정렬 */
    Vec<Option<&'a str>>, /* 자식 슬롯 선언(무기명 None) - 슬롯 콘텐츠를 이 순서로 정렬 */
);

/// `get`이 돌려주는 `CompEntry` - 슬롯 선언은 맵이 계속 소유하고 슬라이스로만 빌려준다.
type CompEntryBorrowed<'a, 'e> = (
    u16,                   /* 컴포넌트 ID(정의 순서) */
    &'a [Prop],            /* 자식 props 선언 */
    &'e [Option<&'a str>], /* 자식 슬롯 선언(무기명 None) */
);

/// 컴포넌트 이름 -> (ID, props 선언, 슬롯 선언) 룩업. 합성 호출(`Comp(...)`)을 만났을 때 RENDER에
/// 박을 ID를 찾고, PUSH_ARG를 자식 props 순서로, 슬롯 콘텐츠를 자식 슬롯 순서로 정렬하려고
/// 선언도 같이 돌려준다. 컴포넌트 ID = 정의 순서.
struct CompLookup<'a> {
    by_name: std::collections::HashMap<&'a str, CompEntry<'a>>,
}

impl<'a> CompLookup<'a> {
    fn build(comps: &'a [FlatComp]) -> Self {
        let by_name = comps
            .iter()
            .enumerate()
            .map(|(i, fc)| {
                let slot_placeholders =
                    slot_def_names(&collect_slot_placeholders(&fc.comp.template));
                (
                    fc.comp.name.as_str(),
                    (i as u16, fc.comp.props.as_slice(), slot_placeholders),
                )
            })
            .collect();
        CompLookup { by_name }
    }

    /// 이름으로 (컴포넌트 ID, 자식 props 선언, 자식 슬롯 선언)을 찾는다.
    fn get(&self, name: &str) -> Option<CompEntryBorrowed<'a, '_>> {
        self.by_name
            .get(name)
            .map(|(id, props, slot_placeholders)| (*id, *props, slot_placeholders.as_slice()))
    }
}

/// 슬롯 콘텐츠의 이름(무기명이면 None). 선언쪽 `Vec<Option<&str>>`과 짝지어 비교하는 형태로 맞춘다.
fn slot_name(content: &SlotPlaceholderContent) -> Option<&str> {
    content.name.as_ref().map(|n| n.name.as_str())
}

/// 한 `@slot` 선언 - 이름(무기명이면 None)과 그 선언의 자리.
/// 중복 선언 에러가 기명이면 이름을, 무기명이면 `@slot()` 노드를 가리킨다.
type SlotDef<'a> = (Option<&'a Ident>, SrcRange);

/// template을 훑어 `@slot` 선언을 등장 순서로 모은다(무기명이면 None). 이 순서가 slot_placeholder_index다.
/// 중첩 노드(요소 자식/@if/@for/@with) 안의 슬롯도 같은 순서 공간에 들어간다.
fn collect_slot_placeholders(nodes: &[Node]) -> Vec<SlotDef<'_>> {
    let mut slot_placeholders = Vec::new();
    walk_slot_placeholders(nodes, &mut slot_placeholders);
    slot_placeholders
}

/// 슬롯 선언 목록에서 이름만 뽑는다(무기명이면 None). 자리 찾기는 이름으로만 하므로
/// 위치를 안 쓰는 소비처(CompLookup, 사용쪽 매칭)는 이 형태를 쓴다.
fn slot_def_names<'a>(slot_placeholders: &[SlotDef<'a>]) -> Vec<Option<&'a str>> {
    slot_placeholders
        .iter()
        .map(|(name, _)| name.map(|i| i.name.as_str()))
        .collect()
}

fn walk_slot_placeholders<'a>(nodes: &'a [Node], slot_placeholders: &mut Vec<SlotDef<'a>>) {
    for node in nodes {
        match node {
            Node::SlotPlaceholderDef { name, range } => {
                slot_placeholders.push((name.as_ref(), range.0))
            }
            Node::Element { children, .. } => walk_slot_placeholders(children, slot_placeholders),
            Node::If { then, else_, .. } => {
                walk_slot_placeholders(then, slot_placeholders);
                walk_slot_placeholders(else_, slot_placeholders);
            }
            Node::For { body, .. } => walk_slot_placeholders(body, slot_placeholders),
            Node::With { children, .. } => walk_slot_placeholders(children, slot_placeholders),
            // 합성 경계 - 자식의 슬롯은 자식 def의 것이라 여기 안 센다.
            Node::Component { .. } | Node::Text(_) | Node::Var(_) => {}
        }
    }
}

/// 한 컴포넌트의 슬롯 선언에 중복이 없는지 본다. 사용쪽 콘텐츠는 이름(무기명이면 None)으로
/// 자리를 찾으므로 같은 이름이 둘이면 한 덩이를 두 자리에 복제하게 된다 - 선언 단계에서 막는다.
fn check_slot_placeholder_defs(
    comp: &str,
    slot_placeholders: &[SlotDef],
) -> Result<(), CodegenError> {
    let names = slot_def_names(slot_placeholders);
    for (i, (slot_placeholder, at)) in slot_placeholders.iter().enumerate() {
        let name = slot_placeholder.map(|s| s.name.as_str());
        if names[..i].contains(&name) {
            let kind = CodegenErrorKind::DuplicateSlotPlaceholderDef {
                comp: comp.to_string(),
                slot_placeholder: name.map(str::to_string),
            };
            // 뒤에 온 중복 선언을 가리킨다(먼저 온 것이 자리를 차지했다). 기명은 그 이름을,
            // 무기명은 이름이 없어 `@slot()` 노드 전체를 짚는다.
            return Err(match slot_placeholder {
                Some(slot) => kind.at(slot.range.0),
                None => kind.at(*at),
            });
        }
    }
    Ok(())
}

/// generate 산출물.
type Emitted = (
    Box<[u8]>,   /* qubb 바이트코드 */
    Vec<String>, /* 정규화 리소스 경로 - 등장 순서가 곧 resId */
);

/// 파일의 컴포넌트 정의들을 하나의 직렬화된 Module로. 컴포넌트 ID = 정의 순서.
/// 두 번째 반환값은 리소스 사이드맵 - 인덱스가 모듈 전역 resId, 값이 정규화 경로.
/// 빌드 단계가 이걸 받아 내용 해시/복사/URL화를 한다(BYTECODE.md #5 LOAD_RES 메모).
///
/// 에러의 range는 그 컴포넌트가 정의된 파일의 오프셋이라, 어느 파일인지를 함께 실어 보낸다
/// (Sourced) - 엔트리 소스에 대고 세면 use한 파일의 에러가 엉뚱한 줄을 짚는다.
pub fn generate(comps: &[FlatComp]) -> Result<Emitted, Sourced<CodegenError>> {
    let comp_lookup = CompLookup::build(comps);
    let mut pool = ConstPool::new();
    let mut types = TypeTable::new();
    let mut code = Vec::new();
    let mut defs = Vec::new();
    // 정규화 경로 -> resId. 등장 순서로 0,1,2.... 같은 경로는 같은 resId(모듈 전역 dedup).
    let mut res_ids: Vec<String> = Vec::new();

    // 각 컴포넌트 코드를 이어붙이고 off/len으로 구획한다. 한 컴포넌트를 처리하다 난 에러는
    // 모두 그 컴포넌트가 정의된 파일을 탓하므로, 여기 한 자리에서 출처를 붙인다
    // (안쪽 emit들은 위치(range)만 알고 파일은 모른다).
    for fc in comps {
        let def = generate_comp(
            fc,
            &comp_lookup,
            &mut pool,
            &mut types,
            &mut code,
            &mut res_ids,
        )
        .map_err(|e| Sourced::from_origin(&fc.origin, e))?;
        defs.push(def);
    }

    let module = Module::new(pool, types.into_entries(), defs, code);
    Ok((encode(&module).into_boxed_slice(), res_ids))
}

/// 컴포넌트 하나의 코드를 code에 이어붙이고 그 CompDef를 만든다. 에러는 위치(range)만 알고
/// 어느 파일인지는 모른다 - 호출부(generate)가 그 컴포넌트가 정의된 파일로 감싼다.
fn generate_comp(
    fc: &FlatComp,
    comp_lookup: &CompLookup,
    pool: &mut ConstPool,
    types: &mut TypeTable,
    code: &mut Vec<u8>,
    res_ids: &mut Vec<String>,
) -> Result<CompDef, CodegenError> {
    {
        let comp = &fc.comp;
        check_slot_placeholder_defs(&comp.name, &collect_slot_placeholders(&comp.template))?;
        let name_const_index = pool.intern_str(&comp.name);
        // props를 하나의 Object로 intern - 필드 순서 = scope 슬롯 순서. defs[0]이 진입점 풀필 구조,
        // 나머지는 핸들러 props 접근용(타입 워크 재료). props 없으면 빈 Object.
        let props_ty = Type::Object(
            comp.props
                .iter()
                .map(|p| (p.name.clone(), p.type_.clone()))
                .collect(),
        );
        let props_type_ref = types.intern(&props_ty, pool);
        let code_off = code.len() as u32;
        // 리소스 로드를 정의 앞머리에 깐다. lazy build에서 이 컴포넌트가 실제로 그려질 때만
        // 실행돼 리소스가 로드된다(같은 파일 컴포넌트가 같은 LOAD_RES를 내도 런타임이 URL dedup).
        for res_path in &fc.resources {
            let res_id = res_id_for(res_ids, res_path);
            code.push(Op::LoadRes as u8);
            code.extend_from_slice(&res_id.to_le_bytes());
        }
        // 슬롯 인덱스는 컴포넌트-로컬 - def마다 0부터 다시 센다. 표현식 테이블도 def가 소유해
        // 같은 수명이다(DECISIONS.md "표현식 테이블 - 컴포넌트 소유 + 후위 표기 채택").
        let mut next_slot_placeholder_index = 0u16;
        let mut exprs = Vec::new();
        for node in &comp.template {
            emit_node(
                node,
                &comp.props,
                &comp.events,
                &comp.contexts,
                comp_lookup,
                ForScope::ROOT,
                pool,
                code,
                &mut next_slot_placeholder_index,
                &mut exprs,
            )?;
        }
        code.push(Op::Halt as u8);
        // events를 직렬화용 EventDef로 변환(코드와 무관 - 컴포넌트 테이블로 간다).
        // payload의 prop명을 scope index로, 필드명을 상수풀 인덱스로.
        let events = comp
            .events
            .iter()
            .map(|e| {
                let fields = e
                    .payload
                    .iter()
                    .map(|(field, value)| arg_to_field(field, value, &comp.props, pool, types))
                    .collect::<Result<Vec<_>, CodegenError>>()?;
                Ok(EventDef {
                    name_const_index: pool.intern_str(&e.name),
                    fields,
                })
            })
            .collect::<Result<Vec<_>, CodegenError>>()?;
        // contexts를 ContextDef로 변환(events와 같은 패턴). 값이 ArgValue라 Var/Literal로 갈린다.
        let contexts = comp
            .contexts
            .iter()
            .map(|c| {
                let fields = c
                    .fields
                    .iter()
                    .map(|(field, value)| arg_to_field(field, value, &comp.props, pool, types))
                    .collect::<Result<Vec<_>, CodegenError>>()?;
                Ok(ContextDef {
                    name_const_index: pool.intern_str(&c.name),
                    fields,
                })
            })
            .collect::<Result<Vec<_>, CodegenError>>()?;
        Ok(CompDef {
            name_const_index,
            props_type_ref,
            code_off,
            code_len: code.len() as u32 - code_off,
            events,
            contexts,
            exprs,
        })
    }
}

/// 정규화 경로의 모듈 전역 resId. 이미 본 경로면 그 인덱스, 처음이면 끝에 추가하고 새 인덱스.
fn res_id_for(res_ids: &mut Vec<String>, path: &str) -> u16 {
    if let Some(i) = res_ids.iter().position(|p| p == path) {
        return i as u16;
    }
    res_ids.push(path.to_string());
    (res_ids.len() - 1) as u16
}

/// 두 타입이 구조적으로 동일한가 - 필드 이름/순서/타입이 재귀로 일치. 객체 통째 전달에서
/// 넘긴 경로의 도달 타입과 자식 prop 타입이 같은 leaf 배치인지 검사(순서만으로 leaf를 짝지으므로
/// 이름/순서가 어긋나면 엉뚱하게 이어진다). (Ref/Omit/Pick은 expand가 이미 Object로 풀었다.)
fn types_match(a: &Type, b: &Type) -> bool {
    match (a, b) {
        (Type::Bool, Type::Bool) | (Type::Number, Type::Number) | (Type::String, Type::String) => {
            true
        }
        (Type::Array(x), Type::Array(y)) => types_match(x, y),
        (Type::Object(fx), Type::Object(fy)) => {
            fx.len() == fy.len()
                && fx
                    .iter()
                    .zip(fy)
                    .all(|((nx, tx), (ny, ty))| nx == ny && types_match(tx, ty))
        }
        _ => false,
    }
}

/// 모듈 전역 타입 테이블(dedup). Type을 intern해 type_ref를 발급한다. 자식부터 등록해
/// 참조가 먼저 존재하게 한다(Object 필드가 자식 type_ref를 가리킴). 같은 구조는 한 엔트리 공유
/// - TypeEntry 자체가 키라, 필드명(상수풀 인덱스)/순서/자식 type_ref가 모두 같아야 동일 엔트리다.
struct TypeTable {
    entries: Vec<TypeEntry>,
    cache: std::collections::HashMap<TypeEntry, u16>,
}

impl TypeTable {
    fn new() -> Self {
        TypeTable {
            entries: Vec::new(),
            cache: std::collections::HashMap::new(),
        }
    }

    /// Type의 구조를 테이블에 intern하고 type_ref 반환. object는 필드 자식부터 재귀 intern.
    /// 필드명은 상수풀 인덱스로. (Ref/Omit/Pick은 expand가 이미 풀었다 - split과 같은 전제.)
    fn intern(&mut self, ty: &Type, pool: &mut ConstPool) -> u16 {
        let entry = match ty {
            Type::Bool | Type::Number | Type::String => TypeEntry::Scalar,
            Type::Array(inner) => TypeEntry::Array(self.intern(inner, pool)),
            Type::Object(fields) => {
                let fields = fields
                    .iter()
                    .map(|(name, field_ty)| (pool.intern_str(name), self.intern(field_ty, pool)))
                    .collect();
                TypeEntry::Object(fields)
            }
            Type::Ref(n) => unreachable!("expand가 Type::Ref({})를 안 풀었다", n.name),
            Type::Omit(..) | Type::Pick(..) => unreachable!("expand가 유틸 타입을 안 풀었다"),
        };
        if let Some(&idx) = self.cache.get(&entry) {
            return idx;
        }
        let idx = self.entries.len() as u16;
        self.entries.push(entry.clone());
        self.cache.insert(entry, idx);
        idx
    }

    fn into_entries(self) -> Vec<TypeEntry> {
        self.entries
    }
}

/// payload/context field 명세 하나 = 필드명 + 조립 구조(type_ref) + 채울 값 하나(ref).
/// Var는 도달 타입을 테이블에 intern하고 그 슬롯 위치(scope_index, offset)를 Scope ref로 싣는다
/// (안 펼쳐 객체도 하나). Literal은 스칼라 type_ref + Const ref 하나(객체 리터럴은 문법상 없다).
fn arg_to_field(
    field: &str,
    value: &Expr,
    props: &[Prop],
    pool: &mut ConstPool,
    types: &mut TypeTable,
) -> Result<Field, CodegenError> {
    let (type_ref, ref_value) = match value {
        Expr::Var(var, _) => {
            // events/contexts는 컴포넌트 최상위 선언이라 @for 몸체 밖 - 회차변수가 올 수 없다.
            let (scope_index, offset, ty) = lookup_var_ref(var, props, &[])?;
            let type_ref = types.intern(ty, pool);
            (type_ref, FieldValue::Scope(scope_index, offset))
        }
        Expr::Lit(lit, _) => {
            // 리터럴은 항상 스칼라(객체 리터럴 없음). Scalar 엔트리 하나를 intern해 공유.
            let type_ref = types.intern(&lit_type(&lit.value), pool);
            (
                type_ref,
                FieldValue::Const(pool.intern(lit_to_const(&lit.value))),
            )
        }
        // payload/context 값은 아직 잎 하나뿐 - 연산자는 @if 조건에서만 쓴다.
        Expr::Unary(..) | Expr::Binary(..) => {
            return Err(CodegenErrorKind::UnsupportedValueExpr.at(value.range().0));
        }
    };
    Ok(Field {
        name_const_index: pool.intern_str(field),
        type_ref,
        value: ref_value,
    })
}

/// 리터럴의 quble 타입. 리터럴은 스칼라라 Bool/Number/String 중 하나(intern은 모두 Scalar 엔트리).
fn lit_type(lit: &Lit) -> Type {
    match lit {
        Lit::Str(_) => Type::String,
        Lit::Number(_) => Type::Number,
        Lit::Bool(_) => Type::Bool,
    }
}

/// 리터럴을 상수풀 엔트리로. 소스의 타입을 그대로 실어 런타임이 올바른 JS 값으로 복원한다.
fn lit_to_const(lit: &Lit) -> Const {
    match lit {
        Lit::Str(s) => Const::Str(s.clone()),
        Lit::Number(n) => Const::Num(*n),
        Lit::Bool(b) => Const::Bool(*b),
    }
}

/// @for 세그먼트 상태. pending: 아직 세그먼트에 못 실은 @for 깊이들(다음 PushPathSegment/이벤트가
/// 접미로 소비, 소비되면 비움). depth_base: 다음 @for가 쓸 깊이(use-site부터 누적 - 컴포넌트가
/// pending을 소비해도 이어진다). dts.rs walk_nodes와 같은 규칙 - 문자열 대신 PushPathIndexSegment로 낸다.
#[derive(Clone, Copy)]
struct ForScope<'a> {
    pending: &'a [u16],
    depth_base: u16,
    /// 이 지점에서 보이는 @for 회차변수들(바깥->안쪽 누적). props와 별개 scope 층 -
    /// 이름 조회는 props보다 먼저 봐(안쪽 우선/섀도잉), 값 kind는 다르다(회차값은 런타임 RAW).
    /// 컴포넌트 경계(RENDER)에서 소멸 - 자식 def는 자기 ROOT부터(pending과 동일 수명).
    for_vars: &'a [ForVar],
}

impl ForScope<'_> {
    const ROOT: ForScope<'static> = ForScope {
        pending: &[],
        depth_base: 0,
        for_vars: &[],
    };
}

/// 소스 리터럴만으로 된 식을 접었을 때의 값. 참조가 하나라도 끼면 접을 수 없다.
///
/// CONST 슬롯(`Comp(count=5 /)`)은 여기 안 온다 - 사용처마다 값이 다를 수 있는데 컴포넌트
/// 코드는 한 벌이라 접으면 틀린다. 그래서 판정은 `Expr` 트리만 본다.
enum Folded {
    Bool(bool),
    Number(f64),
    Str(String),
}

/// 식이 소스 리터럴만으로 되어 있으면 그 값. 참조가 하나라도 있으면 None.
///
/// 타입 검사가 끝난 뒤에 부른다 - 피연산자 타입이 맞다고 보고 짜서, 어긋나는 조합은
/// `unreachable!`로 둔다.
fn fold_expr(expr: &Expr) -> Option<Folded> {
    match expr {
        Expr::Lit(lit, _) => Some(match &lit.value {
            Lit::Bool(b) => Folded::Bool(*b),
            Lit::Number(n) => Folded::Number(*n),
            Lit::Str(s) => Folded::Str(s.clone()),
        }),

        // 참조가 끼면 컴파일타임에 값을 모른다.
        Expr::Var(..) => None,

        Expr::Unary(op, operand, _) => match (op, fold_expr(operand)?) {
            (UnaryOp::Not, Folded::Bool(b)) => Some(Folded::Bool(!b)),
            (UnaryOp::Neg, Folded::Number(n)) => Some(Folded::Number(-n)),
            _ => unreachable!("타입 검사가 통과시킨 단항 피연산자"),
        },

        Expr::Binary(op, left, right, _) => {
            let (l, r) = (fold_expr(left)?, fold_expr(right)?);
            Some(match (op, l, r) {
                // 산술 - 양쪽 number.
                (BinaryOp::Add, Folded::Number(a), Folded::Number(b)) => Folded::Number(a + b),
                (BinaryOp::Sub, Folded::Number(a), Folded::Number(b)) => Folded::Number(a - b),
                (BinaryOp::Mul, Folded::Number(a), Folded::Number(b)) => Folded::Number(a * b),
                (BinaryOp::Div, Folded::Number(a), Folded::Number(b)) => Folded::Number(a / b),
                (BinaryOp::Rem, Folded::Number(a), Folded::Number(b)) => Folded::Number(a % b),
                // 대소 비교 - 양쪽 number.
                (BinaryOp::Lt, Folded::Number(a), Folded::Number(b)) => Folded::Bool(a < b),
                (BinaryOp::Le, Folded::Number(a), Folded::Number(b)) => Folded::Bool(a <= b),
                (BinaryOp::Gt, Folded::Number(a), Folded::Number(b)) => Folded::Bool(a > b),
                (BinaryOp::Ge, Folded::Number(a), Folded::Number(b)) => Folded::Bool(a >= b),
                // 논리 - 양쪽 bool. 단락 평가는 없다(값 자리에 부수효과가 없어 결과가 같다).
                (BinaryOp::And, Folded::Bool(a), Folded::Bool(b)) => Folded::Bool(a && b),
                (BinaryOp::Or, Folded::Bool(a), Folded::Bool(b)) => Folded::Bool(a || b),
                // 같음 비교 - 타입을 안 박고 양쪽이 같기만 하면 된다.
                (BinaryOp::Eq, a, b) => Folded::Bool(folded_eq(&a, &b)),
                (BinaryOp::Ne, a, b) => Folded::Bool(!folded_eq(&a, &b)),
                _ => unreachable!("타입 검사가 통과시킨 이항 피연산자"),
            })
        }
    }
}

/// 접힌 값끼리 같은지. 타입 검사가 양쪽 타입을 이미 맞춰 놔서 서로 다른 갈래는 안 온다.
fn folded_eq(a: &Folded, b: &Folded) -> bool {
    match (a, b) {
        (Folded::Bool(a), Folded::Bool(b)) => a == b,
        (Folded::Number(a), Folded::Number(b)) => a == b,
        (Folded::Str(a), Folded::Str(b)) => a == b,
        _ => unreachable!("타입 검사가 통과시킨 `==` 피연산자"),
    }
}

/// 식 하나를 후위 표기 바이트로 낸다(BYTECODE.md #4 `<EXPR>`). 왼쪽 -> 오른쪽 -> 연산자 순서로
/// 밀어서, 런타임이 앞에서 뒤로 한 번 훑으면 스택 계산이 끝난다.
///
/// 타입은 이미 맞다고 보고 짠다 - 부르기 전에 `require_expr_type`이 검사를 마쳤다.
fn emit_expr(
    expr: &Expr,
    props: &[Prop],
    for_vars: &[ForVar],
    pool: &mut ConstPool,
    out: &mut Vec<u8>,
) -> Result<(), CodegenError> {
    match expr {
        Expr::Lit(lit, _) => match &lit.value {
            // 0~255 정수는 태그 1 + 값 1로 끝난다 - 상수풀을 거치면 f64 8바이트가 따로 붙는다.
            Lit::Number(n) if is_small_int(*n) => {
                out.push(ExprOp::LoadSmallInt as u8);
                out.push(*n as u8);
            }
            Lit::Bool(b) => out.push(match b {
                true => ExprOp::LoadTrue as u8,
                false => ExprOp::LoadFalse as u8,
            }),
            Lit::Number(n) => {
                let index = pool.intern(Const::Num(*n));
                out.push(ExprOp::LoadConst as u8);
                out.extend_from_slice(&index.to_le_bytes());
            }
            Lit::Str(s) => {
                let index = pool.intern_str(s);
                out.push(ExprOp::LoadConst as u8);
                out.extend_from_slice(&index.to_le_bytes());
            }
        },

        // 참조 아니면 `.length` - expr_type과 같은 순서로 가른다(실제 필드가 먼저).
        Expr::Var(var, _) => match require_leaf_var_ref(var, props, for_vars) {
            Ok((scope_index, offset)) => {
                out.push(ExprOp::LoadVar as u8);
                out.push(scope_index);
                out.push(offset);
            }
            Err(not_leaf) => {
                let target = match var.length_target() {
                    Some(t) => t,
                    None => return Err(not_leaf.into()),
                };
                let (scope_index, offset, ty) = lookup_var_ref(&target, props, for_vars)?;
                // 배열은 길이를 담은 칸을, 문자열은 값 칸을 구독한다 - 런타임이 볼 대상이 달라
                // 태그를 나눈다. 그 외 타입은 expr_type이 이미 걸렀다.
                out.push(match ty {
                    Type::Array(_) => ExprOp::LoadArrayLength as u8,
                    _ => ExprOp::LoadStringLength as u8,
                });
                out.push(scope_index);
                out.push(offset);
            }
        },

        Expr::Unary(op, operand, _) => {
            emit_expr(operand, props, for_vars, pool, out)?;
            out.push(match op {
                UnaryOp::Not => ExprOp::Not as u8,
                UnaryOp::Neg => ExprOp::Neg as u8,
            });
        }

        Expr::Binary(op, left, right, _) => {
            emit_expr(left, props, for_vars, pool, out)?;
            emit_expr(right, props, for_vars, pool, out)?;
            out.push(match op {
                BinaryOp::Add => ExprOp::Add as u8,
                BinaryOp::Sub => ExprOp::Sub as u8,
                BinaryOp::Mul => ExprOp::Mul as u8,
                BinaryOp::Div => ExprOp::Div as u8,
                BinaryOp::Rem => ExprOp::Rem as u8,
                BinaryOp::Eq => ExprOp::Eq as u8,
                BinaryOp::Ne => ExprOp::Ne as u8,
                BinaryOp::Lt => ExprOp::Lt as u8,
                BinaryOp::Le => ExprOp::Le as u8,
                BinaryOp::Gt => ExprOp::Gt as u8,
                BinaryOp::Ge => ExprOp::Ge as u8,
                BinaryOp::And => ExprOp::And as u8,
                BinaryOp::Or => ExprOp::Or as u8,
            });
        }
    }
    Ok(())
}

/// `LoadSmallInt`로 낼 수 있는 값인지 - 0~255 정수. 음수는 `Neg`가 따로 붙고, 그 밖은 상수풀로.
fn is_small_int(n: f64) -> bool {
    n.fract() == 0.0 && (0.0..=255.0).contains(&n)
}

/// 식 바이트를 이 컴포넌트의 표현식 테이블에 넣고 `expr_index`를 준다. 같은 바이트면 이미 있는
/// 것을 함께 쓴다 - 중복 제거 기준이 방출된 바이트다(DECISIONS.md "표현식 테이블 - 컴포넌트
/// 소유 + 후위 표기 채택").
fn intern_expr(exprs: &mut Vec<Vec<u8>>, bytes: Vec<u8>, at: SrcRange) -> Result<u8, CodegenError> {
    if bytes.len() > u8::MAX as usize {
        return Err(CodegenErrorKind::ExprTooLong.at(at));
    }
    if let Some(index) = exprs.iter().position(|expr| *expr == bytes) {
        return Ok(index as u8);
    }
    // `expr_count`가 u8이라 테이블에 담기는 것이 255개까지다. `expr_index`는 255를 표현할 수
    // 있지만 그 자리에 식이 있으려면 개수가 256이어야 해서, 인덱스 255는 쓰이지 않는다.
    if exprs.len() >= u8::MAX as usize {
        return Err(CodegenErrorKind::TooManyExprs.at(at));
    }
    exprs.push(bytes);
    Ok((exprs.len() - 1) as u8)
}

fn emit_node(
    node: &Node,
    props: &[Prop],
    events: &[Event],
    contexts: &[Context],
    comp_lookup: &CompLookup,
    for_scope: ForScope,
    pool: &mut ConstPool,
    code: &mut Vec<u8>,
    // 지금까지 방출한 `@slot` 수 = 다음 것의 slot_placeholder_index.
    // collect_slot_placeholders의 순회 순서와 같아야 정의쪽/사용쪽 인덱스가 맞는다.
    next_slot_placeholder_index: &mut u16,
    // 이 컴포넌트의 표현식 테이블. 연산자가 붙은 조건이 여기 쌓이고 `IF_EXPR`이 번호로 가리킨다.
    exprs: &mut Vec<Vec<u8>>,
) -> Result<(), CodegenError> {
    match node {
        Node::Text(s) => {
            let index = pool.intern_str(s);
            code.push(Op::Text as u8);
            code.extend_from_slice(&index.to_le_bytes());
        }
        Node::Var(var) => {
            let (scope_index, offset) = require_leaf_var_ref(var, props, for_scope.for_vars)?;
            code.push(Op::TextVar as u8);
            code.push(scope_index);
            code.push(offset);
        }
        Node::Element {
            tag,
            attrs,
            event_bindings,
            children,
        } => {
            let tag_id = tags::tag_id(&tag.name)
                .ok_or_else(|| CodegenErrorKind::UnknownTag(tag.name.clone()).at(tag.range.0))?;

            code.push(Op::ElemOpen as u8);
            code.extend_from_slice(&tag_id.to_le_bytes());

            // @for 직속 element(세그먼트 만드는 컴포넌트 없이)에서 이벤트가 나면 익명 인덱스
            // 세그먼트를 먼저 민다([$0].SELECT). pending의 각 깊이마다 하나씩 - 발화 시 런타임이
            // 직전 이름 세그먼트가 없어 익명으로 조립한다. 이벤트가 없으면 굳이 안 낸다.
            if !event_bindings.is_empty() {
                for depth in for_scope.pending {
                    code.push(Op::PushPathIndexSegment as u8);
                    code.extend_from_slice(&depth.to_le_bytes());
                }
            }

            // 이벤트 바인딩 - 속성과 같은 자리(여는 태그 진행 중). event_index는 이 컴포넌트
            // events에서 이벤트명으로 찾는다(선언 순서 = index).
            for (dom_event, event_name) in event_bindings {
                // 렉서가 닫힌 집합(Directive)으로 걸러 알려진 DOM 이벤트만 온다.
                let event_type = bytecode::dom_events::dom_event_id(dom_event)
                    .expect("렉서가 거른 DOM 이벤트만 온다");
                let event_index = events
                    .iter()
                    .position(|e| e.name == event_name.name)
                    .ok_or_else(|| {
                        CodegenErrorKind::UnknownEvent(event_name.name.clone())
                            .at(event_name.range.0)
                    })? as u16;
                code.push(Op::BindEvent as u8);
                code.extend_from_slice(&event_type.to_le_bytes());
                code.extend_from_slice(&event_index.to_le_bytes());
            }

            for (name, value) in attrs {
                // DOM 속성값은 문자열이라 리터럴은 Str만 온다 - 숫자/불리언은 갈 곳이 없다.
                let static_str = match value {
                    Expr::Lit(lit, range) => match &lit.value {
                        Lit::Str(s) => Some(s),
                        _ => return Err(CodegenErrorKind::AttrValueNotString.at(range.0)),
                    },
                    _ => None,
                };
                // 두 축이 opcode를 가른다.
                //   name : 전역 속성명 테이블에 있으면 G(전역 ID), 없으면 L(상수풀 인덱스)
                //   value: 정적이면 상수풀 인덱스, 변수면 scope index
                let is_var = static_str.is_none();
                let (op, name_operand) = match bytecode::attrs::attr_id(name) {
                    Some(global_id) => (if is_var { Op::AttrGVar } else { Op::AttrG }, global_id),
                    None => (
                        if is_var { Op::AttrLVar } else { Op::AttrL },
                        pool.intern_str(name),
                    ),
                };
                code.push(op as u8);
                code.extend_from_slice(&name_operand.to_le_bytes());
                match static_str {
                    // 정적 값은 상수풀 인덱스 u16.
                    Some(s) => {
                        code.extend_from_slice(&pool.intern_str(s).to_le_bytes());
                    }
                    // 변수 값은 (scope_index, offset) 두 u8 - TEXT_VAR와 같은 slot 인코딩.
                    None => match value {
                        Expr::Var(v, _) => {
                            let (scope_index, offset) =
                                require_leaf_var_ref(v, props, for_scope.for_vars)?;
                            code.push(scope_index);
                            code.push(offset);
                        }
                        // 연산자가 붙은 식은 값 자리에서 아직 안 된다.
                        _ => return Err(CodegenErrorKind::UnsupportedValueExpr.at(value.range().0)),
                    },
                }
            }

            code.push(Op::ElemCloseOpen as u8);

            // element는 세그먼트를 안 만든다 - 자식으로 for_scope를 그대로 흘려보낸다
            // (같은 @for 안 중첩 element가 같은 인덱스를 이벤트에 실을 수 있게 pending 유지).
            for child in children {
                emit_node(
                    child,
                    props,
                    events,
                    contexts,
                    comp_lookup,
                    for_scope,
                    pool,
                    code,
                    next_slot_placeholder_index,
                    exprs,
                )?;
            }

            // END는 operand 없음 - 가장 최근에 연 태그를 닫는다(중첩이 보장됨).
            code.push(Op::ElemEnd as u8);
        }
        Node::Component {
            alias,
            name,
            args,
            contents,
        } => {
            // 자식 ID와 props/슬롯 선언을 찾는다.
            let (child_id, child_props, child_slot_placeholders) =
                comp_lookup.get(&name.name).ok_or_else(|| {
                    CodegenErrorKind::UnknownComponent(name.name.clone()).at(name.range.0)
                })?;

            // 자식이 선언 안 한 prop을 넘겼으면 에러 - 오타가 조용히 사라지지 않게(슬롯과 같은 규칙).
            // 빠진 것보다 먼저 본다 - 오타를 냈으면 빠졌다는 말보다 그 이름을 짚는 게 낫다.
            for (arg_name, _) in args {
                if !child_props.iter().any(|p| p.name == arg_name.name) {
                    return Err(CodegenErrorKind::UnknownArg {
                        comp: name.name.clone(),
                        prop: arg_name.name.clone(),
                    }
                    .at(arg_name.range.0));
                }
            }

            // 자식 props 선언 순서대로 인자를 낸다. 변수 바인딩(`prop={x}`)은 부모 scope index을 싣는
            // PUSH_ARG, 리터럴(`prop="lit"`)은 상수풀 인덱스를 싣는 PUSH_ARG_LIT.
            // (지금은 전부 바인딩 가정 - 순서만으로 매핑.)
            for child_prop in child_props {
                let arg_value = args
                    .iter()
                    .find(|(p, _)| p.name == child_prop.name)
                    .map(|(_, v)| v)
                    // 빠진 것의 자리는 소스에 없다 - 합성 호출을 탓한다.
                    .ok_or_else(|| {
                        CodegenErrorKind::MissingArg {
                            comp: name.name.clone(),
                            prop: child_prop.name.clone(),
                        }
                        .at(name.range.0)
                    })?;
                match arg_value {
                    Expr::Var(parent_var, _) => {
                        // 도달 타입이 자식 prop 타입과 구조가 같아야 한다.
                        let (scope_index, offset, reached_ty) =
                            lookup_var_ref(parent_var, props, for_scope.for_vars)?;
                        if !types_match(reached_ty, &child_prop.type_) {
                            // 타입이 안 맞는 건 넘긴 그 참조다 - 그 자리를 가리킨다.
                            return Err(CodegenErrorKind::PropTypeMismatch {
                                comp: name.name.clone(),
                                prop: child_prop.name.clone(),
                                want: Box::new(child_prop.type_.clone()),
                                got: Box::new(reached_ty.clone()),
                            }
                            .at(parent_var.range.0));
                        }
                        // 경로 없는 참조(`{a}`)는 슬롯 통째로 THROUGH, 필드 참조(`{user.name}`)는
                        // (슬롯, offset)으로 FIELD - kind는 슬롯이 갖고 자식이 타입을 안다.
                        if parent_var.path.is_empty() {
                            code.push(Op::PushThrough as u8);
                            code.push(scope_index);
                        } else {
                            code.push(Op::PushField as u8);
                            code.push(scope_index);
                            code.push(offset);
                        }
                    }
                    Expr::Lit(literal, _) => {
                        // 변수 바인딩과 같은 판정 - 리터럴만 빠지면 타입 검사를 우회할 수 있다.
                        let ty = lit_type(&literal.value);
                        if !types_match(&ty, &child_prop.type_) {
                            return Err(CodegenErrorKind::PropTypeMismatch {
                                comp: name.name.clone(),
                                prop: child_prop.name.clone(),
                                want: Box::new(child_prop.type_.clone()),
                                got: Box::new(ty),
                            }
                            .at(literal.range.0));
                        }
                        let value_index = pool.intern(lit_to_const(&literal.value));
                        code.push(Op::PushArgLit as u8);
                        code.extend_from_slice(&value_index.to_le_bytes());
                    }
                    // 연산자가 붙은 식은 값 자리에서 아직 안 된다.
                    _ => return Err(CodegenErrorKind::UnsupportedValueExpr.at(arg_value.range().0)),
                }
            }

            // 합성 경로 세그먼트 = use-site alias가 있으면 alias, 없으면 자식 type-name.
            // 뒤따르는 RENDER가 소비해 자식 경로 prefix에 잇는다 - 이벤트 fullname의 path 축.
            // (alias 생략 = 동일 type-name 공유, alias 부여 = 분리. #1.3)
            let segment = alias.as_deref().unwrap_or(&name.name);
            let segment_index = pool.intern_str(segment);
            code.push(Op::PushPathSegment as u8);
            code.extend_from_slice(&segment_index.to_le_bytes());

            // @for 안이면 이 세그먼트가 pending 인덱스를 접미한다(VideoItem[$0]). 깊이는 컴포넌트-로컬
            // (자기 컴포넌트 안 @for만 0,1,2). use-site 누적은 런타임 loopIndexStack이 합성한다.
            for depth in for_scope.pending {
                code.push(Op::PushPathIndexSegment as u8);
                code.extend_from_slice(&depth.to_le_bytes());
            }

            // 슬롯 콘텐츠를 자식 선언 순서로 낸다 - 사용처 작성 순서와 무관하게 정규화된다.
            // 콘텐츠 코드는 부모 def 안에 그대로 남아 부모 scope/path로 해석된다(SYNTAX #3.3).
            // 안 채운 슬롯은 아예 안 낸다(미채움 허용).
            for (slot_placeholder_index, slot_placeholder_name) in
                child_slot_placeholders.iter().enumerate()
            {
                let content = contents
                    .iter()
                    .find(|c| slot_name(c) == *slot_placeholder_name);
                let content = match content {
                    Some(c) => c,
                    None => continue,
                };
                code.push(Op::PushSlotPlaceholderContent as u8);
                code.extend_from_slice(&(slot_placeholder_index as u16).to_le_bytes());
                for node in &content.nodes {
                    emit_node(
                        node,
                        props,
                        events,
                        contexts,
                        comp_lookup,
                        for_scope,
                        pool,
                        code,
                        next_slot_placeholder_index,
                        exprs,
                    )?;
                }
                code.push(Op::SlotPlaceholderContentEnd as u8);
            }

            // 정의에 없는 슬롯을 채웠으면 컴파일 에러 - 오타가 조용히 사라지지 않게.
            for content in contents {
                if !child_slot_placeholders
                    .iter()
                    .any(|s| *s == slot_name(content))
                {
                    let kind = CodegenErrorKind::UnknownSlotPlaceholder {
                        comp: name.name.clone(),
                        // 쓸 수 있는 것을 메시지에 실어 준다.
                        declared: child_slot_placeholders
                            .iter()
                            .map(|s| s.map(str::to_string))
                            .collect(),
                    };
                    // 기명은 그 이름을, 무기명은 이름이 없어 합성 호출을 짚는다 - "이 컴포넌트는
                    // 자식 블록을 받지 않는다"가 곧 그 에러다.
                    return Err(match &content.name {
                        Some(slot) => kind.at(slot.range.0),
                        None => kind.at(name.range.0),
                    });
                }
            }

            // RENDER는 자식 def(별도 코드)로 넘어간다 - for_scope는 안 흐른다(자식은 자기 ROOT부터).
            code.push(Op::Render as u8);
            code.extend_from_slice(&child_id.to_le_bytes());
        }
        Node::SlotPlaceholderDef { .. } => {
            // 등장 순서가 곧 인덱스 - collect_slot_placeholders와 같은 순회라 사용쪽과 맞는다.
            code.push(Op::FillSlotPlaceholder as u8);
            code.extend_from_slice(&next_slot_placeholder_index.to_le_bytes());
            *next_slot_placeholder_index += 1;
        }
        Node::If { cond, then, else_ } => {
            // 조건은 bool이어야 한다 - number가 참/거짓으로 새는 걸 막는다(`@if (count > 0)`으로 쓴다).
            require_expr_type(cond, &Type::Bool, props, for_scope.for_vars)?;

            // 소스 리터럴만으로 된 조건은 컴파일타임에 값이 정해진다. 그러면 한쪽 가지가 절대
            // 안 그려지므로, 죽는 가지가 있으면 에러다. 죽는 것이 없을 때(참 + `@else` 없음)만
            // 분기를 접고 몸체를 그 자리에 편다.
            if let Some(folded) = fold_expr(cond) {
                let value = match folded {
                    Folded::Bool(b) => b,
                    _ => unreachable!("bool로 검사가 끝난 조건"),
                };
                if !value || !else_.is_empty() {
                    return Err(CodegenErrorKind::ConstantCondition(value).at(cond.range().0));
                }
                for node in then {
                    emit_node(
                        node,
                        props,
                        events,
                        contexts,
                        comp_lookup,
                        for_scope,
                        pool,
                        code,
                        next_slot_placeholder_index,
                        exprs,
                    )?;
                }
                return Ok(());
            }

            // 잎 하나짜리 식은 슬롯을 그대로 조건으로 쓴다 - (scope_index, offset)으로.
            // 연산자가 붙은 식만 표현식 테이블을 거친다 - 잎 하나에 테이블을 쓸 이유가 없다.
            match cond {
                Expr::Var(var, _) if var.length_target().is_none() => {
                    let (scope_index, offset) =
                        require_leaf_var_ref(var, props, for_scope.for_vars)?;
                    code.push(Op::If as u8);
                    code.push(scope_index);
                    code.push(offset);
                }
                other => {
                    let mut bytes = Vec::new();
                    emit_expr(other, props, for_scope.for_vars, pool, &mut bytes)?;
                    let index = intern_expr(exprs, bytes, other.range().0)?;
                    code.push(Op::IfExpr as u8);
                    code.push(index);
                }
            }

            for node in then {
                emit_node(
                    node,
                    props,
                    events,
                    contexts,
                    comp_lookup,
                    for_scope,
                    pool,
                    code,
                    next_slot_placeholder_index,
                    exprs,
                )?;
            }

            if !else_.is_empty() {
                code.push(Op::Else as u8);
                for node in else_ {
                    emit_node(
                        node,
                        props,
                        events,
                        contexts,
                        comp_lookup,
                        for_scope,
                        pool,
                        code,
                        next_slot_placeholder_index,
                        exprs,
                    )?;
                }
            }

            code.push(Op::IfEnd as u8);
        }
        Node::For {
            item,
            index,
            count,
            body,
        } => {
            // 이름 충돌 검사(섀도잉 금지 - 조회를 순서 무관하게 유지). item/index 둘 다 props/바깥 회차변수와
            // 안 겹쳐야 한다. item==index도 금지(같은 이름 두 슬롯).
            let mut names: Vec<&Ident> = vec![item];
            if let Some(idx) = index {
                names.push(idx);
            }
            let same = index.as_ref().map(|i| i.name == item.name).unwrap_or(false);
            for name in &names {
                let dup = props.iter().any(|p| p.name == name.name)
                    || for_scope
                        .for_vars
                        .iter()
                        .any(|fv| fv.name.as_deref() == Some(name.name.as_str()));
                if dup || same {
                    return Err(
                        CodegenErrorKind::DuplicateBinding(name.name.clone()).at(name.range.0)
                    );
                }
            }

            // 모든 @for는 슬롯 2칸 - item(회차값/요소) + index(회차 번호). base는 props 뒤 바깥 회차변수까지
            // 이어 붙인 자리(안 펼쳐 슬롯=개수), index는 그 다음 칸. 런타임도 같은 규칙(props 슬롯 수 +
            // loopIndexStack 깊이)으로 계산하므로 operand엔 안 싣는다. item 타입은 count 출처로 가른다:
            // 리터럴/숫자 count면 회차값(Number), 배열이면 요소 타입(inner). index는 항상 Number.
            let base = (props.len() + for_scope.for_vars.len()) as u16;
            let item_type = match count {
                ForCount::Literal(n) => {
                    code.push(Op::ForRaw as u8);
                    code.extend_from_slice(&n.to_le_bytes());
                    Type::Number
                }
                ForCount::Var(var) => {
                    let (scope_index, offset, ty) = lookup_var_ref(var, props, for_scope.for_vars)?;
                    match ty {
                        Type::Number => {
                            code.push(Op::ForCountVar as u8);
                            code.push(scope_index);
                            code.push(offset);
                            Type::Number
                        }
                        Type::Array(inner) => {
                            code.push(Op::ForArrayVar as u8);
                            code.push(scope_index);
                            code.push(offset);
                            (**inner).clone()
                        }
                        _ => {
                            let kind = CodegenErrorKind::ForCountNotIterable(var_ref_display(var));
                            return Err(kind.at(var.range.0));
                        }
                    }
                }
            };

            // @for 진입 - depth_base를 pending에 추가(다음 세그먼트/이벤트가 접미), 다음 @for는
            // depth_base+1. 컴포넌트-로컬 깊이라 자식 컴포넌트로 안 넘어간다(RENDER가 경계).
            let mut nested = for_scope.pending.to_vec();
            nested.push(for_scope.depth_base);
            // 회차변수도 바깥 것에 이어 붙여 전파(pending과 동일 누적 - 안쪽일수록 쌓임). item(base) + index(base+1)
            // 2칸을 잇는다. index는 이름 없으면 None(슬롯만 점유, 몸체 참조 불가) - 그래도 슬롯은 항상 잡아 $n 정합.
            let mut nested_vars = for_scope.for_vars.to_vec();
            nested_vars.push(ForVar {
                name: Some(item.name.clone()),
                offset: base,
                type_: item_type,
            });
            nested_vars.push(ForVar {
                name: index.as_ref().map(|i| i.name.clone()),
                offset: base + 1,
                type_: Type::Number,
            });
            let body_scope = ForScope {
                pending: &nested,
                depth_base: for_scope.depth_base + 1,
                for_vars: &nested_vars,
            };
            for node in body {
                emit_node(
                    node,
                    props,
                    events,
                    contexts,
                    comp_lookup,
                    body_scope,
                    pool,
                    code,
                    next_slot_placeholder_index,
                    exprs,
                )?;
            }

            code.push(Op::ForEnd as u8);
        }
        Node::With { context, children } => {
            // context_index는 이 컴포넌트 contexts에서 이름으로 찾는다(선언 순서 = index,
            // event_index 찾기와 동형). 미선언 컨텍스트는 에러.
            let context_index = contexts
                .iter()
                .position(|c| c.name == context.name)
                .ok_or_else(|| {
                    CodegenErrorKind::UnknownContext(context.name.clone()).at(context.range.0)
                })? as u16;
            code.push(Op::EnterContext as u8);
            code.extend_from_slice(&context_index.to_le_bytes());

            for node in children {
                emit_node(
                    node,
                    props,
                    events,
                    contexts,
                    comp_lookup,
                    for_scope,
                    pool,
                    code,
                    next_slot_placeholder_index,
                    exprs,
                )?;
            }

            // ExitContext는 operand 없는 마커(IfEnd 동형).
            code.push(Op::ExitContext as u8);
        }
    }
    Ok(())
}
