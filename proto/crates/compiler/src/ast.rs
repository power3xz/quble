//! AST. 한 파일에 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간(텍스트·속성).

/// 한 소스(.qubc 한 파일)의 파싱 결과: 최상위 use 문들 + 컴포넌트 정의들.
#[derive(Debug, PartialEq, Eq)]
pub struct Source {
    pub uses: Vec<Use>,
    pub comps: Vec<Component>,
}

/// `use A, B from "path"` — path 소스에서 이름 A·B를 현재 스코프로 가져온다.
#[derive(Debug, PartialEq, Eq)]
pub struct Use {
    pub names: Vec<String>,
    pub path: String,
}

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
    /// 대문자로 시작하는 컴포넌트 호출(합성). `Comp(prop={parent_var})`.
    /// args = (자식 prop명, 부모 변수명). codegen이 자식 props 순서로 PUSH_ARG를 낸다.
    Component {
        name: String,
        args: Vec<(String, String)>,
    },
}

/// 속성값: 정적 문자열(`class="card"`) 또는 변수 참조(`class={x}`).
/// 변수는 텍스트 보간(`Node::Var`)과 같은 scope offset 공간을 쓴다.
#[derive(Debug, PartialEq, Eq)]
pub enum AttrValue {
    Static(String),
    Var(String),
}
