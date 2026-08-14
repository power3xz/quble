//! 스코프 조회: prop 참조(root + 필드 경로)를 슬롯 위치와 타입으로 짚는다.
//!
//! codegen(방출)과 expr_type(타입 검사)이 둘 다 이걸 본다 - 이름을 찾고 경로를 내려가는 일은
//! 방출도 타입 계산도 아니라 그 아래 층이다. 여기가 둘 중 어느 쪽도 안 보게 두어야 의존이
//! 한 방향으로 흐른다.

use crate::ast::{Prop, Type, VarRef};
use crate::src_range::SrcRange;

/// 스코프 조회가 낼 수 있는 실패. 넷 다 참조 하나를 탓한다.
#[derive(Debug, PartialEq, Eq)]
pub enum ScopeErrorKind {
    /// props에도 회차변수에도 없는 이름.
    UnknownProp(String),
    /// 경로가 존재하지 않는 필드를 가리킴(객체 아닌 값에 `.field`, 또는 없는 필드명).
    UnknownField { root: String, field: String },
    /// 값 자리에 leaf(원시)가 아닌 객체/배열 경로가 왔다.
    NotLeaf(String),
    /// scope_index/offset이 u8(255)를 넘었다(BYTECODE.md - 둘 다 u8 operand).
    SlotOverflow(String),
}

impl std::fmt::Display for ScopeErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ScopeErrorKind::UnknownProp(name) => {
                write!(f, "`{name}` is not declared in props")
            }
            ScopeErrorKind::UnknownField { root, field } => {
                write!(f, "no field `{field}` on prop `{root}`")
            }
            ScopeErrorKind::NotLeaf(path) => write!(
                f,
                "`{path}` is an object or array: only primitive values go in value position"
            ),
            ScopeErrorKind::SlotOverflow(name) => {
                write!(f, "more than 255 slots: `{name}` does not fit")
            }
        }
    }
}

/// 조회 실패 - 무엇이(kind) 어디서(range) 틀렸나.
#[derive(Debug, PartialEq, Eq)]
pub struct ScopeError {
    pub kind: ScopeErrorKind,
    pub range: SrcRange,
}

impl ScopeErrorKind {
    fn at(self, range: SrcRange) -> ScopeError {
        ScopeError { kind: self, range }
    }
}

/// @for 회차변수 하나. name = 루프 변수명(`@for (tag of ..)`의 tag). 인덱스변수는 이름이 없을 수
/// 있어(`@for (row of rows)` - 인덱스 슬롯은 잡되 몸체 참조 불가) Option이다 - None이면 이름 조회에
/// 안 걸린다(슬롯만 점유). offset = 이 변수가 앉는 scope 슬롯(props leaf 뒤에 회차 진입 순서로 이어짐),
/// type_ = 요소 타입(배열 inner) 또는 Number(count 회차값/인덱스).
#[derive(Clone)]
pub struct ForVar {
    pub name: Option<String>,
    pub offset: u16,
    pub type_: Type,
}

/// 타입이 store에서 차지하는 칸 수. 객체 안 필드 offset을 누적할 때 앞 형제 필드가 먹는 칸을
/// 세는 데 쓴다. 원시는 1(leaf), 배열은 1(칸 하나에 arrayPoolIndex로 앉고 요소는 arrayPool에
/// 산다), 객체는 필드 칸의 합(base부터 필드들이 연속으로 깔린다).
pub fn store_size(ty: &Type) -> u16 {
    match ty {
        Type::Bool | Type::Number | Type::String => 1,
        Type::Array(_) => 1,
        Type::Object(fields) => fields.iter().map(|(_, t)| store_size(t)).sum(),
        Type::Ref(n) => unreachable!("expand가 Type::Ref({})를 안 풀었다", n.name),
        Type::Omit(..) | Type::Pick(..) => unreachable!("expand가 유틸 타입을 안 풀었다"),
    }
}

/// 에러 메시지용 경로 표기: `root.a.b`.
pub fn var_ref_display(var: &VarRef) -> String {
    if var.path.is_empty() {
        var.root.clone()
    } else {
        format!("{}.{}", var.root, var.path.join("."))
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
pub fn lookup_var_ref<'a>(
    var: &VarRef,
    props: &'a [Prop],
    for_vars: &'a [ForVar],
) -> Result<(u8, u8, &'a Type), ScopeError> {
    // 이 함수의 에러는 모두 이 prop 참조를 탓한다 - 구간도 하나로 같다.
    let at = |kind: ScopeErrorKind| kind.at(var.range.0);
    let overflow = || at(ScopeErrorKind::SlotOverflow(var_ref_display(var)));

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
            let unknown = || at(ScopeErrorKind::UnknownProp(var.root.clone()));
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
                return Err(at(ScopeErrorKind::UnknownField {
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
            at(ScopeErrorKind::UnknownField {
                root: var.root.clone(),
                field: key.clone(),
            })
        })?;
    }

    Ok((scope_index, offset, ty))
}

/// prop 참조를 단일 leaf(원시)의 (scope_index, offset)으로. 값/반응성 자리(보간/속성/@if 조건)엔
/// leaf만 올 수 있다 - 객체/배열 통째는 안 넘긴다. `lookup_var_ref` 위 leaf-only 래퍼.
pub fn require_leaf_var_ref(
    var: &VarRef,
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<(u8, u8), ScopeError> {
    let (scope_index, offset, ty) = lookup_var_ref(var, props, for_vars)?;
    match ty {
        Type::Bool | Type::Number | Type::String => Ok((scope_index, offset)),
        _ => Err(ScopeErrorKind::NotLeaf(var_ref_display(var)).at(var.range.0)),
    }
}
