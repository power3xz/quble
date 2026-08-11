//! use 그래프를 따라가 여러 소스의 컴포넌트를 하나의 평탄한 Vec<Component>로 모은다(A안).
//! 모듈 포맷은 안 건드린다 - codegen이 평탄화된 정의들을 단일 패스로 처리한다.
//!
//! 경로 의미론은 컴파일러가 모른다. loader가 (base, target)을 정규화된 경로로 풀어 소스와 함께
//! 돌려준다. 컴파일러는 그 정규화된 경로의 동일성만으로 다이아몬드(중복 skip)와 순환(에러)을 본다.
//! esbuild/rollup의 resolve(importer, specifier) -> 정규화 경로 패턴의 최소 버전이다.

use crate::ast::{Component, Ident, Prop, Type};
use crate::lexer;
use crate::parse;
use crate::src_range::SrcRange;

/// 평탄화된 컴포넌트 + 그 컴포넌트가 속한 파일의 리소스 경로(`use './x.css'`).
/// 같은 파일에서 나온 컴포넌트는 같은 resources를 복제해 가진다(파일 단위 선언이라
/// 어느 컴포넌트가 쓰는지 특정 불가 - 전부 후보). codegen이 정의 앞에 LOAD_RES를 낸다.
pub struct FlatComp {
    pub comp: Component,
    pub resources: Vec<String>,
    /// 이 컴포넌트가 정의된 파일. 이 컴포넌트를 codegen하다 난 에러의 range는 이 파일의
    /// 바이트 오프셋이라, 진단이 엔트리가 아니라 여기를 가리켜야 한다.
    pub origin: Origin,
}

/// 컴포넌트가 정의된 파일. 한 파일에 컴포넌트가 여럿일 수 있어 소스를 Rc로 공유한다
/// (파일 하나가 컴포넌트 수만큼 복제되지 않게).
#[derive(Clone)]
pub struct Origin {
    pub path: std::rc::Rc<str>,
    pub src: std::rc::Rc<str>,
}

/// use 경로 해소기. base(use를 적은 소스의 정규화 경로)와 target(`./Foo.qubc`)을 받아
/// 대상의 (정규화 경로, 소스 문자열)을 돌려준다. 못 찾으면 None.
pub trait SourceLoader {
    fn load(&self, base_canonical_path: &str, target_path: &str) -> Option<(String, String)>;
}

impl<F: Fn(&str, &str) -> Option<(String, String)>> SourceLoader for F {
    fn load(&self, base_canonical_path: &str, target_path: &str) -> Option<(String, String)> {
        self(base_canonical_path, target_path)
    }
}

/// 에러와 그 에러가 난 소스를 함께 묶은 것. lex/parse 에러의 SrcRange는 파일 안 좌표라
/// 어느 파일 것인지를 range만 보고는 모른다 - 그 파일을 에러에 실어 보내 관계를 타입으로 못박는다.
/// 소비처(CLI/wasm)가 loader를 다시 붙들지 않아도 라인/컬럼과 스니펫을 낼 수 있다.
///
/// path/src는 파일 단위라 SrcRange(노드 단위)에 넣지 않는다 - 같은 파일 range 100개가
/// 같은 답을 100번 들 이유가 없다.
#[derive(Debug, PartialEq, Eq)]
pub struct Sourced<E> {
    /// 에러가 난 파일의 정규화 경로.
    pub path: String,
    /// 그 파일의 소스 전문. err의 range가 이 문자열의 바이트 오프셋이다.
    pub src: String,
    pub err: E,
}

impl<E> Sourced<E> {
    fn new(path: &str, src: &str, err: E) -> Self {
        Sourced {
            path: path.to_string(),
            src: src.to_string(),
            err,
        }
    }

    /// 평탄화가 기억해 둔 출처로 감싼다 - codegen 에러의 range가 어느 파일의 오프셋인지
    /// 이걸로 정해진다.
    pub fn from_origin(origin: &Origin, err: E) -> Self {
        Sourced {
            path: origin.path.to_string(),
            src: origin.src.to_string(),
            err,
        }
    }
}

/// use 줄에서 난 에러와 그 줄 안의 탓할 자리. range는 kind마다 다른 자리를 가리킨다 -
/// 못 찾은 경로, 없는 이름, use 줄 전체(ast.rs `Use` 그림).
#[derive(Debug, PartialEq, Eq)]
pub struct UseError {
    pub kind: UseErrorKind,
    pub range: SrcRange,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UseErrorKind {
    /// use가 가리키는 경로를 loader가 찾지 못함(컴포넌트 import와 리소스 둘 다).
    NotFound { base: String, target: String },
    /// use 한 이름이 대상 소스에 정의돼 있지 않음.
    MissingExport { path: String, name: String },
    /// 끌어온 이름이 이미 다른 파일에서 온 같은 이름과 부딪힘.
    DuplicateComponent(String),
    /// use 그래프에 순환이 있음.
    Cycle(String),
}

impl std::fmt::Display for UseErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            UseErrorKind::NotFound { base, target } => {
                write!(f, "cannot resolve `{target}` from `{base}`")
            }
            UseErrorKind::MissingExport { path, name } => {
                write!(f, "`{path}` does not define `{name}`")
            }
            UseErrorKind::DuplicateComponent(name) => {
                write!(f, "component `{name}` is defined in more than one file")
            }
            UseErrorKind::Cycle(path) => write!(f, "cycle in the use graph at `{path}`"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum FlattenError {
    Lex(Sourced<lexer::LexError>),
    Parse(Sourced<parse::ParseError>),
    /// use 줄 안에 탓할 자리가 있는 에러. 자리는 kind마다 다르다(UseErrorKind).
    Use(Sourced<UseError>),
    /// 같은 이름의 컴포넌트가 서로 다른 소스에 정의됨.
    DuplicateComponent(String),
    /// prop 타입 표기 안에 탓할 자리가 있는 에러. 자리는 kind마다 다르다(TypeErrorKind).
    Type(Sourced<TypeError>),
}

/// prop 타입 표기에서 난 에러와 그 안의 탓할 자리(ast.rs `Type` 그림).
#[derive(Debug, PartialEq, Eq)]
pub struct TypeError {
    pub kind: TypeErrorKind,
    pub range: SrcRange,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TypeErrorKind {
    /// prop 타입 참조(`x: Foo`)의 Foo가 평탄화된 컴포넌트에 없음. 그 이름을 탓한다.
    UnknownType(String),
    /// 타입 참조가 순환한다(A의 prop 타입이 B, B가 A). 고리를 닫은 참조를 탓한다.
    TypeCycle(String),
    /// Omit/Pick의 안쪽이 객체(로 환원되는 타입)가 아님. 표기 전체를 탓한다.
    NonObjectUtil,
    /// Omit/Pick이 나열한 키가 안쪽 타입에 없음. 그 키를 탓한다.
    UnknownKey(String),
}

impl std::fmt::Display for TypeErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            TypeErrorKind::UnknownType(name) => {
                write!(
                    f,
                    "cannot find component `{name}` referenced by a prop type"
                )
            }
            TypeErrorKind::TypeCycle(name) => {
                write!(f, "cycle in prop type references at `{name}`")
            }
            TypeErrorKind::NonObjectUtil => {
                write!(f, "Omit/Pick requires an object type")
            }
            TypeErrorKind::UnknownKey(key) => {
                write!(
                    f,
                    "key `{key}` listed in Omit/Pick is not in the target type"
                )
            }
        }
    }
}

impl std::fmt::Display for FlattenError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            // 이 둘은 소스 안 위치를 갖는다 - 위치와 밑줄까지 붙이는 건 diagnostic이 하고,
            // 여기서는 안쪽 메시지만 낸다.
            FlattenError::Lex(e) => write!(f, "{}", e.err.kind),
            FlattenError::Parse(e) => write!(f, "{}", e.err.kind),
            FlattenError::Use(e) => write!(f, "{}", e.err.kind),
            FlattenError::Type(e) => write!(f, "{}", e.err.kind),
            FlattenError::DuplicateComponent(name) => {
                write!(f, "component `{name}` is defined in more than one file")
            }
        }
    }
}

/// 엔트리 소스를 파싱하고 use 그래프를 따라가 컴포넌트를 평탄화한다.
/// 엔트리는 모든 컴포넌트를 가져가고(ID 0부터), use 대상 파일은 나열된 이름만 가져온다.
/// 안 쓰는 컴포넌트는 병합에서 제외된다 - 쓰려면 codegen이 CompLookup에서 막는다.
pub fn flatten(
    entry_path: &str,
    entry_src: &str,
    loader: &impl SourceLoader,
) -> Result<Vec<FlatComp>, FlattenError> {
    let mut ctx = Ctx {
        acc: Vec::new(),
        origin: Vec::new(),
        recursed: Vec::new(),
        visiting: Vec::new(),
    };
    // 엔트리는 want=None - 자기 파일 컴포넌트 전부.
    collect(entry_path, entry_src, None, loader, &mut ctx)?;
    expand_type_refs(&mut ctx.acc)?;
    Ok(ctx.acc)
}

/// prop 타입 안의 `Type::Ref(컴포넌트명)`를 그 컴포넌트 props를 펼친 Object로 치환한다.
/// 평탄화가 끝나 모든 컴포넌트가 acc에 있어야 참조를 풀 수 있어 여기서 한다.
fn expand_type_refs(comps: &mut [FlatComp]) -> Result<(), FlattenError> {
    // 컴포넌트명 -> props 스냅샷(치환 전 원본). Ref가 Ref를 가리키는 연쇄는 expand_type가
    // 재귀로 따라가며 방문 스택으로 순환을 막는다.
    let props_of: Vec<(String, Vec<Prop>)> = comps
        .iter()
        .map(|c| (c.comp.name.clone(), c.comp.props.clone()))
        .collect();

    for c in comps.iter_mut() {
        for p in &mut c.comp.props {
            // 재귀는 출처를 안 들고 다닌다 - 타입 트리는 그 컴포넌트 파일 안에 있으니
            // 여기서 한 번 감싼다.
            expand_type(&mut p.type_, &props_of, &mut Vec::new())
                .map_err(|e| FlattenError::Type(Sourced::from_origin(&c.origin, e)))?;
        }
    }
    Ok(())
}

/// 타입 트리를 내려가며 Ref를 대상 컴포넌트 props의 Object로 치환한다. visiting은 현재
/// 풀고 있는 Ref 이름 스택 - 같은 이름을 다시 만나면 순환(에러).
fn expand_type(
    ty: &mut Type,
    props_of: &[(String, Vec<Prop>)],
    visiting: &mut Vec<String>,
) -> Result<(), TypeError> {
    match ty {
        Type::Bool | Type::Number | Type::String => Ok(()),
        Type::Array(inner) => expand_type(inner, props_of, visiting),
        Type::Object(fields) => {
            for (_, field_ty) in fields {
                expand_type(field_ty, props_of, visiting)?;
            }
            Ok(())
        }
        Type::Ref(name) => {
            if visiting.iter().any(|v| v == &name.name) {
                return Err(TypeError {
                    kind: TypeErrorKind::TypeCycle(name.name.clone()),
                    range: name.range.0,
                });
            }
            let props = props_of
                .iter()
                .find(|(n, _)| n == &name.name)
                .map(|(_, p)| p)
                .ok_or_else(|| TypeError {
                    kind: TypeErrorKind::UnknownType(name.name.clone()),
                    range: name.range.0,
                })?;
            visiting.push(name.name.clone());
            // 대상 props를 Object 필드로 펼치고, 그 안의 Ref도 재귀로 푼다.
            let mut fields = Vec::with_capacity(props.len());
            for p in props {
                let mut field_ty = p.type_.clone();
                expand_type(&mut field_ty, props_of, visiting)?;
                fields.push((p.name.clone(), field_ty));
            }
            visiting.pop();
            *ty = Type::Object(fields);
            Ok(())
        }
        // 유틸 타입: 안쪽을 Object로 풀고 키로 필터한다. 팔은 필터 방향만 다르다(Omit=제거, Pick=선택).
        Type::Omit(inner, keys, at) => {
            let fields = util_fields(inner, keys, at.0, props_of, visiting)?;
            let kept = fields
                .into_iter()
                .filter(|(n, _)| !keys.iter().any(|k| &k.name == n))
                .collect();
            *ty = Type::Object(kept);
            Ok(())
        }
        Type::Pick(inner, keys, at) => {
            let fields = util_fields(inner, keys, at.0, props_of, visiting)?;
            let kept = fields
                .into_iter()
                .filter(|(n, _)| keys.iter().any(|k| &k.name == n))
                .collect();
            *ty = Type::Object(kept);
            Ok(())
        }
    }
}

/// 유틸 타입(Omit/Pick)의 안쪽을 Object로 풀어 그 필드를 돌려준다. 나열한 키가 안쪽에
/// 실재하는지 검증한다(오타 방지). 필터 방향은 호출부가 정한다.
///
/// `util_at`은 `Omit<...>` 표기 전체의 구간 - 안쪽이 객체가 아닐 때 탓할 자리다. 안쪽 타입만
/// 짚지 않는 건 Type이 저마다 위치를 들어야 해서다(ast.rs `Type`).
fn util_fields(
    inner: &mut Type,
    keys: &[Ident],
    util_at: SrcRange,
    props_of: &[(String, Vec<Prop>)],
    visiting: &mut Vec<String>,
) -> Result<Vec<(String, Type)>, TypeError> {
    expand_type(inner, props_of, visiting)?;
    let fields = match std::mem::replace(inner, Type::Bool) {
        Type::Object(fields) => fields,
        _ => {
            return Err(TypeError {
                kind: TypeErrorKind::NonObjectUtil,
                range: util_at,
            })
        }
    };
    for k in keys {
        if !fields.iter().any(|(n, _)| n == &k.name) {
            return Err(TypeError {
                kind: TypeErrorKind::UnknownKey(k.name.clone()),
                range: k.range.0,
            });
        }
    }
    Ok(fields)
}

struct Ctx {
    acc: Vec<FlatComp>,            // 평탄화 결과 (엔트리 ID 0, 순서 유지)
    origin: Vec<(String, String)>, // (컴포넌트명, 출처 정규화 경로) - 동명 충돌 판정용
    recursed: Vec<String>,         // 의존성 재귀를 끝낸 경로 (한 파일의 use 그래프는 한 번만 탐)
    visiting: Vec<String>,         // 현재 DFS 경로 (순환 감지)
}

/// use로 이름을 끌어온 자리. 에러가 나는 곳은 대상 파일을 판 뒤지만 탓할 자리는 use한 쪽이라
/// 그 파일의 출처와 이름별 위치를 함께 들고 내려간다.
struct WantedFrom<'a> {
    names: &'a [Ident],
    /// use를 적은 파일(대상 파일이 아니라).
    origin: &'a Origin,
}

/// 한 파일에서 want에 해당하는 컴포넌트를 acc에 보장하고(멱등), 그 파일의 의존성을 재귀한다.
/// want=None이면 그 파일의 모든 컴포넌트(엔트리). want=Some이면 나열된 이름만.
/// path = 이 소스의 정규화 경로 (자식 use의 base이자 재귀/순환 키).
fn collect(
    path: &str,
    src: &str,
    want: Option<WantedFrom>,
    loader: &impl SourceLoader,
    ctx: &mut Ctx,
) -> Result<(), FlattenError> {
    // 에러에 이 파일(path/src)을 실어 보낸다 - range가 어느 파일 오프셋인지 소비처가 알아야 한다.
    let lexed = lexer::lex(src).map_err(|e| FlattenError::Lex(Sourced::new(path, src, e)))?;
    let source = parse::parse(&lexed, src.len())
        .map_err(|e| FlattenError::Parse(Sourced::new(path, src, e)))?;

    // want로 가져올 컴포넌트를 고른다. None이면 전부.
    let take = |name: &str| {
        want.as_ref()
            .map_or(true, |w| w.names.iter().any(|n| n.name == name))
    };

    // 이 이름을 끌어온 use 자리 - 충돌을 탓할 곳이다. 엔트리(want=None)는 use가 없어 None.
    let pulled_in = |name: &str| {
        want.as_ref().and_then(|w| {
            w.names
                .iter()
                .find(|n| n.name == name)
                .map(|n| (w.origin, n))
        })
    };

    // 나열한 이름이 이 파일에 실제로 있는지(오타 방지). 탓할 자리는 use한 쪽의 그 이름이다.
    if let Some(w) = &want {
        for wanted in w.names {
            if !source.comps.iter().any(|c| c.name == wanted.name) {
                return Err(FlattenError::Use(Sourced::from_origin(
                    w.origin,
                    UseError {
                        kind: UseErrorKind::MissingExport {
                            path: path.to_string(),
                            name: wanted.name.clone(),
                        },
                        range: wanted.range.0,
                    },
                )));
            }
        }
    }

    // 이 파일에서 나온 컴포넌트들이 공유할 출처 - codegen 에러가 이걸로 파일을 짚는다.
    // 이 파일의 use/리소스 에러도 같은 출처를 쓴다(탓할 자리가 이 파일 안이다).
    let from_file = Origin {
        path: std::rc::Rc::from(path),
        src: std::rc::Rc::from(src),
    };

    // 리소스 경로를 정규화한다(컴포넌트 import와 같은 loader). 정규화 경로의 동일성이
    // 모듈 전역 resId dedup 키 - 상대경로가 달라도 같은 파일이면 합쳐진다. 소스 텍스트는
    // 버린다(내용 해시/복사/URL화는 빌드 단계). drop으로 즉시 반납돼 누적되지 않는다.
    let mut resources = Vec::with_capacity(source.resources.len());
    for res_path in &source.resources {
        let (canonical, _src) = loader.load(path, &res_path.name).ok_or_else(|| {
            FlattenError::Use(Sourced::from_origin(
                &from_file,
                UseError {
                    kind: UseErrorKind::NotFound {
                        base: path.to_string(),
                        target: res_path.name.clone(),
                    },
                    range: res_path.range.0,
                },
            ))
        })?;
        resources.push(canonical);
    }

    // 가져올 컴포넌트를 acc에 넣는다. 같은 이름이 다른 파일에서 왔으면 충돌, 같은 파일이면 다이아몬드(skip).
    // 리소스는 파일 단위 선언이라 이 파일의 모든 컴포넌트가 같은 목록을 복제해 가진다(A안).
    for comp in source.comps {
        if !take(&comp.name) {
            continue;
        }
        if let Some((_, origin)) = ctx.origin.iter().find(|(n, _)| n == &comp.name) {
            if origin != path {
                // 충돌은 이 파일을 끌어온 use의 그 이름을 탓한다 - 이름을 나른 자리다.
                let kind = UseErrorKind::DuplicateComponent(comp.name.clone());
                return Err(match pulled_in(&comp.name) {
                    Some((origin, name)) => FlattenError::Use(Sourced::from_origin(
                        origin,
                        UseError {
                            kind,
                            range: name.range.0,
                        },
                    )),
                    // 엔트리는 use가 없다. ctx.origin이 비어 시작하므로 실제로는 안 온다.
                    None => FlattenError::DuplicateComponent(comp.name.clone()),
                });
            }
            continue; // 같은 파일 같은 컴포넌트 - 이미 들어감.
        }
        ctx.origin.push((comp.name.clone(), path.to_string()));
        ctx.acc.push(FlatComp {
            comp,
            resources: resources.clone(),
            origin: from_file.clone(),
        });
    }

    // 이 파일의 의존성 재귀는 한 번만 (다이아몬드여도 use 그래프는 한 번 탐).
    if ctx.recursed.iter().any(|p| p == path) {
        return Ok(());
    }
    ctx.recursed.push(path.to_string());

    ctx.visiting.push(path.to_string());
    for u in &source.uses {
        // 못 찾으면 경로 자리를, 순환이면 use 줄 전체를 탓한다(ast.rs `Use` 그림).
        let (target_path, target_src) = loader.load(path, &u.path.name).ok_or_else(|| {
            FlattenError::Use(Sourced::from_origin(
                &from_file,
                UseError {
                    kind: UseErrorKind::NotFound {
                        base: path.to_string(),
                        target: u.path.name.clone(),
                    },
                    range: u.path.range.0,
                },
            ))
        })?;

        if ctx.visiting.iter().any(|v| v == &target_path) {
            return Err(FlattenError::Use(Sourced::from_origin(
                &from_file,
                UseError {
                    kind: UseErrorKind::Cycle(target_path),
                    range: u.range.0,
                },
            )));
        }
        // use 대상은 나열된 이름만 가져온다. 출처는 이 파일 - MissingExport가 여기를 탓한다.
        let wanted = WantedFrom {
            names: &u.names,
            origin: &from_file,
        };
        collect(&target_path, &target_src, Some(wanted), loader, ctx)?;
    }
    ctx.visiting.pop();
    Ok(())
}
