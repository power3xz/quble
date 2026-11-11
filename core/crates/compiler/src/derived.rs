//! `derived` 블록을 사용처에 펼친다. 이름 해석(codegen) 전에 도는 단계라 이후 단계는 derived를
//! 모르고, 사용처에 정의식을 손으로 쓴 것과 같은 AST를 본다(SYNTAX #2.2).
//!
//! 펼치는 대상은 template 식, `contexts` 값, `events` 페이로드 값이다. derived 본문 안의 다른
//! derived도 펼친다 - 결과는 props만 읽는 식이다.

use crate::ast::{Derived, Expr, Node};
use crate::flatten::{FlatComp, FlattenError, Sourced};
use crate::src_range::SrcRange;

/// derived에서 난 에러와 탓할 자리.
#[derive(Debug, PartialEq, Eq)]
pub struct DerivedError {
    pub kind: DerivedErrorKind,
    pub range: SrcRange,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DerivedErrorKind {
    /// derived 이름이 앞서 선언한 derived와 같음. 뒤의 이름을 탓한다.
    DuplicateName(String),
    /// derived 이름이 prop과 같음. derived 이름을 탓한다.
    NameTakenByProp(String),
    /// derived가 자기 자신으로 돌아오는 고리를 이룸. 고리를 닫는 참조를 탓한다.
    Cycle(String),
    /// `@for` 회차변수가 같은 이름의 derived를 shadowing하는데 몸체가 그 이름을 읽음. 그 회차변수
    /// 이름을 탓한다.
    ForBindingShadows(String),
}

impl std::fmt::Display for DerivedErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            DerivedErrorKind::DuplicateName(name) => {
                write!(f, "derived `{name}` is declared more than once")
            }
            DerivedErrorKind::NameTakenByProp(name) => {
                write!(f, "derived `{name}` has the same name as a prop")
            }
            DerivedErrorKind::Cycle(name) => {
                write!(f, "derived `{name}` reads itself through a cycle")
            }
            DerivedErrorKind::ForBindingShadows(name) => {
                write!(
                    f,
                    "@for binding `{name}` shadows a derived of the same name: use another name"
                )
            }
        }
    }
}

/// 평탄화된 컴포넌트마다 derived를 사용처에 펼친다. `comp.derived`에는 props만 읽는 식으로
/// 펼친 본문이 남는다(codegen이 읽는 곳이 없어도 타입을 검사한다).
pub(crate) fn expand_derived(comps: &mut [FlatComp]) -> Result<(), FlattenError> {
    for flat in comps.iter_mut() {
        expand_component(flat)
            .map_err(|e| FlattenError::Derived(Sourced::from_origin(&flat.origin, e)))?;
    }
    Ok(())
}

fn expand_component(flat: &mut FlatComp) -> Result<(), DerivedError> {
    let comp = &mut flat.comp;
    let declared = std::mem::take(&mut comp.derived);
    if declared.is_empty() {
        return Ok(());
    }
    check_names(&declared, comp.props.iter().map(|p| p.name.as_str()))?;

    let mut expander = Expander {
        names: declared.iter().map(|d| d.name.name.clone()).collect(),
        bodies: declared.iter().map(|d| d.expr.clone()).collect(),
        state: vec![State::Todo; declared.len()],
        bound: Vec::new(),
    };

    // 아무도 읽지 않는 derived도 순환은 에러라서 선언된 것을 모두 펼쳐 본다.
    for (i, item) in declared.iter().enumerate() {
        expander.resolve(i, item.name.range.0)?;
    }

    for context in &mut comp.contexts {
        for (_, value) in &mut context.fields {
            expander.substitute(value)?;
        }
    }
    for event in &mut comp.events {
        for (_, value) in &mut event.payload {
            expander.substitute(value)?;
        }
    }
    expander.nodes(&mut comp.template)?;

    // 펼친 본문을 남긴다 - 아무도 읽지 않는 derived도 codegen이 본문 타입을 검사해야 한다.
    comp.derived = declared
        .into_iter()
        .zip(expander.bodies)
        .map(|(item, expr)| Derived {
            name: item.name,
            expr,
        })
        .collect();
    Ok(())
}

/// 이름이 derived끼리, 그리고 props와 겹치지 않는지 본다.
fn check_names<'a>(
    declared: &[Derived],
    props: impl Iterator<Item = &'a str>,
) -> Result<(), DerivedError> {
    let props: Vec<&str> = props.collect();
    for (i, item) in declared.iter().enumerate() {
        let name = item.name.name.as_str();
        let kind = if props.contains(&name) {
            DerivedErrorKind::NameTakenByProp(name.to_string())
        } else if declared[..i].iter().any(|d| d.name.name == name) {
            DerivedErrorKind::DuplicateName(name.to_string())
        } else {
            continue;
        };
        return Err(DerivedError {
            kind,
            range: item.name.range.0,
        });
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    /// 아직 본문을 펼치지 않음.
    Todo,
    /// 본문을 펼치는 중 - 이때 다시 만나면 순환이다.
    InProgress,
    /// 본문이 props만 읽는 식으로 펼쳐짐.
    Done,
}

struct Expander {
    names: Vec<String>,
    bodies: Vec<Expr>,
    state: Vec<State>,
    /// 지금 읽고 있는 `@for` 몸체들이 묶은 회차변수 (이름, 이름이 적힌 자리).
    bound: Vec<(String, SrcRange)>,
}

impl Expander {
    fn nodes(&mut self, nodes: &mut [Node]) -> Result<(), DerivedError> {
        for node in nodes {
            match node {
                Node::Element {
                    attrs, children, ..
                } => {
                    for (_, value) in attrs {
                        self.substitute(value)?;
                    }
                    self.nodes(children)?;
                }
                Node::Interpolation(expr) => self.substitute(expr)?,
                Node::Component { args, contents, .. } => {
                    for (_, value) in args {
                        self.substitute(value)?;
                    }
                    for content in contents {
                        self.nodes(&mut content.nodes)?;
                    }
                }
                Node::If { cond, then, else_ } => {
                    self.substitute(cond)?;
                    self.nodes(then)?;
                    self.nodes(else_)?;
                }
                Node::For {
                    item,
                    index,
                    count,
                    body,
                } => {
                    if let crate::ast::ForCount::Var(expr) = count {
                        self.substitute(expr)?;
                    }
                    let before = self.bound.len();
                    self.bound.push((item.name.clone(), item.range.0));
                    if let Some(index) = index {
                        self.bound.push((index.name.clone(), index.range.0));
                    }
                    let result = self.nodes(body);
                    self.bound.truncate(before);
                    result?;
                }
                Node::With { children, .. } => self.nodes(children)?,
                Node::Text(_) | Node::SlotPlaceholderDef { .. } => {}
            }
        }
        Ok(())
    }

    /// 식 안의 derived 이름을 펼친 본문으로 바꾼다.
    fn substitute(&mut self, expr: &mut Expr) -> Result<(), DerivedError> {
        match expr {
            Expr::Var(name, range) => {
                let Some(i) = self.names.iter().position(|n| n == name) else {
                    return Ok(());
                };
                if let Some((_, binding)) = self.bound.iter().find(|(n, _)| n == name) {
                    return Err(DerivedError {
                        kind: DerivedErrorKind::ForBindingShadows(name.clone()),
                        range: *binding,
                    });
                }
                self.resolve(i, range.0)?;
                *expr = self.bodies[i].clone();
                Ok(())
            }
            Expr::Lit(..) => Ok(()),
            Expr::List(items, _) => {
                for item in items {
                    self.substitute(item)?;
                }
                Ok(())
            }
            Expr::Field(inner, ..) | Expr::Unary(_, inner, _) => self.substitute(inner),
            Expr::Index(left, right, _) | Expr::Binary(_, left, right, _) => {
                self.substitute(left)?;
                self.substitute(right)
            }
            Expr::Ternary(cond, then, else_, _) => {
                self.substitute(cond)?;
                self.substitute(then)?;
                self.substitute(else_)
            }
        }
    }

    /// i번째 derived의 본문을 props만 읽는 식으로 펼친다. at은 이 derived를 읽은 자리다.
    fn resolve(&mut self, i: usize, at: SrcRange) -> Result<(), DerivedError> {
        match self.state[i] {
            State::Done => return Ok(()),
            State::InProgress => {
                return Err(DerivedError {
                    kind: DerivedErrorKind::Cycle(self.names[i].clone()),
                    range: at,
                });
            }
            State::Todo => {}
        }
        self.state[i] = State::InProgress;
        // 본문은 선언 자리에서 읽으므로 지금 읽는 `@for` 몸체의 회차변수와 무관하다.
        let outer_bound = std::mem::take(&mut self.bound);
        let mut body = self.bodies[i].clone();
        let result = self.substitute(&mut body);
        self.bound = outer_bound;
        result?;
        self.bodies[i] = body;
        self.state[i] = State::Done;
        Ok(())
    }
}
