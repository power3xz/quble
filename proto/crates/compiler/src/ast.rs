//! AST. 한 파일에 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간(텍스트·속성).

/// 한 소스 파일(.qubc 하나)의 파싱 결과: 최상위 use 문들 + 컴포넌트 정의들.
#[derive(Debug, PartialEq)]
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

#[derive(Debug, PartialEq)]
pub struct Component {
    pub name: String,
    pub props: Vec<Prop>,        // 선언 순서 = scope 인덱스
    pub events: Vec<Event>,      // 선언 순서 = event_index (BIND_EVENT가 참조)
    pub contexts: Vec<Context>,  // 선언 순서 = context_index (EnterContext가 참조)
    pub template: Vec<Node>,     // 루트 노드들 (fragment 허용)
}

/// `props { name: type }` 한 항목. 타입은 필수(표기 강제). 선언 순서가 scope 인덱스.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Prop {
    pub name: String,
    pub ty: Type,
}

/// prop 타입. quble이 온전히 소유하는 재귀 구조 - 원시 3종을 잎으로 배열·객체를 조합한다.
/// d.ts가 TS 타입으로 매핑한다(bool->boolean, T[]->T[], 객체->{...}). 명명 타입은 아직 없다.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Type {
    Bool,
    Number,
    String,
    Array(Box<Type>),
    Object(Vec<(String, Type)>),  // 필드 선언 순서 보존(d.ts 방출 안정성)
    /// `general: Section` - 다른 컴포넌트(대문자명)의 props를 타입으로 참조. resolve가
    /// 평탄화 후 그 컴포넌트 props를 Object로 환원해 치환한다(codegen엔 Ref가 안 남는다).
    Ref(String),
    /// `Omit<Section, 'title'>` - 안쪽 타입(Object로 환원됨)의 필드에서 나열한 키를 뺀다.
    /// resolve가 안쪽을 먼저 풀고 필터해 Object로 치환한다. 유틸 타입은 Ref처럼 codegen 전에 사라진다.
    Omit(Box<Type>, Vec<String>),
    /// `Pick<Section, 'title'>` - 안쪽 타입 필드에서 나열한 키만 고른다(Omit의 반대).
    Pick(Box<Type>, Vec<String>),
}

/// `contexts { Area { key: 값 } }` - 컴포넌트가 선언한 컨텍스트.
/// fields 각 항목은 (필드명, 값). 값은 prop 참조(Var) 또는 리터럴(Literal) - 합성 인자와
/// 같은 두 갈래라 ArgValue를 공유한다. 표현식 값은 아직 미지원.
#[derive(Debug, PartialEq)]
pub struct Context {
    pub name: String,
    pub fields: Vec<(String, ArgValue)>,
}

/// `events { TOGGLE({ label: title, on }) }` - 컴포넌트가 선언한 이벤트.
/// payload 각 항목은 (이벤트필드명, 값). 값은 prop 참조(Var) 또는 리터럴(Literal).
/// `{ title }` 단축은 ("title", Var("title"))로 푼다. Var의 prop명은 props에 있어야 한다(codegen이 검증).
#[derive(Debug, PartialEq)]
pub struct Event {
    pub name: String,
    pub payload: Vec<(String, ArgValue)>,
}

#[derive(Debug, PartialEq)]
pub enum Node {
    Element {
        tag: String,
        attrs: Vec<(String, AttrValue)>,
        /// `@click:TOGGLE` - (DOM이벤트, 이벤트명). 이 요소가 무엇에 반응해 무슨 이벤트를 쏘나.
        event_bindings: Vec<(String, String)>,
        children: Vec<Node>,
    },
    Text(String),
    /// `{name}`·`{assignee.name}` 보간 - prop 참조. codegen이 scope 인덱스로 해석.
    Var(VarRef),
    /// 대문자로 시작하는 컴포넌트 호출(합성). `Comp(prop={parent_var})` 또는 `Comp(prop="lit")`.
    /// args = (자식 prop명, 바인딩 값). codegen이 자식 props 순서로 PUSH_ARG/PUSH_ARG_CONST를 낸다.
    /// alias = use-site 별칭(`Alias: Comp(...)`). 있으면 이게 fullname path 세그먼트가 되고,
    /// 없으면 type-name을 그대로 쓴다(§1.3 - alias 없는 동일 type-name은 의도적 공유).
    Component {
        alias: Option<String>,
        name: String,
        args: Vec<(String, ArgValue)>,
    },
    /// `@if (cond) { then } @else { else_ }` - 조건 분기. cond는 불리언 prop 참조(경로 허용,
    /// `gen.open`)이고 leaf여야 한다(표현식은 이후 단계). else_가 비어 있으면 else 없는 if.
    If {
        cond: VarRef,
        then: Vec<Node>,
        else_: Vec<Node>,
    },
    /// `@with Context { children }` - 자식들을 그 컨텍스트 범위로 감싼다. context는 이 컴포넌트
    /// contexts에 선언된 이름(codegen이 context_index로 해석). codegen이 EnterContext/ExitContext로 감싼다.
    With {
        context: String,
        children: Vec<Node>,
    },
}

/// 속성값: 정적 문자열(`class="card"`) 또는 변수 참조(`class={x}`).
/// 변수는 텍스트 보간(`Node::Var`)과 같은 scope index 공간을 쓴다.
#[derive(Debug, PartialEq, Eq)]
pub enum AttrValue {
    Static(String),
    Var(VarRef),
}

/// prop 참조 - 어느 prop(root)의 어느 경로(path)인가. 텍스트 보간·속성값·합성 인자·
/// payload/context 값이 공유한다. 스칼라는 path 빈 벡터(`title` -> root="title", path=[]),
/// 객체 접근은 필드들(`assignee.name` -> root="assignee", path=["name"]). root/path 분리:
/// 나중에 AST에서 객체 단위 처리(root 통째)가 필요할 수 있어 root를 분리해 둔다.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct VarRef {
    pub root: String,
    pub path: Vec<String>,
}

/// 합성 호출의 인자 값: 부모 변수(`prop={x}`) 또는 use-site 리터럴(`prop="lit"`, `prop=42`, `prop=true`).
/// 변수는 부모 store 슬롯을 자식과 공유한다(자식 수정이 부모에 반영). 리터럴은 부모와 무관한
/// 독립 값으로, 런타임이 자식 인스턴스에 고유 leaf로 심는다(원본과 분리, 자식이 독립 수정).
#[derive(Debug, PartialEq, Clone)]
pub enum ArgValue {
    Var(VarRef),
    Literal(LitValue),
}

/// 리터럴 값. quble이 타입을 소유하므로 리터럴도 종류를 갖는다 - 상수풀에 타입대로 실려
/// 런타임이 올바른 JS 값(string/number/boolean)으로 복원한다. Number 원문은 f64로 파싱해 담는다.
#[derive(Debug, PartialEq, Clone)]
pub enum LitValue {
    Str(String),
    Number(f64),
    Bool(bool),
}
