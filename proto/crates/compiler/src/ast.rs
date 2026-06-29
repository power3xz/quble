//! AST. 한 파일에 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간(텍스트·속성).

/// 한 소스 파일(.qubc 하나)의 파싱 결과: 최상위 use 문들 + 컴포넌트 정의들.
#[derive(Debug, PartialEq, Eq)]
pub struct SourceFile {
    pub uses: Vec<Use>,
    /// `use './x.css'` - 이 파일이 참조하는 외부 리소스 경로(등장 순서). 이 파일의 모든
    /// 컴포넌트가 공유한다(lazy build에서 컴포넌트가 그려질 때 로드).
    pub resources: Vec<String>,
    pub comps: Vec<Component>,
}

/// `use A, B from "path"` - path 소스에서 이름 A·B를 현재 스코프로 가져온다.
#[derive(Debug, PartialEq, Eq)]
pub struct Use {
    pub names: Vec<String>,
    pub path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Component {
    pub name: String,
    pub props: Vec<String>,  // 선언 순서 = scope 인덱스
    pub events: Vec<Event>,  // 선언 순서 = event_idx (BIND_EVENT가 참조)
    pub template: Vec<Node>, // 루트 노드들 (fragment 허용)
}

/// `events { TOGGLE({ label: title, on }) }` - 컴포넌트가 선언한 이벤트.
/// payload 각 항목은 (이벤트필드명, prop명). `{ title }` 단축은 ("title","title")로 푼다.
/// prop명은 props에 있어야 한다(codegen이 검증).
#[derive(Debug, PartialEq, Eq)]
pub struct Event {
    pub name: String,
    pub payload: Vec<(String, String)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Node {
    Element {
        tag: String,
        attrs: Vec<(String, AttrValue)>,
        /// `@click:TOGGLE` - (DOM이벤트, 이벤트명). 이 요소가 무엇에 반응해 무슨 이벤트를 쏘나.
        event_bindings: Vec<(String, String)>,
        children: Vec<Node>,
    },
    Text(String),
    /// `{name}` 보간 - props 이름 참조. codegen이 scope 인덱스로 해석.
    Var(String),
    /// 대문자로 시작하는 컴포넌트 호출(합성). `Comp(prop={parent_var})` 또는 `Comp(prop="lit")`.
    /// args = (자식 prop명, 바인딩 값). codegen이 자식 props 순서로 PUSH_ARG/PUSH_ARG_CONST를 낸다.
    /// alias = use-site 별칭(`Alias: Comp(...)`). 있으면 이게 fullname path 세그먼트가 되고,
    /// 없으면 type-name을 그대로 쓴다(§1.3 - alias 없는 동일 type-name은 의도적 공유).
    Component {
        alias: Option<String>,
        name: String,
        args: Vec<(String, ArgValue)>,
    },
    /// `@if (cond) { then } @else { else_ }` - 조건 분기. cond는 불리언 prop명 하나
    /// (표현식은 이후 단계). else_가 비어 있으면 else 없는 if.
    If {
        cond: String,
        then: Vec<Node>,
        else_: Vec<Node>,
    },
}

/// 속성값: 정적 문자열(`class="card"`) 또는 변수 참조(`class={x}`).
/// 변수는 텍스트 보간(`Node::Var`)과 같은 scope offset 공간을 쓴다.
#[derive(Debug, PartialEq, Eq)]
pub enum AttrValue {
    Static(String),
    Var(String),
}

/// 합성 호출의 인자 값: 부모 변수(`prop={x}`) 또는 use-site 리터럴(`prop="lit"`).
/// 변수는 부모 store 슬롯을 자식과 공유한다(자식 수정이 부모에 반영). 리터럴은 부모와 무관한
/// 독립 값으로, 런타임이 자식 인스턴스에 고유 leaf로 심는다(원본과 분리, 자식이 독립 수정).
#[derive(Debug, PartialEq, Eq)]
pub enum ArgValue {
    Var(String),
    Literal(String),
}
