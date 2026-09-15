//! 표현식 타입 검사: 식 트리를 타고 결과 타입을 낸다.
//!
//! scope(조회) 위, codegen(방출) 아래다. codegen은 방출 전에 여기로 조건을 검사한다 -
//! 방출은 타입이 맞다고 보고 짠다.

use crate::ast::{BinaryOp, Expr, Lit, Prop, Type, UnaryOp};
use crate::scope::{expr_display, lookup_field, lookup_name, ForVar, ScopeError, ScopeErrorKind};
use crate::src_range::SrcRange;

/// 타입 검사가 낼 수 있는 실패.
#[derive(Debug, PartialEq, Eq)]
pub enum ExprTypeErrorKind {
    /// 연산자가 타입을 못 박는데 피연산자가 어긋남(`-`는 number, `&&`는 bool).
    /// 어긋난 그 피연산자를 탓한다. Type은 Object(Vec)를 품어 Box로 든다.
    OperandType {
        op: &'static str,
        want: Box<Type>,
        got: Box<Type>,
    },
    /// `==`/`!=` 양쪽 타입이 다름. 연산자가 타입을 안 정하고 둘이 같기만 하면 되므로
    /// 어느 한쪽을 탓할 수 없어 식 전체를 짚는다.
    OperandMismatch {
        op: &'static str,
        left: Box<Type>,
        right: Box<Type>,
    },
    /// 식의 결과가 그 자리가 받는 타입에 없음(`@if (count)`). 자리에 따라 받는 것이 하나이거나
    /// (`@if`는 bool) 여럿이다(값 자리는 bool/number/string).
    ResultType { want: Box<[Type]>, got: Box<Type> },
    /// 값 자리에 원시가 아닌 객체/배열 경로가 왔다. 통째로는 텍스트로도 속성으로도 못 나간다.
    NotLeaf(String),
    /// `.length` 대상이 배열도 문자열도 아님.
    NoLength(String),
    /// `a[i]`의 `a`가 배열이 아님.
    NotIndexable { target: String, got: Box<Type> },
    /// 배열이 식으로 평가되는 자리에 왔다. 지금 배열을 받는 건 class 속성뿐이다.
    ListNotAllowed,
    /// 아래층(scope) 조회 실패 - 여기서 더 할 말이 없어 그대로 통과시킨다.
    Scope(ScopeErrorKind),
}

impl std::fmt::Display for ExprTypeErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            ExprTypeErrorKind::OperandType { op, want, got } => write!(
                f,
                "`{op}` expects {}, found {}",
                type_name(want),
                type_name(got)
            ),
            ExprTypeErrorKind::OperandMismatch { op, left, right } => write!(
                f,
                "`{op}` needs both sides to be the same type, found {} and {}",
                type_name(left),
                type_name(right)
            ),
            ExprTypeErrorKind::ResultType { want, got } => {
                // 여럿이면 `/`로 잇는다. bool/number/string
                let want = want.iter().map(type_name).collect::<Vec<_>>().join("/");
                write!(f, "expected {want}, found {}", type_name(got))
            }
            ExprTypeErrorKind::NotLeaf(path) => write!(
                f,
                "`{path}` is an object or array: only primitive values go in value position"
            ),
            ExprTypeErrorKind::NoLength(path) => write!(f, "`{path}` has no length"),
            ExprTypeErrorKind::NotIndexable { target, got } => {
                write!(f, "`{target}` is {}, not an array", type_name(got))
            }
            ExprTypeErrorKind::ListNotAllowed => write!(f, "only `class` takes an array"),
            ExprTypeErrorKind::Scope(e) => e.fmt(f),
        }
    }
}

/// 검사 실패 - 무엇이(kind) 어디서(range) 틀렸나.
#[derive(Debug, PartialEq, Eq)]
pub struct ExprTypeError {
    pub kind: ExprTypeErrorKind,
    pub range: SrcRange,
}

impl ExprTypeErrorKind {
    fn at(self, range: SrcRange) -> ExprTypeError {
        ExprTypeError { kind: self, range }
    }
}

/// 조회 실패는 자리도 갈래도 그대로 싣는다 - `?`가 이걸 자동으로 부른다.
impl From<ScopeError> for ExprTypeError {
    fn from(e: ScopeError) -> Self {
        ExprTypeErrorKind::Scope(e.kind).at(e.range)
    }
}

/// 진단에 찍는 타입 이름. 한 뎁스까지 풀고 그 안은 뭉뚱그린다 - 어긋난 타입이 뭔지만 알면
/// 되고, 깊은 객체를 통째로 찍으면 메시지가 길어진다.
pub(crate) fn type_name(ty: &Type) -> String {
    match ty {
        Type::Bool | Type::Number | Type::String | Type::Array(_) | Type::Object(_) => {}
        Type::Ref(n) => unreachable!("expand가 Type::Ref({})를 안 풀었다", n.name),
        Type::Omit(..) | Type::Pick(..) => unreachable!("expand가 유틸 타입을 안 풀었다"),
    }
    match ty {
        // 원소가 원시면 `string[]`, 더 깊으면 `object[]`/`array[]`.
        Type::Array(inner) => format!("{}[]", shallow_name(inner)),
        // 필드 이름만 - 필드 타입까지 펼치면 중첩이 끝없다.
        Type::Object(fields) => {
            let names: Vec<&str> = fields.iter().map(|(n, _)| n.as_str()).collect();
            format!("{{ {} }}", names.join(", "))
        }
        _ => shallow_name(ty).to_string(),
    }
}

/// 한 뎁스 안쪽 - 원시는 이름 그대로, 그 외는 종류만.
fn shallow_name(ty: &Type) -> &'static str {
    match ty {
        Type::Bool => "bool",
        Type::Number => "number",
        Type::String => "string",
        Type::Array(_) => "array",
        Type::Object(_) => "object",
        Type::Ref(n) => unreachable!("expand가 Type::Ref({})를 안 풀었다", n.name),
        Type::Omit(..) | Type::Pick(..) => unreachable!("expand가 유틸 타입을 안 풀었다"),
    }
}

/// 식의 결과 타입이 want 중 하나인지까지 본다. 아니면 식 전체를 탓한다 - 결과가 어긋난 것이지
/// 어느 조각 하나가 어긋난 게 아니다.
///
/// want가 여럿인 것은 자리마다 받는 것이 달라서다 - `@if`는 bool 하나, 값 자리(보간/속성)는
/// 원시 셋(bool/number/string)을 받는다.
pub fn require_expr_type(
    expr: &Expr,
    want: &[Type],
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<(), ExprTypeError> {
    let got = expr_type(expr, props, for_vars)?;
    match want.contains(&got) {
        true => Ok(()),
        false => Err(ExprTypeErrorKind::ResultType {
            want: want.into(),
            got: Box::new(got),
        }
        .at(expr.range().0)),
    }
}

/// 식의 결과 타입.
pub fn expr_type(expr: &Expr, props: &[Prop], for_vars: &[ForVar]) -> Result<Type, ExprTypeError> {
    match expr {
        Expr::Lit(lit, _) => Ok(match &lit.value {
            Lit::Str(_) => Type::String,
            Lit::Number(_) => Type::Number,
            Lit::Bool(_) => Type::Bool,
        }),

        // 값 자리엔 원시만 온다 - 객체/배열 통째는 연산자에 넣을 것이 없다.
        Expr::Var(..) | Expr::Field(..) | Expr::Index(..) => {
            let ty = path_type(expr, props, for_vars)?;
            match ty {
                Type::Bool | Type::Number | Type::String => Ok(ty),
                _ => Err(ExprTypeErrorKind::NotLeaf(expr_display(expr)).at(expr.range().0)),
            }
        }

        // 배열이 오는 자리는 class 속성뿐이고 codegen이 거기서 낮춘다 - 식 평가를 안 거친다.
        Expr::List(_, range) => Err(ExprTypeErrorKind::ListNotAllowed.at(range.0)),

        Expr::Unary(op, operand, _) => {
            let want = match op {
                UnaryOp::Not => Type::Bool,
                UnaryOp::Neg => Type::Number,
            };
            require_operand(operand, &want, op.sym(), props, for_vars)?;
            Ok(want)
        }

        Expr::Binary(op, left, right, range) => match op {
            // 산술: 양쪽 number, 결과 number.
            BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Rem => {
                require_operand(left, &Type::Number, op.sym(), props, for_vars)?;
                require_operand(right, &Type::Number, op.sym(), props, for_vars)?;
                Ok(Type::Number)
            }
            // 대소 비교: 양쪽 number, 결과 bool.
            BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                require_operand(left, &Type::Number, op.sym(), props, for_vars)?;
                require_operand(right, &Type::Number, op.sym(), props, for_vars)?;
                Ok(Type::Bool)
            }
            // 논리: 양쪽 bool, 결과 bool.
            BinaryOp::And | BinaryOp::Or => {
                require_operand(left, &Type::Bool, op.sym(), props, for_vars)?;
                require_operand(right, &Type::Bool, op.sym(), props, for_vars)?;
                Ok(Type::Bool)
            }
            // 같음 비교: 타입을 안 박고 양쪽이 같기만 하면 된다.
            BinaryOp::Eq | BinaryOp::Ne => {
                let l = expr_type(left, props, for_vars)?;
                let r = expr_type(right, props, for_vars)?;
                match l == r {
                    true => Ok(Type::Bool),
                    false => Err(ExprTypeErrorKind::OperandMismatch {
                        op: op.sym(),
                        left: Box::new(l),
                        right: Box::new(r),
                    }
                    .at(range.0)),
                }
            }
        },
    }
}

/// 참조/필드/인덱싱 체인이 도달한 타입. 슬롯으로 접히는지와 무관하다 - fixed_ref_of가 None을
/// 내는 `a[i]`도 요소 타입은 안다.
/// props { rows: { cells: string[] }[] }에서 rows[i].cells[j] -> String
fn path_type(expr: &Expr, props: &[Prop], for_vars: &[ForVar]) -> Result<Type, ExprTypeError> {
    match expr {
        Expr::Var(name, range) => {
            let (_, ty) = lookup_name(name, range.0, props, for_vars)?;
            Ok(ty.clone())
        }

        // 실제 필드가 먼저다. 없을 때만 길이로 읽어 본다 - `length`라는 필드를 선언했으면
        // 그 필드가 잡힌다(SYNTAX #5.2).
        Expr::Field(owner, field, range) => {
            let owner_ty = path_type(owner, props, for_vars)?;
            match lookup_field(&owner_ty, field, owner, expr) {
                Ok((ty, _)) => Ok(ty.clone()),
                Err(not_found) => match (field.as_str(), &owner_ty) {
                    ("length", Type::Array(_) | Type::String) => Ok(Type::Number),
                    ("length", _) => {
                        Err(ExprTypeErrorKind::NoLength(expr_display(owner)).at(range.0))
                    }
                    _ => Err(not_found.into()),
                },
            }
        }

        Expr::Index(arr, index, range) => {
            require_operand(index, &Type::Number, "[]", props, for_vars)?;
            match path_type(arr, props, for_vars)? {
                Type::Array(elem) => Ok(*elem),
                got => Err(ExprTypeErrorKind::NotIndexable {
                    target: expr_display(arr),
                    got: Box::new(got),
                }
                .at(range.0)),
            }
        }

        _ => expr_type(expr, props, for_vars),
    }
}

/// 연산자가 타입을 못 박는 자리 - 어긋나면 그 피연산자를 탓한다.
fn require_operand(
    operand: &Expr,
    want: &Type,
    op: &'static str,
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<(), ExprTypeError> {
    let got = expr_type(operand, props, for_vars)?;
    match got == *want {
        true => Ok(()),
        false => Err(ExprTypeErrorKind::OperandType {
            op,
            want: Box::new(want.clone()),
            got: Box::new(got),
        }
        .at(operand.range().0)),
    }
}
