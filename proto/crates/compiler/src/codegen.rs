//! AST -> 바이트코드 Module. 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간.

use crate::ast::{ArgValue, AttrValue, Context, Event, ForCount, LitValue, Node, Prop, Type, VarRef};
use crate::resolve::FlatComp;
use bytecode::{
    encode, tags, CompDef, Const, ConstPool, ContextDef, EventDef, Field, FieldValue, Module, Op,
    TypeEntry,
};

#[derive(Debug, PartialEq, Eq)]
pub enum CodegenError {
    /// 내장 태그 테이블에 없는 태그.
    UnknownTag(String),
    /// props에 선언되지 않은 변수 참조.
    UnknownProp(String),
    /// 호출했지만 파일에 정의가 없는 컴포넌트.
    UnknownComponent(String),
    /// 자식 prop명이 자식 props 선언에 없음 (use-site 바인딩 오류).
    UnknownArg { comp: String, prop: String },
    /// `@click:EVENT`이 이 컴포넌트 events에 없는 이벤트명을 가리킴.
    UnknownEvent(String),
    /// `@with Context`가 이 컴포넌트 contexts에 없는 컨텍스트명을 가리킴.
    UnknownContext(String),
    /// prop 경로가 존재하지 않는 필드를 가리킴(객체 아닌 값에 `.field`, 또는 없는 필드명).
    UnknownField { root: String, field: String },
    /// 값 자리(보간·속성·payload·context)에 leaf(원시)가 아닌 객체/배열 경로가 왔다.
    /// 반응성·값 자리엔 leaf만 올 수 있다 - 객체 통째는 안 넘긴다.
    NotLeaf(String),
    /// 객체 통째 전달(`user={user}`)에서 넘긴 경로의 도달 타입이 자식 prop 타입과 구조가 다르다.
    /// leaf를 순서로 짝지으므로 필드 이름·순서·타입이 일치해야 한다.
    PropTypeMismatch { comp: String, prop: String },
    /// FieldValue 인덱스가 축별 상한을 넘었다(Scope/Raw 14비트, Const 15비트). u16 한 칸에
    /// 태그 + 인덱스를 패킹하므로 인덱스가 넘으면 태그를 침범한다 - 발급 지점에서 거른다.
    IndexOverflow { kind: &'static str, value: u16, max: u16 },
    /// @for 회차변수 이름이 prop 또는 바깥 회차변수와 겹친다. 섀도잉을 막아 이름 조회를
    /// 순서 무관하게(매치 최대 하나) 유지한다 - 다른 이름을 쓰라는 컴파일 에러.
    DuplicateBinding(String),
    /// `@for (x of arr)`의 count가 배열도 숫자도 아니다(bool/객체 등 - 반복 횟수로 못 쓴다).
    ForCountNotIterable(String),
}

/// 컴포넌트 이름 -> (ID, props 선언) 룩업. 합성 호출(`Comp(...)`)을 만났을 때 RENDER에 박을 ID를
/// 찾고, PUSH_ARG를 자식 props 순서로 정렬하려고 props 선언도 같이 돌려준다. 컴포넌트 ID = 정의 순서.
struct CompLookup<'a> {
    by_name: std::collections::HashMap<&'a str, (u16, &'a [Prop])>,
}

impl<'a> CompLookup<'a> {
    fn build(comps: &'a [FlatComp]) -> Self {
        let by_name = comps
            .iter()
            .enumerate()
            .map(|(i, fc)| (fc.comp.name.as_str(), (i as u16, fc.comp.props.as_slice())))
            .collect();
        CompLookup { by_name }
    }

    /// 이름으로 (컴포넌트 ID, 자식 props 선언)을 찾는다.
    fn get(&self, name: &str) -> Option<(u16, &'a [Prop])> {
        self.by_name.get(name).copied()
    }
}

/// 파일의 컴포넌트 정의들을 하나의 직렬화된 Module로. 컴포넌트 ID = 정의 순서.
/// 두 번째 반환값은 리소스 사이드맵 - 인덱스가 모듈 전역 resId, 값이 정규화 경로.
/// 빌드 단계가 이걸 받아 내용 해시·복사·URL화를 한다(BYTECODE.md §5 LOAD_RES 메모).
pub fn generate(comps: &[FlatComp]) -> Result<(Box<[u8]>, Vec<String>), CodegenError> {
    let comp_lookup = CompLookup::build(comps);
    let mut pool = ConstPool::new();
    let mut types = TypeTable::new();
    let mut code = Vec::new();
    let mut defs = Vec::new();
    // 정규화 경로 -> resId. 등장 순서로 0,1,2…. 같은 경로는 같은 resId(모듈 전역 dedup).
    let mut res_ids: Vec<String> = Vec::new();

    // 각 컴포넌트 코드를 이어붙이고 off/len으로 구획한다.
    for fc in comps {
        let comp = &fc.comp;
        let name_const_index = pool.intern_str(&comp.name);
        let code_off = code.len() as u32;
        // 리소스 로드를 정의 앞머리에 깐다. lazy build에서 이 컴포넌트가 실제로 그려질 때만
        // 실행돼 리소스가 로드된다(같은 파일 컴포넌트가 같은 LOAD_RES를 내도 런타임이 URL dedup).
        for res_path in &fc.resources {
            let res_id = res_id_for(&mut res_ids, res_path);
            code.push(Op::LoadRes as u8);
            code.extend_from_slice(&res_id.to_le_bytes());
        }
        for node in &comp.template {
            emit_node(
                node,
                &comp.props,
                &comp.events,
                &comp.contexts,
                &comp_lookup,
                ForScope::ROOT,
                &mut pool,
                &mut code,
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
                    .map(|(field, value)| {
                        arg_to_field(field, value, &comp.props, &mut pool, &mut types)
                    })
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
                    .map(|(field, value)| {
                        arg_to_field(field, value, &comp.props, &mut pool, &mut types)
                    })
                    .collect::<Result<Vec<_>, CodegenError>>()?;
                Ok(ContextDef {
                    name_const_index: pool.intern_str(&c.name),
                    fields,
                })
            })
            .collect::<Result<Vec<_>, CodegenError>>()?;
        defs.push(CompDef {
            name_const_index,
            code_off,
            code_len: code.len() as u32 - code_off,
            events,
            contexts,
        });
    }

    let module = Module::new(pool, types.into_entries(), defs, code);
    Ok((encode(&module).into_boxed_slice(), res_ids))
}

/// 정규화 경로의 모듈 전역 resId. 이미 본 경로면 그 인덱스, 처음이면 끝에 추가하고 새 인덱스.
fn res_id_for(res_ids: &mut Vec<String>, path: &str) -> u16 {
    if let Some(i) = res_ids.iter().position(|p| p == path) {
        return i as u16;
    }
    res_ids.push(path.to_string());
    (res_ids.len() - 1) as u16
}

/// 타입이 scope offset 공간에서 차지하는 슬롯 수. scope 인덱스는 props를 선언 순서로 펼친
/// 평탄 번호라, 앞 prop들이 차지하는 칸을 세는 데 쓴다. 원시는 1(leaf), 객체는 필드 슬롯의 합.
/// 배열은 1 - 슬롯 하나에 참조((ARR, arrInfoIndex))로 앉고 요소는 그 뒤(arrInfo)에 산다.
fn slot_count(ty: &Type) -> u16 {
    match ty {
        Type::Bool | Type::Number | Type::String => 1,
        Type::Array(_) => 1,
        Type::Object(fields) => fields.iter().map(|(_, t)| slot_count(t)).sum(),
        Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
    }
}

/// prop 참조(root + 객체 경로)를 경로 따라 걸어 도달 타입과 그 아래 leaf들의 scope 인덱스로
/// 쪼갠다. scope 인덱스는 props를 선언 순서로 펼친 leaf 번호다. 도달 타입이 leaf(원시)면 길이
/// 1(그 offset 하나), 객체/배열이면 펼친 leaf 수만큼(연속) - 객체 통째 전달(`user={user}`)이
/// 자식 leaf마다 PushArg 하나로 쪼개진다.
fn split_var_ref_to_scope_indices<'a>(
    var: &VarRef,
    props: &'a [Prop],
    for_vars: &'a [ForVar],
) -> Result<(&'a Type, Vec<u16>), CodegenError> {
    // root를 회차변수(@for item)에서 먼저 찾는다. props와 이름이 겹칠 수 없어(@for 진입에서
    // 충돌을 에러로 건다) 조회 순서는 무관. root의 base/ty만 다를 뿐, 아래 path 내려가기는
    // props와 같은 로직 - 스칼라도 객체 요소도 한 경로로 선다:
    //
    //   {tag}       root=tag(for_var)   path=[]       -> ty=String, base=offset
    //   {item.title} root=item(for_var) path=[title]  -> path 내려가며 offset 누적
    //   {user.name}  root=user(prop)    path=[name]    -> props에서 base, 이하 동일
    let (mut base, mut ty) = match for_vars.iter().find(|fv| fv.name == var.root) {
        Some(fv) => (fv.offset, &fv.type_),
        None => {
            let mut base = 0u16;
            let mut ty = None;
            for p in props {
                if p.name == var.root {
                    ty = Some(&p.type_);
                    break;
                }
                base += slot_count(&p.type_);
            }
            (base, ty.ok_or_else(|| CodegenError::UnknownProp(var.root.clone()))?)
        }
    };

    // 경로를 타입 따라 내려가며 offset을 누적한다. 각 단계에서 앞 형제 필드의 leaf 수를 더한다.
    for key in &var.path {
        let fields = match ty {
            Type::Object(fields) => fields,
            _ => {
                return Err(CodegenError::UnknownField {
                    root: var.root.clone(),
                    field: key.clone(),
                })
            }
        };
        let mut found = None;
        for (name, field_ty) in fields {
            if name == key {
                found = Some(field_ty);
                break;
            }
            base += slot_count(field_ty);
        }
        ty = found.ok_or_else(|| CodegenError::UnknownField {
            root: var.root.clone(),
            field: key.clone(),
        })?;
    }

    // 도달 타입의 leaf들은 base부터 연속이다(같은 순회로 offset을 매겼으므로).
    let indices = (base..base + slot_count(ty)).collect();
    Ok((ty, indices))
}

/// prop 참조를 단일 leaf(원시)의 scope 인덱스로. 값·반응성 자리(보간·속성·payload·context·@if
/// 조건)엔 leaf만 올 수 있다 - 객체/배열 통째는 안 넘긴다. `split_var_ref_to_scope_indices` 위
/// leaf-only 래퍼.
fn var_ref_to_scope_index(
    var: &VarRef,
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<u16, CodegenError> {
    let (ty, indices) = split_var_ref_to_scope_indices(var, props, for_vars)?;
    match ty {
        Type::Bool | Type::Number | Type::String => Ok(indices[0]),
        _ => Err(CodegenError::NotLeaf(var_ref_display(var))),
    }
}

/// 두 타입이 구조적으로 동일한가 - 필드 이름·순서·타입이 재귀로 일치. 객체 통째 전달에서
/// 넘긴 경로의 도달 타입과 자식 prop 타입이 같은 leaf 배치인지 검사(순서만으로 leaf를 짝지으므로
/// 이름·순서가 어긋나면 엉뚱하게 이어진다). (Ref/Omit/Pick은 resolve가 이미 Object로 풀었다.)
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

/// props를 선언 순서로 펼친 leaf 경로들. `var_ref_to_scope_index`와 같은 순회라
/// 결과 벡터의 인덱스 = scope 인덱스다. 스칼라는 이름 그대로(`heading`), 객체는 필드까지
/// 점 경로(`general.a.title`). manifest.props가 되어 런타임 paths[i]를 store 경로에 잇는다.
pub fn flatten_prop_paths(props: &[Prop]) -> Vec<String> {
    let mut paths = Vec::new();
    for p in props {
        push_leaf_paths(&p.name, &p.type_, &mut paths);
    }
    paths
}

/// 한 타입의 leaf 경로들을 prefix 아래로 펼쳐 push. 객체는 필드 선언 순서로 재귀.
/// (배열은 요소 타입으로 - 요소 1벌 취급.)
fn push_leaf_paths(prefix: &str, ty: &Type, out: &mut Vec<String>) {
    match ty {
        Type::Bool | Type::Number | Type::String => out.push(prefix.to_string()),
        Type::Array(inner) => push_leaf_paths(prefix, inner, out),
        Type::Object(fields) => {
            for (name, field_ty) in fields {
                push_leaf_paths(&format!("{prefix}.{name}"), field_ty, out);
            }
        }
        Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
    }
}

/// 에러 메시지용 경로 표기: `root.a.b`.
fn var_ref_display(var: &VarRef) -> String {
    if var.path.is_empty() {
        var.root.clone()
    } else {
        format!("{}.{}", var.root, var.path.join("."))
    }
}

/// 모듈 전역 타입 테이블(dedup). Type을 intern해 type_ref를 발급한다. 자식부터 등록해
/// 참조가 먼저 존재하게 한다(Object 필드가 자식 type_ref를 가리킴). 같은 구조는 한 엔트리 공유
/// - TypeEntry 자체가 키라, 필드명(상수풀 인덱스)·순서·자식 type_ref가 모두 같아야 동일 엔트리다.
struct TypeTable {
    entries: Vec<TypeEntry>,
    cache: std::collections::HashMap<TypeEntry, u16>,
}

impl TypeTable {
    fn new() -> Self {
        TypeTable { entries: Vec::new(), cache: std::collections::HashMap::new() }
    }

    /// Type의 구조를 테이블에 intern하고 type_ref 반환. object는 필드 자식부터 재귀 intern.
    /// 필드명은 상수풀 인덱스로. (Ref/Omit/Pick은 resolve가 이미 풀었다 - split과 같은 전제.)
    fn intern(&mut self, ty: &Type, pool: &mut ConstPool) -> u16 {
        let entry = match ty {
            Type::Bool | Type::Number | Type::String => TypeEntry::Scalar,
            Type::Array(inner) => return self.intern(inner, pool),
            Type::Object(fields) => {
                let fields = fields
                    .iter()
                    .map(|(name, field_ty)| (pool.intern_str(name), self.intern(field_ty, pool)))
                    .collect();
                TypeEntry::Object(fields)
            }
            Type::Ref(n) => unreachable!("resolve가 Type::Ref({n})를 안 풀었다"),
            Type::Omit(..) | Type::Pick(..) => unreachable!("resolve가 유틸 타입을 안 풀었다"),
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

/// payload/context field 명세 하나 = 필드명 + 조립 구조(type_ref) + 채울 leaf 목록.
/// Var는 도달 타입을 테이블에 intern하고 그 아래 leaf들의 scope 인덱스를 싣는다(객체면 여럿,
/// 스칼라면 하나). Literal은 스칼라 type_ref + Const leaf 하나(객체 리터럴은 문법상 없다).
fn arg_to_field(
    field: &str,
    value: &ArgValue,
    props: &[Prop],
    pool: &mut ConstPool,
    types: &mut TypeTable,
) -> Result<Field, CodegenError> {
    let (type_ref, refs) = match value {
        ArgValue::Var(var) => {
            // events/contexts는 컴포넌트 최상위 선언이라 @for 몸체 밖 - 회차변수가 올 수 없다.
            let (ty, indices) = split_var_ref_to_scope_indices(var, props, &[])?;
            let type_ref = types.intern(ty, pool);
            let refs = indices
                .into_iter()
                .map(|i| {
                    FieldValue::try_scope(i).map_err(|value| CodegenError::IndexOverflow {
                        kind: "Scope",
                        value,
                        max: FieldValue::SCOPE_MAX,
                    })
                })
                .collect::<Result<_, _>>()?;
            (type_ref, refs)
        }
        ArgValue::Literal(lit) => {
            // 리터럴은 항상 스칼라(객체 리터럴 없음). Scalar 엔트리 하나를 intern해 공유.
            let type_ref = types.intern(&lit_type(lit), pool);
            let const_ref = FieldValue::try_const(pool.intern(lit_to_const(lit))).map_err(|value| {
                CodegenError::IndexOverflow { kind: "Const", value, max: FieldValue::CONST_MAX }
            })?;
            (type_ref, vec![const_ref])
        }
    };
    Ok(Field { name_const_index: pool.intern_str(field), type_ref, refs })
}

/// 리터럴의 quble 타입. 리터럴은 스칼라라 Bool/Number/String 중 하나(intern은 모두 Scalar 엔트리).
fn lit_type(lit: &LitValue) -> Type {
    match lit {
        LitValue::Str(_) => Type::String,
        LitValue::Number(_) => Type::Number,
        LitValue::Bool(_) => Type::Bool,
    }
}

/// 리터럴을 상수풀 엔트리로. 소스의 타입을 그대로 실어 런타임이 올바른 JS 값으로 복원한다.
fn lit_to_const(lit: &LitValue) -> Const {
    match lit {
        LitValue::Str(s) => Const::Str(s.clone()),
        LitValue::Number(n) => Const::Num(*n),
        LitValue::Bool(b) => Const::Bool(*b),
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
    const ROOT: ForScope<'static> = ForScope { pending: &[], depth_base: 0, for_vars: &[] };
}

/// @for 회차변수 하나. name = 루프 변수명(`@for (tag of ..)`의 tag), offset = 이 변수가
/// 앉는 scope 슬롯(props leaf 뒤에 회차 진입 순서로 이어짐), type_ = 요소 타입(배열 inner).
#[derive(Clone)]
struct ForVar {
    name: String,
    offset: u16,
    type_: Type,
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
) -> Result<(), CodegenError> {
    match node {
        Node::Text(s) => {
            let index = pool.intern_str(s);
            code.push(Op::Text as u8);
            code.extend_from_slice(&index.to_le_bytes());
        }
        Node::Var(var) => {
            let index = var_ref_to_scope_index(var, props, for_scope.for_vars)?;
            code.push(Op::TextVar as u8);
            code.extend_from_slice(&index.to_le_bytes());
        }
        Node::Element {
            tag,
            attrs,
            event_bindings,
            children,
        } => {
            let tag_id = tags::tag_id(tag).ok_or_else(|| CodegenError::UnknownTag(tag.clone()))?;

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
                    .position(|e| &e.name == event_name)
                    .ok_or_else(|| CodegenError::UnknownEvent(event_name.clone()))?
                    as u16;
                code.push(Op::BindEvent as u8);
                code.extend_from_slice(&event_type.to_le_bytes());
                code.extend_from_slice(&event_index.to_le_bytes());
            }

            for (name, value) in attrs {
                // 두 축이 opcode를 가른다.
                //   name : 전역 속성명 테이블에 있으면 G(전역 ID), 없으면 L(상수풀 인덱스)
                //   value: 정적이면 상수풀 인덱스, 변수면 scope index
                let is_var = matches!(value, AttrValue::Var(_));
                let (op, name_operand) = match bytecode::attrs::attr_id(name) {
                    Some(global_id) => (if is_var { Op::AttrGVar } else { Op::AttrG }, global_id),
                    None => (
                        if is_var { Op::AttrLVar } else { Op::AttrL },
                        pool.intern_str(name),
                    ),
                };
                let value_operand = match value {
                    AttrValue::Static(s) => pool.intern_str(s),
                    AttrValue::Var(v) => var_ref_to_scope_index(v, props, for_scope.for_vars)?,
                };
                code.push(op as u8);
                code.extend_from_slice(&name_operand.to_le_bytes());
                code.extend_from_slice(&value_operand.to_le_bytes());
            }

            code.push(Op::ElemCloseOpen as u8);

            // element는 세그먼트를 안 만든다 - 자식으로 for_scope를 그대로 흘려보낸다
            // (같은 @for 안 중첩 element가 같은 인덱스를 이벤트에 실을 수 있게 pending 유지).
            for child in children {
                emit_node(child, props, events, contexts, comp_lookup, for_scope, pool, code)?;
            }

            // END는 operand 없음 - 가장 최근에 연 태그를 닫는다(중첩이 보장됨).
            code.push(Op::ElemEnd as u8);
        }
        Node::Component { alias, name, args } => {
            // 자식 ID와 props 선언을 찾는다.
            let (child_id, child_props) = comp_lookup
                .get(name)
                .ok_or_else(|| CodegenError::UnknownComponent(name.clone()))?;

            // 자식 props 선언 순서대로 인자를 낸다. 변수 바인딩(`prop={x}`)은 부모 scope index을 싣는
            // PUSH_ARG, 리터럴(`prop="lit"`)은 상수풀 인덱스를 싣는 PUSH_ARG_LIT.
            // (지금은 전부 바인딩 가정 - 순서만으로 매핑.)
            for child_prop in child_props {
                let arg_value = args
                    .iter()
                    .find(|(p, _)| *p == child_prop.name)
                    .map(|(_, v)| v)
                    .ok_or_else(|| CodegenError::UnknownArg {
                        comp: name.clone(),
                        prop: child_prop.name.clone(),
                    })?;
                match arg_value {
                    ArgValue::Var(parent_var) => {
                        // 도달 타입이 자식 prop 타입과 구조가 같아야 leaf를 순서로 짝짓는다.
                        // 스칼라면 leaf 1개 - 지금까지와 동일하게 PushArg 하나.
                        let (reached_ty, scope_indices) =
                            split_var_ref_to_scope_indices(parent_var, props, for_scope.for_vars)?;
                        if !types_match(reached_ty, &child_prop.type_) {
                            return Err(CodegenError::PropTypeMismatch {
                                comp: name.clone(),
                                prop: child_prop.name.clone(),
                            });
                        }
                        for scope_index in scope_indices {
                            code.push(Op::PushThrough as u8);
                            code.extend_from_slice(&scope_index.to_le_bytes());
                        }
                    }
                    ArgValue::Literal(literal) => {
                        let value_index = pool.intern(lit_to_const(literal));
                        code.push(Op::PushArgLit as u8);
                        code.extend_from_slice(&value_index.to_le_bytes());
                    }
                }
            }

            // 합성 경로 세그먼트 = use-site alias가 있으면 alias, 없으면 자식 type-name.
            // 뒤따르는 RENDER가 소비해 자식 경로 prefix에 잇는다 - 이벤트 fullname의 path 축.
            // (alias 생략 = 동일 type-name 공유, alias 부여 = 분리. §1.3)
            let segment = alias.as_deref().unwrap_or(name);
            let segment_index = pool.intern_str(segment);
            code.push(Op::PushPathSegment as u8);
            code.extend_from_slice(&segment_index.to_le_bytes());

            // @for 안이면 이 세그먼트가 pending 인덱스를 접미한다(VideoItem[$0]). 깊이는 컴포넌트-로컬
            // (자기 컴포넌트 안 @for만 0,1,2). use-site 누적은 런타임 loopIndexStack이 합성한다.
            for depth in for_scope.pending {
                code.push(Op::PushPathIndexSegment as u8);
                code.extend_from_slice(&depth.to_le_bytes());
            }

            // RENDER는 자식 def(별도 코드)로 넘어간다 - for_scope는 안 흐른다(자식은 자기 ROOT부터).
            code.push(Op::Render as u8);
            code.extend_from_slice(&child_id.to_le_bytes());
        }
        Node::If { cond, then, else_ } => {
            // cond는 불리언 prop 참조 - 경로를 평탄 scope index로. leaf여야 한다. (표현식은 이후 단계)
            let scope_index = var_ref_to_scope_index(cond, props, for_scope.for_vars)?;
            code.push(Op::If as u8);
            code.extend_from_slice(&scope_index.to_le_bytes());

            for node in then {
                emit_node(node, props, events, contexts, comp_lookup, for_scope, pool, code)?;
            }

            if !else_.is_empty() {
                code.push(Op::Else as u8);
                for node in else_ {
                    emit_node(node, props, events, contexts, comp_lookup, for_scope, pool, code)?;
                }
            }

            code.push(Op::IfEnd as u8);
        }
        Node::For { item, count, body } => {
            // count 출처로 opcode를 가른다 - 리터럴은 값 직접(ForRaw), prop 참조는 ForScopeIndex.
            // prop이 숫자면 반복 횟수(item 무의미), 배열이면 순회(item을 회차변수로 등록).
            let mut new_for_var = None;
            match count {
                ForCount::Literal(n) => {
                    code.push(Op::ForRaw as u8);
                    code.extend_from_slice(&n.to_le_bytes());
                }
                ForCount::Var(var) => {
                    let (ty, indices) =
                        split_var_ref_to_scope_indices(var, props, for_scope.for_vars)?;
                    match ty {
                        Type::Number => {}
                        Type::Array(inner) => {
                            // 이름 충돌은 에러(섀도잉 금지 - 조회를 순서 무관하게 유지).
                            if props.iter().any(|p| &p.name == item)
                                || for_scope.for_vars.iter().any(|fv| &fv.name == item)
                            {
                                return Err(CodegenError::DuplicateBinding(item.clone()));
                            }
                            // 요소값이 앉을 슬롯 - props 슬롯 뒤에 바깥 회차변수까지 이어 붙인 자리.
                            let props_slots: u16 = props.iter().map(|p| slot_count(&p.type_)).sum();
                            new_for_var = Some(ForVar {
                                name: item.clone(),
                                offset: props_slots + for_scope.for_vars.len() as u16,
                                type_: (**inner).clone(),
                            });
                        }
                        _ => return Err(CodegenError::ForCountNotIterable(var_ref_display(var))),
                    }
                    code.push(Op::ForScopeIndex as u8);
                    code.extend_from_slice(&indices[0 /* slot_count=1, 단일 슬롯 offset */].to_le_bytes());
                }
            }

            // @for 진입 - depth_base를 pending에 추가(다음 세그먼트/이벤트가 접미), 다음 @for는
            // depth_base+1. 컴포넌트-로컬 깊이라 자식 컴포넌트로 안 넘어간다(RENDER가 경계).
            let mut nested = for_scope.pending.to_vec();
            nested.push(for_scope.depth_base);
            // 회차변수도 바깥 것에 이어 붙여 전파(pending과 동일 누적 - 안쪽일수록 쌓임).
            let mut nested_vars = for_scope.for_vars.to_vec();
            nested_vars.extend(new_for_var);
            let body_scope = ForScope {
                pending: &nested,
                depth_base: for_scope.depth_base + 1,
                for_vars: &nested_vars,
            };
            for node in body {
                emit_node(node, props, events, contexts, comp_lookup, body_scope, pool, code)?;
            }

            code.push(Op::ForEnd as u8);
        }
        Node::With { context, children } => {
            // context_index는 이 컴포넌트 contexts에서 이름으로 찾는다(선언 순서 = index,
            // event_index 찾기와 동형). 미선언 컨텍스트는 에러.
            let context_index = contexts
                .iter()
                .position(|c| &c.name == context)
                .ok_or_else(|| CodegenError::UnknownContext(context.clone()))?
                as u16;
            code.push(Op::EnterContext as u8);
            code.extend_from_slice(&context_index.to_le_bytes());

            for node in children {
                emit_node(node, props, events, contexts, comp_lookup, for_scope, pool, code)?;
            }

            // ExitContext는 operand 없는 마커(IfEnd 동형).
            code.push(Op::ExitContext as u8);
        }
    }
    Ok(())
}
