//! MVP AST. 단일 컴포넌트, 문자열 속성. 1단계: props 문자열 변수 보간.

#[derive(Debug, PartialEq, Eq)]
pub struct Component {
    pub name: String,
    pub props: Vec<String>,  // 선언 순서 = scope 인덱스
    pub template: Vec<Node>, // 루트 노드들 (fragment 허용)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Node {
    Element {
        tag: String,
        attrs: Vec<(String, AttrValue)>,
        children: Vec<Node>,
    },
    Text(String),
    /// `{name}` 보간 — props 이름 참조. codegen이 scope 인덱스로 해석.
    Var(String),
}

/// 속성값: 정적 문자열(`class="card"`) 또는 변수 참조(`class={x}`).
/// 변수는 텍스트 보간(`Node::Var`)과 같은 scope offset 공간을 쓴다.
#[derive(Debug, PartialEq, Eq)]
pub enum AttrValue {
    Static(String),
    Var(String),
}
