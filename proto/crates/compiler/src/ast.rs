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
        attrs: Vec<(String, String)>, // (name, value) — value는 문자열만
        children: Vec<Node>,
    },
    Text(String),
    /// `{name}` 보간 — props 이름 참조. codegen이 scope 인덱스로 해석.
    Var(String),
}
