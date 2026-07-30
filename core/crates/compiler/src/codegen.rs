//! AST -> 바이트코드 Module. 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간.

use crate::ast::{
    ArgValue, AttrValue, Context, Event, ForCount, Ident, LitValue, Node, Prop,
    SlotPlaceholderContent, Type, VarRef,
};
use crate::flatten::FlatComp;
use crate::src_range::SrcRange;
use bytecode::{
    encode, tags, CompDef, Const, ConstPool, ContextDef, EventDef, Field, FieldValue, Module, Op,
    TypeEntry,
};

#[derive(Debug, PartialEq, Eq)]
pub enum CodegenErrorKind {
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
    /// 값 자리(보간/속성/payload/context)에 leaf(원시)가 아닌 객체/배열 경로가 왔다.
    /// 반응성/값 자리엔 leaf만 올 수 있다 - 객체 통째는 안 넘긴다.
    NotLeaf(String),
    /// 객체 통째 전달(`user={user}`)에서 넘긴 경로의 도달 타입이 자식 prop 타입과 구조가 다르다.
    /// leaf를 순서로 짝지으므로 필드 이름/순서/타입이 일치해야 한다.
    PropTypeMismatch { comp: String, prop: String },
    /// scope_index/offset이 u8(255)를 넘었다(BYTECODE.md - 둘 다 u8 operand). 안 펼쳐 슬롯 =
    /// props/for_var 개수라 정상 컴포넌트는 안 넘지만, 넘으면 넘친 변수 참조를 담아 위치를 알린다.
    SlotOverflow(String),
    /// @for 회차변수 이름이 prop 또는 바깥 회차변수와 겹친다. 섀도잉을 막아 이름 조회를
    /// 순서 무관하게(매치 최대 하나) 유지한다 - 다른 이름을 쓰라는 컴파일 에러.
    DuplicateBinding(String),
    /// `@for (x of arr)`의 count가 배열도 숫자도 아니다(bool/객체 등 - 반복 횟수로 못 쓴다).
    ForCountNotIterable(String),
    /// 자식이 정의하지 않은 슬롯을 채웠다(`Header << ...`인데 자식에 `@slot(Header)` 없음).
    /// 무기명(None)이면 자식이 `@slot()`을 안 뒀는데 자식 블록을 준 경우.
    UnknownSlotPlaceholder {
        comp: String,
        slot_placeholder: Option<String>,
    },
    /// 한 컴포넌트가 같은 슬롯 자리를 두 번 선언했다(`@slot()` 둘, 또는 같은 이름 `@slot(H)` 둘).
    /// 콘텐츠는 한 덩이라 어느 자리로 갈지 정할 수 없다 - 복제하지 않고 막는다.
    DuplicateSlotPlaceholderDef {
        comp: String,
        slot_placeholder: Option<String>,
    },
}

impl std::fmt::Display for CodegenErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            CodegenErrorKind::UnknownTag(tag) => write!(f, "unknown builtin tag `{tag}`"),
            CodegenErrorKind::UnknownProp(name) => {
                write!(f, "`{name}` is not declared in props")
            }
            CodegenErrorKind::UnknownComponent(name) => {
                write!(f, "cannot find component `{name}`")
            }
            CodegenErrorKind::UnknownArg { comp, prop } => {
                write!(f, "`{comp}` has no prop `{prop}`")
            }
            CodegenErrorKind::UnknownEvent(name) => {
                write!(f, "`{name}` is not declared in events")
            }
            CodegenErrorKind::UnknownContext(name) => {
                write!(f, "`{name}` is not declared in contexts")
            }
            CodegenErrorKind::UnknownField { root, field } => {
                write!(f, "no field `{field}` on prop `{root}`")
            }
            CodegenErrorKind::NotLeaf(path) => write!(
                f,
                "`{path}` is an object or array: only primitive values go in value position"
            ),
            CodegenErrorKind::PropTypeMismatch { comp, prop } => write!(
                f,
                "value passed to prop `{prop}` of `{comp}` has a different shape: field names, order and types must match"
            ),
            CodegenErrorKind::SlotOverflow(name) => {
                write!(f, "more than 255 slots: `{name}` does not fit")
            }
            CodegenErrorKind::DuplicateBinding(name) => write!(
                f,
                "@for binding `{name}` shadows a prop or an outer binding: use another name"
            ),
            CodegenErrorKind::ForCountNotIterable(path) => write!(
                f,
                "`{path}` is neither an array nor a number: it cannot drive @for"
            ),
            CodegenErrorKind::UnknownSlotPlaceholder {
                comp,
                slot_placeholder,
            } => match slot_placeholder {
                Some(slot) => write!(f, "`{comp}` declares no slot `{slot}` (`@slot({slot})`)"),
                None => write!(f, "`{comp}` declares no unnamed slot (`@slot()`)"),
            },
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
        }
    }
}

/// codegen 실패 - 무엇이(kind) 어디서(range) 틀렸나.
///
/// range가 Option인 건 탓할 자리가 아예 없는 에러가 있어서다. 안 넘긴 prop(UnknownArg)이
/// 그렇다 - 없는 것은 소스에 자리가 없다. 그런 자리를 0..0 같은 가짜 값으로 꾸미지 않고
/// None으로 정직하게 둔다. 아직 구간을 안 든 AST 자리(이벤트명, @for 회차변수)도 None이다.
#[derive(Debug, PartialEq, Eq)]
pub struct CodegenError {
    pub kind: CodegenErrorKind,
    pub range: Option<SrcRange>,
}

impl CodegenErrorKind {
    /// 위치를 아는 에러(AST 노드가 구간을 든 경우).
    fn at(self, range: SrcRange) -> CodegenError {
        CodegenError {
            kind: self,
            range: Some(range),
        }
    }

    /// 위치를 모르는 에러 - 탓할 AST 노드가 아직 구간을 안 든다.
    fn no_range(self) -> CodegenError {
        CodegenError {
            kind: self,
            range: None,
        }
    }
}

/// 컴포넌트 이름 -> (ID, props 선언, 슬롯 선언) 룩업. 합성 호출(`Comp(...)`)을 만났을 때 RENDER에
/// 박을 ID를 찾고, PUSH_ARG를 자식 props 순서로, 슬롯 콘텐츠를 자식 슬롯 순서로 정렬하려고
/// 선언도 같이 돌려준다. 컴포넌트 ID = 정의 순서.
struct CompLookup<'a> {
    by_name: std::collections::HashMap<&'a str, (u16, &'a [Prop], Vec<Option<&'a str>>)>,
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
    fn get(&self, name: &str) -> Option<(u16, &'a [Prop], &[Option<&'a str>])> {
        self.by_name
            .get(name)
            .map(|(id, props, slot_placeholders)| (*id, *props, slot_placeholders.as_slice()))
    }
}

/// 슬롯 콘텐츠의 이름(무기명이면 None). 선언쪽 `Vec<Option<&str>>`과 짝지어 비교하는 형태로 맞춘다.
fn slot_name(content: &SlotPlaceholderContent) -> Option<&str> {
    content.name.as_ref().map(|n| n.name.as_str())
}

/// template을 훑어 `@slot` 선언을 등장 순서로 모은다(무기명이면 None). 이 순서가 slot_placeholder_index다.
/// 중첩 노드(요소 자식/@if/@for/@with) 안의 슬롯도 같은 순서 공간에 들어간다.
///
/// 이름만이 아니라 Ident째로 모은다 - 중복 선언 에러가 그 이름 자리를 가리켜야 한다.
fn collect_slot_placeholders(nodes: &[Node]) -> Vec<Option<&Ident>> {
    let mut slot_placeholders = Vec::new();
    walk_slot_placeholders(nodes, &mut slot_placeholders);
    slot_placeholders
}

/// 슬롯 선언 목록에서 이름만 뽑는다(무기명이면 None). 자리 찾기는 이름으로만 하므로
/// 위치를 안 쓰는 소비처(CompLookup, 사용쪽 매칭)는 이 형태를 쓴다.
fn slot_def_names<'a>(slot_placeholders: &[Option<&'a Ident>]) -> Vec<Option<&'a str>> {
    slot_placeholders
        .iter()
        .map(|s| s.map(|i| i.name.as_str()))
        .collect()
}

fn walk_slot_placeholders<'a>(nodes: &'a [Node], slot_placeholders: &mut Vec<Option<&'a Ident>>) {
    for node in nodes {
        match node {
            Node::SlotPlaceholderDef { name } => slot_placeholders.push(name.as_ref()),
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
    slot_placeholders: &[Option<&Ident>],
) -> Result<(), CodegenError> {
    let names = slot_def_names(slot_placeholders);
    for (i, slot_placeholder) in slot_placeholders.iter().enumerate() {
        let name = slot_placeholder.map(|s| s.name.as_str());
        if names[..i].contains(&name) {
            let kind = CodegenErrorKind::DuplicateSlotPlaceholderDef {
                comp: comp.to_string(),
                slot_placeholder: name.map(str::to_string),
            };
            // 뒤에 온 중복 선언을 가리킨다(먼저 온 것이 자리를 차지했다). 무기명은 탓할 이름이 없다.
            return Err(match slot_placeholder {
                Some(slot) => kind.at(slot.range.0),
                None => kind.no_range(),
            });
        }
    }
    Ok(())
}

/// 파일의 컴포넌트 정의들을 하나의 직렬화된 Module로. 컴포넌트 ID = 정의 순서.
/// 두 번째 반환값은 리소스 사이드맵 - 인덱스가 모듈 전역 resId, 값이 정규화 경로.
/// 빌드 단계가 이걸 받아 내용 해시/복사/URL화를 한다(BYTECODE.md #5 LOAD_RES 메모).
pub fn generate(comps: &[FlatComp]) -> Result<(Box<[u8]>, Vec<String>), CodegenError> {
    let comp_lookup = CompLookup::build(comps);
    let mut pool = ConstPool::new();
    let mut types = TypeTable::new();
    let mut code = Vec::new();
    let mut defs = Vec::new();
    // 정규화 경로 -> resId. 등장 순서로 0,1,2.... 같은 경로는 같은 resId(모듈 전역 dedup).
    let mut res_ids: Vec<String> = Vec::new();

    // 각 컴포넌트 코드를 이어붙이고 off/len으로 구획한다.
    for fc in comps {
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
        let props_type_ref = types.intern(&props_ty, &mut pool);
        let code_off = code.len() as u32;
        // 리소스 로드를 정의 앞머리에 깐다. lazy build에서 이 컴포넌트가 실제로 그려질 때만
        // 실행돼 리소스가 로드된다(같은 파일 컴포넌트가 같은 LOAD_RES를 내도 런타임이 URL dedup).
        for res_path in &fc.resources {
            let res_id = res_id_for(&mut res_ids, res_path);
            code.push(Op::LoadRes as u8);
            code.extend_from_slice(&res_id.to_le_bytes());
        }
        // 슬롯 인덱스는 컴포넌트-로컬 - def마다 0부터 다시 센다.
        let mut next_slot_placeholder_index = 0u16;
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
                &mut next_slot_placeholder_index,
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
            props_type_ref,
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

/// 타입이 store에서 차지하는 칸 수. 객체 안 필드 offset을 누적할 때 앞 형제 필드가 먹는 칸을
/// 세는 데 쓴다. 원시는 1(leaf), 배열은 1(칸 하나에 arrayPoolIndex로 앉고 요소는 arrayPool에
/// 산다), 객체는 필드 칸의 합(base부터 필드들이 연속으로 깔린다).
fn store_size(ty: &Type) -> u16 {
    match ty {
        Type::Bool | Type::Number | Type::String => 1,
        Type::Array(_) => 1,
        Type::Object(fields) => fields.iter().map(|(_, t)| store_size(t)).sum(),
        Type::Ref(n) => unreachable!("expand가 Type::Ref({n})를 안 풀었다"),
        Type::Omit(..) | Type::Pick(..) => unreachable!("expand가 유틸 타입을 안 풀었다"),
    }
}

/// prop 참조(root + 필드 경로)를 슬롯 위치로 짚는다 - scope_index(넘길 슬롯 번호) + offset
/// (root 안에서 도달 필드까지의 store 칸 거리) + 도달 타입. 객체를 펼치지 않으므로 scope_index는
/// props/for_var를 하나씩 센 순번이고(객체/배열도 슬롯 하나), offset은 root가 객체일 때 그 필드
/// 위치다. path가 비면 offset 0(THROUGH), 있으면 필드 거리(FIELD). u8 상한 가드는 emit이 건다.
///
///   {tag}        root=tag(for_var)   path=[]       -> (for_var 슬롯, 0)
///   {item.title} root=item(for_var)  path=[title]  -> (for_var 슬롯, title 거리)
///   {user.name}  root=user(prop)     path=[name]   -> (prop 순번, name 거리)
fn var_ref_to_slot<'a>(
    var: &VarRef,
    props: &'a [Prop],
    for_vars: &'a [ForVar],
) -> Result<(u8, u8, &'a Type), CodegenError> {
    // 이 함수의 에러는 모두 이 prop 참조를 탓한다 - 구간도 하나로 같다.
    let at = |kind: CodegenErrorKind| kind.at(var.range.0);
    let overflow = || at(CodegenErrorKind::SlotOverflow(var_ref_display(var)));

    // root를 회차변수에서 먼저 찾는다. props와 이름이 겹칠 수 없어(@for 진입에서 충돌을 에러로
    // 건다) 조회 순서는 무관. for_var는 자기 슬롯 번호를 이미 갖고 있고, prop은 선언 순번이 슬롯.
    let (scope_index, mut ty) = match for_vars
        .iter()
        .find(|fv| fv.name.as_deref() == Some(var.root.as_str()))
    {
        Some(fv) => (u8::try_from(fv.offset).map_err(|_| overflow())?, &fv.type_),
        None => {
            let mut ty = None;
            let mut scope_index = 0u8;
            for (i, p) in props.iter().enumerate() {
                if p.name == var.root {
                    ty = Some(&p.type_);
                    scope_index = u8::try_from(i).map_err(|_| overflow())?;
                    break;
                }
            }
            let unknown = || at(CodegenErrorKind::UnknownProp(var.root.clone()));
            (scope_index, ty.ok_or_else(unknown)?)
        }
    };

    // 필드 경로를 타입 따라 내려가며 offset을 누적한다. 앞 형제 필드가 먹는 store 칸을 더한다.
    // checked_add로 넘치는 그 필드에서 즉시 감지한다(사후 검사는 넘친 지점을 잃는다).
    let mut offset = 0u8;
    for key in &var.path {
        let fields = match ty {
            Type::Object(fields) => fields,
            _ => {
                return Err(at(CodegenErrorKind::UnknownField {
                    root: var.root.clone(),
                    field: key.clone(),
                }))
            }
        };
        let mut found = None;
        for (name, field_ty) in fields {
            if name == key {
                found = Some(field_ty);
                break;
            }
            let size = u8::try_from(store_size(field_ty)).map_err(|_| overflow())?;
            offset = offset.checked_add(size).ok_or_else(overflow)?;
        }
        ty = found.ok_or_else(|| {
            at(CodegenErrorKind::UnknownField {
                root: var.root.clone(),
                field: key.clone(),
            })
        })?;
    }

    Ok((scope_index, offset, ty))
}

/// prop 참조를 단일 leaf(원시)의 (scope_index, offset)으로. 값/반응성 자리(보간/속성/@if 조건)엔
/// leaf만 올 수 있다 - 객체/배열 통째는 안 넘긴다. `var_ref_to_slot` 위 leaf-only 래퍼.
fn var_ref_to_leaf_slot(
    var: &VarRef,
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<(u8, u8), CodegenError> {
    let (scope_index, offset, ty) = var_ref_to_slot(var, props, for_vars)?;
    match ty {
        Type::Bool | Type::Number | Type::String => Ok((scope_index, offset)),
        _ => Err(CodegenErrorKind::NotLeaf(var_ref_display(var)).at(var.range.0)),
    }
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
            Type::Ref(n) => unreachable!("expand가 Type::Ref({n})를 안 풀었다"),
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
    value: &ArgValue,
    props: &[Prop],
    pool: &mut ConstPool,
    types: &mut TypeTable,
) -> Result<Field, CodegenError> {
    let (type_ref, ref_value) = match value {
        ArgValue::Var(var) => {
            // events/contexts는 컴포넌트 최상위 선언이라 @for 몸체 밖 - 회차변수가 올 수 없다.
            let (scope_index, offset, ty) = var_ref_to_slot(var, props, &[])?;
            let type_ref = types.intern(ty, pool);
            (type_ref, FieldValue::Scope(scope_index, offset))
        }
        ArgValue::Literal(lit) => {
            // 리터럴은 항상 스칼라(객체 리터럴 없음). Scalar 엔트리 하나를 intern해 공유.
            let type_ref = types.intern(&lit_type(lit), pool);
            (type_ref, FieldValue::Const(pool.intern(lit_to_const(lit))))
        }
    };
    Ok(Field {
        name_const_index: pool.intern_str(field),
        type_ref,
        value: ref_value,
    })
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
    const ROOT: ForScope<'static> = ForScope {
        pending: &[],
        depth_base: 0,
        for_vars: &[],
    };
}

/// @for 회차변수 하나. name = 루프 변수명(`@for (tag of ..)`의 tag). 인덱스변수는 이름이 없을 수
/// 있어(`@for (row of rows)` - 인덱스 슬롯은 잡되 몸체 참조 불가) Option이다 - None이면 이름 조회에
/// 안 걸린다(슬롯만 점유). offset = 이 변수가 앉는 scope 슬롯(props leaf 뒤에 회차 진입 순서로 이어짐),
/// type_ = 요소 타입(배열 inner) 또는 Number(count 회차값/인덱스).
#[derive(Clone)]
struct ForVar {
    name: Option<String>,
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
    // 지금까지 방출한 `@slot` 수 = 다음 것의 slot_placeholder_index.
    // collect_slot_placeholders의 순회 순서와 같아야 정의쪽/사용쪽 인덱스가 맞는다.
    next_slot_placeholder_index: &mut u16,
) -> Result<(), CodegenError> {
    match node {
        Node::Text(s) => {
            let index = pool.intern_str(s);
            code.push(Op::Text as u8);
            code.extend_from_slice(&index.to_le_bytes());
        }
        Node::Var(var) => {
            let (scope_index, offset) = var_ref_to_leaf_slot(var, props, for_scope.for_vars)?;
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
                    .position(|e| &e.name == event_name)
                    .ok_or_else(|| CodegenErrorKind::UnknownEvent(event_name.clone()).no_range())?
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
                code.push(op as u8);
                code.extend_from_slice(&name_operand.to_le_bytes());
                match value {
                    // 정적 값은 상수풀 인덱스 u16.
                    AttrValue::Static(s) => {
                        code.extend_from_slice(&pool.intern_str(s).to_le_bytes());
                    }
                    // 변수 값은 (scope_index, offset) 두 u8 - TEXT_VAR와 같은 slot 인코딩.
                    AttrValue::Var(v) => {
                        let (scope_index, offset) =
                            var_ref_to_leaf_slot(v, props, for_scope.for_vars)?;
                        code.push(scope_index);
                        code.push(offset);
                    }
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

            // 자식 props 선언 순서대로 인자를 낸다. 변수 바인딩(`prop={x}`)은 부모 scope index을 싣는
            // PUSH_ARG, 리터럴(`prop="lit"`)은 상수풀 인덱스를 싣는 PUSH_ARG_LIT.
            // (지금은 전부 바인딩 가정 - 순서만으로 매핑.)
            for child_prop in child_props {
                let arg_value = args
                    .iter()
                    .find(|(p, _)| *p == child_prop.name)
                    .map(|(_, v)| v)
                    // 안 넘긴 인자라 가리킬 자리가 없다(빠진 것의 위치는 소스에 없다).
                    .ok_or_else(|| {
                        CodegenErrorKind::UnknownArg {
                            comp: name.name.clone(),
                            prop: child_prop.name.clone(),
                        }
                        .no_range()
                    })?;
                match arg_value {
                    ArgValue::Var(parent_var) => {
                        // 도달 타입이 자식 prop 타입과 구조가 같아야 한다.
                        let (scope_index, offset, reached_ty) =
                            var_ref_to_slot(parent_var, props, for_scope.for_vars)?;
                        if !types_match(reached_ty, &child_prop.type_) {
                            // 타입이 안 맞는 건 넘긴 그 참조다 - 그 자리를 가리킨다.
                            return Err(CodegenErrorKind::PropTypeMismatch {
                                comp: name.name.clone(),
                                prop: child_prop.name.clone(),
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
                    ArgValue::Literal(literal) => {
                        let value_index = pool.intern(lit_to_const(literal));
                        code.push(Op::PushArgLit as u8);
                        code.extend_from_slice(&value_index.to_le_bytes());
                    }
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
                        slot_placeholder: slot_name(content).map(str::to_string),
                    };
                    // 무기명은 탓할 이름이 없다 - 그때만 위치가 빈다.
                    return Err(match &content.name {
                        Some(slot) => kind.at(slot.range.0),
                        None => kind.no_range(),
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
            // cond는 불리언 prop 참조 - (scope_index, offset)으로. leaf여야 한다. (표현식은 이후 단계)
            let (scope_index, offset) = var_ref_to_leaf_slot(cond, props, for_scope.for_vars)?;
            code.push(Op::If as u8);
            code.push(scope_index);
            code.push(offset);

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
            let mut names: Vec<&String> = vec![item];
            if let Some(idx) = index {
                names.push(idx);
            }
            for name in &names {
                let dup = props.iter().any(|p| &&p.name == name)
                    || for_scope
                        .for_vars
                        .iter()
                        .any(|fv| fv.name.as_ref() == Some(*name));
                if dup || (index.as_ref() == Some(item) && names.len() == 2) {
                    return Err(CodegenErrorKind::DuplicateBinding((*name).clone()).no_range());
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
                    let (scope_index, offset, ty) =
                        var_ref_to_slot(var, props, for_scope.for_vars)?;
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
                name: Some(item.clone()),
                offset: base,
                type_: item_type,
            });
            nested_vars.push(ForVar {
                name: index.clone(),
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
                )?;
            }

            // ExitContext는 operand 없는 마커(IfEnd 동형).
            code.push(Op::ExitContext as u8);
        }
    }
    Ok(())
}
