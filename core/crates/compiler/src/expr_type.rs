//! 표현식 타입 검사: 식 트리를 타고 결과 타입을 낸다.
//!
//! scope(조회) 위, codegen(방출) 아래다. codegen은 방출 전에 여기로 조건을 검사한다 -
//! 방출은 타입이 맞다고 보고 짠다.

use crate::ast::{BinaryOp, Expr, Lit, Prop, Type, UnaryOp, VarRef};
use crate::scope::{var_ref_display, var_ref_type, ForVar, ScopeError, ScopeErrorKind};
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
    /// 식의 결과가 그 자리가 요구하는 타입과 다름(`@if (count)`).
    ResultType { want: Box<Type>, got: Box<Type> },
    /// `.length` 대상이 배열도 문자열도 아님.
    NoLength(String),
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
                write!(f, "expected {}, found {}", type_name(want), type_name(got))
            }
            ExprTypeErrorKind::NoLength(path) => write!(f, "`{path}` has no length"),
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

/// 식의 결과 타입이 want인지까지 본다. 아니면 식 전체를 탓한다 - 결과가 어긋난 것이지
/// 어느 조각 하나가 어긋난 게 아니다.
pub fn require_expr_type(
    expr: &Expr,
    want: &Type,
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<(), ExprTypeError> {
    let got = expr_type(expr, props, for_vars)?;
    match got == *want {
        true => Ok(()),
        false => Err(ExprTypeErrorKind::ResultType {
            want: Box::new(want.clone()),
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

        // 파서는 `x.length`도 그냥 참조로 낸다 - 필드인지 길이인지는 타입을 봐야 갈리고,
        // 타입은 여기서만 안다. 실제 필드가 우선이고 없을 때만 길이로 읽는다.
        Expr::Var(var, _) => match var_ref_type(var, props, for_vars) {
            Ok(ty) => leaf_type(ty, var),
            // 조회에 실패했을 때만 길이로 읽어 본다. `length`가 실제 필드면 위에서 이미 잡혔다.
            Err(not_found) => match var.length_target() {
                Some(target) => length_type(&target, props, for_vars),
                None => Err(not_found.into()),
            },
        },

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

/// `x.length`에서 길이를 잴 대상 `x`의 타입을 보고 결과를 낸다. 길이를 갖는 건 배열과 문자열뿐.
fn length_type(
    target: &VarRef,
    props: &[Prop],
    for_vars: &[ForVar],
) -> Result<Type, ExprTypeError> {
    match var_ref_type(target, props, for_vars)? {
        Type::Array(_) | Type::String => Ok(Type::Number),
        _ => Err(ExprTypeErrorKind::NoLength(var_ref_display(target)).at(target.range.0)),
    }
}

/// 값 자리엔 leaf만 온다 - 객체/배열 통째는 연산자에 넣을 것이 없다.
fn leaf_type(ty: &Type, var: &VarRef) -> Result<Type, ExprTypeError> {
    match ty {
        Type::Bool | Type::Number | Type::String => Ok(ty.clone()),
        _ => Err(
            ExprTypeErrorKind::Scope(ScopeErrorKind::NotLeaf(var_ref_display(var))).at(var.range.0),
        ),
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
