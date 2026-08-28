//! AST. 한 파일에 여러 컴포넌트 정의, 합성(컴포넌트 호출), props 변수 보간(텍스트/속성).

use crate::src_range::NodeRange;

/// 한 소스 파일(.qubc 하나)의 파싱 결과: 최상위 use 문들 + 컴포넌트 정의들.
#[derive(Debug, PartialEq)]
pub struct SourceFile {
    pub uses: Vec<Use>,
    /// `use './x.css'` - 이 파일이 참조하는 외부 리소스 경로(등장 순서). 이 파일의 모든
    /// 컴포넌트가 공유한다(lazy build에서 컴포넌트가 그려질 때 로드). 못 찾으면 그 경로
    /// 자리를 탓하므로 위치를 함께 든다.
    pub resources: Vec<Ident>,
    pub comps: Vec<Component>,
}

/// 이름 하나와 그 이름이 소스에 적힌 자리. codegen이 "그런 태그/컴포넌트/컨텍스트 없다"를
/// 낼 때 탓할 대상이다. VarRef가 참조 자리를 range로 들고 다니는 것과 같은 축 - 이름을 담는
/// 필드가 자기 위치를 함께 든다.
///
/// 모든 이름 필드가 이걸 쓰는 건 아니다. codegen이 그 이름으로 무언가를 찾고 못 찾으면
/// 에러를 내는 자리에만 붙인다(못 찾은 이름이 곧 탓할 대상이다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ident {
    pub name: String,
    /// 비교에서 빠진다(NodeRange) - 다른 줄의 같은 이름은 같은 이름이다.
    pub range: NodeRange,
}

/// `use A, B from "path"` - path 소스에서 이름 A/B를 현재 스코프로 가져온다.
///
/// 세 자리가 각각 다른 에러를 탓한다.
///
/// ```text
/// use Card, Tag from "./card.qubc"
///     ^^^^                            MissingExport - 그 파일에 없는 이름
///                     ^^^^^^^^^^^^^   NotFound - 못 찾은 경로
/// ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^    Cycle - 이 use 자체가 순환을 만듦
/// ```
#[derive(Debug, PartialEq, Eq)]
pub struct Use {
    pub names: Vec<Ident>,
    pub path: Ident,
    /// `use`부터 경로 끝까지.
    pub range: NodeRange,
}

#[derive(Debug, PartialEq)]
pub struct Component {
    pub name: String,
    pub props: Vec<Prop>,       // 선언 순서 = scope 인덱스
    pub events: Vec<Event>,     // 선언 순서 = event_index (BIND_EVENT가 참조)
    pub contexts: Vec<Context>, // 선언 순서 = context_index (EnterContext가 참조)
    pub template: Vec<Node>,    // 루트 노드들 (fragment 허용)
}

/// `props { name: type }` 한 항목. 타입은 필수(표기 강제). 선언 순서가 scope 인덱스.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Prop {
    pub name: String,
    pub type_: Type,
}

/// prop 타입. quble이 온전히 소유하는 재귀 구조 - 원시 3종을 잎으로 배열/객체를 조합한다.
/// d.ts가 TS 타입으로 매핑한다(bool->boolean, T[]->T[], 객체->{...}).
///
/// Ref/Omit/Pick은 "다른 곳의 타입을 참조/가공"하는 표기라, expand 단계가 이를 그
/// 실제 필드 목록(Object)으로 바꿔치기한다. 예: `Section`의 props가 `{ title, on }`이면
/// `Omit<Section, 'title'>` -> `Object([("on", ...)])`. 그래서 codegen에는 Object만 오고
/// Ref/Omit/Pick은 남지 않는다.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Type {
    Bool,
    Number,
    String,
    Array(Box<Type>),
    Object(Vec<(String, Type)>), // 필드 선언 순서 보존(d.ts 방출 안정성)
    /// `general: Section` - 다른 컴포넌트(대문자명)의 props를 타입으로 참조. expand가
    /// 평탄화 후 그 컴포넌트 props를 Object로 환원해 치환한다(codegen엔 Ref가 안 남는다).
    /// 이름이 자기 자리를 든다 - 그런 컴포넌트가 없거나(UnknownType) 순환하면(TypeCycle)
    /// 여기를 탓한다.
    Ref(Ident),
    /// `Omit<Section, 'title'>` - 안쪽 타입(Object로 환원됨)의 필드에서 나열한 키를 뺀다.
    /// expand가 안쪽을 먼저 풀고 필터해 Object로 치환한다. 유틸 타입은 Ref처럼 codegen 전에 사라진다.
    ///
    /// ```text
    /// Omit<Section, 'title'>
    ///               ^^^^^^^   UnknownKey - 안쪽에 없는 키
    /// ^^^^^^^^^^^^^^^^^^^^^   NonObjectUtil - 안쪽이 객체가 아니라 표기가 성립 안 함
    /// ```
    Omit(Box<Type>, Vec<Ident>, NodeRange),
    /// `Pick<Section, 'title'>` - 안쪽 타입 필드에서 나열한 키만 고른다(Omit의 반대).
    Pick(Box<Type>, Vec<Ident>, NodeRange),
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
        tag: Ident,
        attrs: Vec<(String, AttrValue)>,
        /// `@click:TOGGLE` - (DOM이벤트, 이벤트명). 이 요소가 무엇에 반응해 무슨 이벤트를 쏘나.
        /// DOM 이벤트는 렉서가 닫힌 집합으로 걸러 틀릴 수 없어 위치가 없고, 이벤트명은
        /// events 선언에 없을 수 있어 탓할 자리를 든다.
        event_bindings: Vec<(String, Ident)>,
        children: Vec<Node>,
    },
    Text(String),
    /// `{name}`/`{assignee.name}` 보간 - prop 참조. codegen이 scope 인덱스로 해석.
    Var(VarRef),
    /// 대문자로 시작하는 컴포넌트 호출(합성). `Comp(prop={parent_var})` 또는 `Comp(prop="lit")`.
    /// args = (자식 prop명, 바인딩 값). codegen이 자식 props 순서로 PUSH_ARG/PUSH_ARG_CONST를 낸다.
    /// prop명이 자기 자리를 든다 - 자식에 없는 이름을 넘기면(UnknownArg) 그 이름을 탓한다.
    /// alias = use-site 별칭(`Alias: Comp(...)`). 있으면 이게 fullname path 세그먼트가 되고,
    /// 없으면 type-name을 그대로 쓴다(#1.3 - alias 없는 동일 type-name은 의도적 공유).
    Component {
        alias: Option<String>,
        name: Ident,
        args: Vec<(Ident, ArgValue)>,
        /// 자식 블록으로 넘긴 슬롯 콘텐츠. 빈 벡터면 self-close(`Comp( /)`) - 슬롯 안 채움.
        /// 무기명은 `SlotPlaceholderContent { name: None }` 하나, 기명은 이름별로 여럿.
        /// 채우는 순서는 무관 - codegen이 자식 선언 순서로 정규화한다.
        contents: Vec<SlotPlaceholderContent>,
    },
    /// `@slot()` / `@slot(header)` - 자식 콘텐츠가 들어갈 자리(정의쪽). name이 None이면 무기명.
    /// 한 컴포넌트는 무기명 하나 또는 기명 여럿 중 하나만 - 섞으면 컴파일 에러(SYNTAX #3.3).
    /// 선언 순서가 slot_placeholder_index(컴포넌트-로컬)이고, 사용쪽 SlotPlaceholderContent가 같은 공간을 쓴다.
    SlotPlaceholderDef {
        name: Option<Ident>,
        /// `@slot(...)` 전체. 같은 자리를 두 번 선언했을 때 탓하는 곳으로, 무기명이라
        /// 이름이 없어도 짚을 수 있게 노드가 자기 자리를 든다.
        range: NodeRange,
    },
    /// `@if (cond) { then } @else { else_ }` - 조건 분기. else_가 비어 있으면 else 없는 if.
    If {
        cond: Expr,
        then: Vec<Node>,
        else_: Vec<Node>,
    },
    /// `@for (item[, index] of count) { body }` - count 회 반복 렌더. count는 정수 리터럴 또는 숫자
    /// prop 참조(ForCount). item은 요소(배열) 또는 회차값(count). index는 선택적 회차 인덱스변수 이름
    /// (`@for (row, i of rows)`의 i) - 몸체 `{i}`/이벤트 `$n`이 읽는다. 없으면 None(인덱스 슬롯은 잡되
    /// 몸체에서 이름 참조 불가). item과 index는 별개 슬롯이라 count-for든 array-for든 둘 다 쓸 수 있다.
    For {
        item: Ident,
        index: Option<Ident>,
        count: ForCount,
        body: Vec<Node>,
    },
    /// `@with Context { children }` - 자식들을 그 컨텍스트 범위로 감싼다. context는 이 컴포넌트
    /// contexts에 선언된 이름(codegen이 context_index로 해석). codegen이 EnterContext/ExitContext로 감싼다.
    With {
        context: Ident,
        children: Vec<Node>,
    },
}

/// 합성처에서 슬롯에 넣는 콘텐츠 한 덩이. `Header << 노드`(기명) 또는 합성 블록 전체(무기명).
/// nodes는 쓰는 쪽 컨텍스트로 해석된다 - 보간/이벤트 경로가 정의한 컴포넌트가 아니라
/// 쓰는 쪽 기준(SYNTAX #3.3).
#[derive(Debug, PartialEq)]
pub struct SlotPlaceholderContent {
    /// 기명이면 슬롯 이름, 무기명이면 None(무기명은 탓할 이름이 없어 합성 호출 자리로 떨어진다).
    pub name: Option<Ident>,
    pub nodes: Vec<Node>,
}

/// `@for`의 반복 횟수 출처. codegen이 이걸로 ForRaw(리터럴) / ForScopeIndex(prop) opcode를 가른다.
/// - Literal: 소스에 직접 박은 정수(`of 3`). 슬롯 안 거치고 opcode에 값 인라인.
/// - Var: 숫자 prop 참조(`of count`). 슬롯 offset을 거쳐 런타임이 값을 읽는다(STORE/CONST 위임).
#[derive(Debug, PartialEq, Eq)]
pub enum ForCount {
    Literal(u16),
    Var(VarRef),
}

/// 속성값: 정적 문자열(`class="card"`) 또는 변수 참조(`class={x}`).
/// 변수는 텍스트 보간(`Node::Var`)과 같은 scope index 공간을 쓴다.
#[derive(Debug, PartialEq, Eq)]
pub enum AttrValue {
    Static(String),
    Var(VarRef),
}

/// prop 참조 - 어느 prop(root)의 어느 경로(path)인가. 텍스트 보간/속성값/합성 인자/
/// payload/context 값이 공유한다. 스칼라는 path 빈 벡터(`title` -> root="title", path=[]),
/// 객체 접근은 필드들(`assignee.name` -> root="assignee", path=["name"]). root/path 분리:
/// 나중에 AST에서 객체 단위 처리(root 통째)가 필요할 수 있어 root를 분리해 둔다.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct VarRef {
    pub root: String,
    pub path: Vec<String>,
    /// 이 참조가 쓰인 자리(`root`부터 경로 끝까지). codegen이 prop/필드를 못 찾았을 때
    /// 탓할 대상이다. 비교에서 빠진다(NodeRange).
    pub range: NodeRange,
}

impl VarRef {
    /// `x.length`에서 길이를 잴 대상 `x`. 마지막 조각이 `length`가 아니면 None.
    /// 필드 조회가 먼저 실패했을 때만 길이로 읽으므로 부르는 쪽이 그 순서를 지킨다.
    ///
    /// range는 원래 참조 그대로다 - 조각 하나를 뗀 자리는 소스에서 셀 수 없다
    /// (`x . length`도 파싱된다). 진단은 참조 전체를 짚고 무엇이 문제인지는 메시지가 말한다.
    pub fn length_target(&self) -> Option<VarRef> {
        match self.path.last().map(String::as_str) {
            Some("length") => {
                let mut target = self.clone();
                target.path.pop();
                Some(target)
            }
            _ => None,
        }
    }
}

/// 값 자리에 오는 식. 잎(참조/리터럴)과 연산자 가지로 이룬다.
/// 잎 하나짜리 식(`@if (done)`)은 codegen이 기존 슬롯 인코딩으로 그대로 낮춘다 - 흔한 경우가
/// 표현식 테이블과 평가기를 안 거치게 하려는 것.
///
/// 노드마다 자기가 소스에서 걸친 자리를 든다 - 타입이 안 맞는 지점을 짚으려면 안쪽 노드가
/// 자기 자리를 알아야 한다. 식 통째를 탓하면 어디가 틀렸는지 안 보인다.
///
/// ```text
/// @if (count > 0 && name)
///                   ^^^^    bool이 아닌 잎만 짚는다
/// ```
///
#[derive(Debug, PartialEq)]
pub enum Expr {
    /// `count`, `user.name`, `tags.length` - 참조 하나. `.length`가 길이인지 같은 이름의
    /// 필드인지는 타입이 갈라서 expr_type이 정한다(파서는 타입을 모른다).
    Var(VarRef, NodeRange),
    Lit(LitValue, NodeRange),
    /// range는 연산자부터 피연산자 끝까지(`!done`).
    Unary(UnaryOp, Box<Expr>, NodeRange),
    /// range는 왼쪽 피연산자 시작부터 오른쪽 끝까지(`a + b`).
    Binary(BinaryOp, Box<Expr>, Box<Expr>, NodeRange),
}

impl Expr {
    /// 이 식이 소스에서 걸친 자리. 진단이 탓할 대상이다.
    pub fn range(&self) -> NodeRange {
        match self {
            Expr::Var(_, r) | Expr::Lit(_, r) | Expr::Unary(_, _, r) | Expr::Binary(_, _, _, r) => {
                *r
            }
        }
    }
}

/// 단항 연산자. `!done`, `-count`.
#[derive(Debug, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
}

impl UnaryOp {
    /// 소스에 적히는 기호. 진단이 연산자를 탓할 때 이 글자로 찍는다.
    pub fn sym(&self) -> &'static str {
        match self {
            UnaryOp::Not => "!",
            UnaryOp::Neg => "-",
        }
    }
}

/// 이항 연산자. 우선순위와 결합은 파서가 정하고, AST는 묶인 결과만 담는다.
#[derive(Debug, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

impl BinaryOp {
    /// 소스에 적히는 기호. 진단이 연산자를 탓할 때 이 글자로 찍는다.
    pub fn sym(&self) -> &'static str {
        match self {
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Rem => "%",
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::Le => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Ge => ">=",
            BinaryOp::And => "&&",
            BinaryOp::Or => "||",
        }
    }
}

/// 합성 호출의 인자 값: 부모 변수(`prop={x}`) 또는 use-site 리터럴(`prop="lit"`, `prop=42`, `prop=true`).
/// 변수는 부모 store 슬롯을 자식과 공유한다(자식 수정이 부모에 반영). 리터럴은 부모와 무관한
/// 독립 값으로, 런타임이 자식 인스턴스에 고유 leaf로 심는다(원본과 분리, 자식이 독립 수정).
#[derive(Debug, PartialEq, Clone)]
pub enum ArgValue {
    Var(VarRef),
    Literal(LitValue),
}

/// 소스에 적힌 리터럴 하나 - 값과 그 값이 놓인 자리. 자리를 드는 건 타입이 안 맞을 때
/// 그 리터럴을 짚기 위해서다(`Row(count="abc")`의 `"abc"`).
#[derive(Debug, PartialEq, Clone)]
pub struct LitValue {
    pub value: Lit,
    /// 비교에서 빠진다(NodeRange) - 다른 줄의 같은 리터럴은 같은 값이다.
    pub range: NodeRange,
}

/// 리터럴 값. quble이 타입을 소유하므로 리터럴도 종류를 갖는다 - 상수풀에 타입대로 실려
/// 런타임이 올바른 JS 값(string/number/boolean)으로 복원한다. Number 원문은 f64로 파싱해 담는다.
#[derive(Debug, PartialEq, Clone)]
pub enum Lit {
    Str(String),
    Number(f64),
    Bool(bool),
}
