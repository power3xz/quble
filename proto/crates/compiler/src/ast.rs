//! MVP AST. 단일 컴포넌트, 문자열 속성, 표현식 없음.

#[derive(Debug, PartialEq, Eq)]
pub struct Component {
    pub name: String,
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
}
