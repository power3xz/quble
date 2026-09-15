//! 스코프 조회: prop 참조(root + 필드 경로)를 슬롯 위치와 타입으로 짚는다.
//!
//! codegen(방출)과 expr_type(타입 검사)이 둘 다 이걸 본다 - 이름을 찾고 경로를 내려가는 일은
//! 방출도 타입 계산도 아니라 그 아래 층이다. 여기가 둘 중 어느 쪽도 안 보게 두어야 의존이
//! 한 방향으로 흐른다.

use crate::ast::{Expr, Prop, Type};
use crate::src_range::SrcRange;

/// 스코프 조회가 낼 수 있는 실패. 셋 다 참조 하나를 탓한다.
#[derive(Debug, PartialEq, Eq)]
pub enum ScopeErrorKind {
    /// props에도 회차변수에도 없는 이름.
    UnknownProp(String),
    /// 경로가 존재하지 않는 필드를 가리킴(객체 아닌 값에 `.field`, 또는 없는 필드명).
    /// owner는 왼쪽 식의 표기 - `user.profile.x`면 `user.profile`.
    UnknownField { owner: String, field: String },
    /// scope_index/offset이 u8(255)를 넘었다(BYTECODE.md - 둘 다 u8 operand).
    SlotOverflow(String),
}

impl std::fmt::Display for ScopeErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ScopeErrorKind::UnknownProp(name) => {
                write!(f, "`{name}` is not declared in props")
            }
            ScopeErrorKind::UnknownField { owner, field } => {
                write!(f, "no field `{field}` on `{owner}`")
            }
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

/// 에러 메시지용 식 표기. 진단이 짚는 것은 이름이라 참조 체인 밖은 자리표시로 줄인다.
/// a.b -> "a.b"   a[i].b -> "a[..].b"   (count * 2).b -> "(..).b"
pub fn expr_display(expr: &Expr) -> String {
    match expr {
        Expr::Var(name, _) => name.clone(),
        Expr::Field(owner, field, _) => format!("{}.{field}", expr_display(owner)),
        Expr::Index(arr, _, _) => format!("{}[..]", expr_display(arr)),
        _ => "(..)".to_string(),
    }
}

/// 이름 하나를 슬롯 번호와 타입으로. 객체를 펼치지 않아 슬롯 번호는 props/for_var를 하나씩
/// 센 순번이다 - 객체/배열도 슬롯 하나를 쓴다.
/// props { a: number, b: string }에서 b -> (1, String)
pub fn lookup_name<'a>(
    name: &str,
    at: SrcRange,
    props: &'a [Prop],
    for_vars: &'a [ForVar],
) -> Result<(u8, &'a Type), ScopeError> {
    let overflow = || ScopeErrorKind::SlotOverflow(name.to_string()).at(at);

    // 회차변수에서 먼저 찾는다. props와 이름이 겹칠 수 없어(@for 진입에서 충돌을 에러로 건다)
    // 조회 순서는 무관. for_var는 자기 슬롯 번호를 이미 갖고 있고, prop은 선언 순번이 슬롯.
    match for_vars
        .iter()
        .find(|fv| fv.name.as_deref() == Some(name))
    {
        Some(fv) => Ok((u8::try_from(fv.offset).map_err(|_| overflow())?, &fv.type_)),
        None => {
            for (i, p) in props.iter().enumerate() {
                if p.name == name {
                    let scope_index = u8::try_from(i).map_err(|_| overflow())?;
                    return Ok((scope_index, &p.type_));
                }
            }
            Err(ScopeErrorKind::UnknownProp(name.to_string()).at(at))
        }
    }
}

/// 객체에서 필드 하나를 찾아 타입과 그 앞 형제들이 먹는 store 칸 거리를 낸다.
/// { a: number, b: string }에서 b -> (String, 1)
///
/// 에러는 `field`까지 포함한 자리(`whole`)를 짚는다 - owner만 짚으면 없는 그 필드가 안 보인다.
pub fn lookup_field<'a>(
    owner_ty: &'a Type,
    field: &str,
    owner: &Expr,
    whole: &Expr,
) -> Result<(&'a Type, u8), ScopeError> {
    let at = |kind: ScopeErrorKind| kind.at(whole.range().0);
    let unknown = || {
        at(ScopeErrorKind::UnknownField {
            owner: expr_display(owner),
            field: field.to_string(),
        })
    };
    let overflow = || at(ScopeErrorKind::SlotOverflow(expr_display(owner)));

    let fields = match owner_ty {
        Type::Object(fields) => fields,
        _ => return Err(unknown()),
    };
    // offset이 u8(255)를 넘으면 그 필드에서 바로 잡는다 - 다 더한 뒤 검사하면 어느 필드에서
    // 넘었는지 알 수 없다.
    let mut offset = 0u8;
    for (name, field_ty) in fields {
        if name == field {
            return Ok((field_ty, offset));
        }
        let size = u8::try_from(store_size(field_ty)).map_err(|_| overflow())?;
        offset = offset.checked_add(size).ok_or_else(overflow)?;
    }
    Err(unknown())
}

/// 참조 체인(이름 + 필드들)이면 (슬롯 번호, 슬롯 base부터의 store 칸 거리, 도달 타입).
/// 인덱싱은 인덱스를 세어야, 연산자는 읽는 칸이 여럿이라 칸이 컴파일타임에 안 정해져 None이다.
/// count -> Some((슬롯, 0))   user.name -> Some((슬롯, name 거리))
/// a[i].x -> None   count * 2 -> None
pub fn fixed_ref_of<'a>(
    expr: &Expr,
    props: &'a [Prop],
    for_vars: &'a [ForVar],
) -> Result<Option<(u8, u8, &'a Type)>, ScopeError> {
    match expr {
        Expr::Var(name, range) => {
            let (scope_index, ty) = lookup_name(name, range.0, props, for_vars)?;
            Ok(Some((scope_index, 0, ty)))
        }
        Expr::Field(owner, field, _) => {
            let found = fixed_ref_of(owner, props, for_vars)?;
            match found {
                // 없는 필드는 여기서 안 탓한다 - `.length`가 그 경로로 오고(길이는 칸이 따로다),
                // 진짜 오타는 expr_type이 먼저 돌아 UnknownField로 잡는다.
                Some((scope_index, base, owner_ty)) => match lookup_field(
                    owner_ty, field, owner, expr,
                ) {
                    Ok((ty, rel)) => {
                        let overflow =
                            || ScopeErrorKind::SlotOverflow(expr_display(expr)).at(expr.range().0);
                        let offset = base.checked_add(rel).ok_or_else(overflow)?;
                        Ok(Some((scope_index, offset, ty)))
                    }
                    Err(_) => Ok(None),
                },
                None => Ok(None),
            }
        }
        _ => Ok(None),
    }
}
