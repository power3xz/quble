//! use 그래프를 따라가 여러 소스의 컴포넌트를 하나의 평탄한 Vec<Component>로 모은다(A안).
//! 모듈 포맷은 안 건드린다 - codegen이 평탄화된 정의들을 단일 패스로 처리한다.
//!
//! 경로 의미론은 컴파일러가 모른다. resolver가 (base, target)을 정규화된 경로로 풀어 소스와 함께
//! 돌려준다. 컴파일러는 그 정규화된 경로의 동일성만으로 다이아몬드(중복 skip)와 순환(에러)을 본다.
//! esbuild/rollup의 resolve(importer, specifier) -> 정규화 경로 패턴의 최소 버전이다.

use crate::ast::{Component, Prop, Type};
use crate::lexer;
use crate::parse;

/// 평탄화된 컴포넌트 + 그 컴포넌트가 속한 파일의 리소스 경로(`use './x.css'`).
/// 같은 파일에서 나온 컴포넌트는 같은 resources를 복제해 가진다(파일 단위 선언이라
/// 어느 컴포넌트가 쓰는지 특정 불가 - 전부 후보). codegen이 정의 앞에 LOAD_RES를 낸다.
pub struct FlatComp {
    pub comp: Component,
    pub resources: Vec<String>,
}

/// use 경로 해소기. base(use를 적은 소스의 정규화 경로)와 target(`./Foo.qubc`)을 받아
/// 대상의 (정규화 경로, 소스 문자열)을 돌려준다. 못 찾으면 None.
pub trait Resolver {
    fn resolve(
        &self,
        base_canonical_path: &str,
        target_path: &str,
    ) -> Option<(String, String)>;
}

impl<F: Fn(&str, &str) -> Option<(String, String)>> Resolver for F {
    fn resolve(&self, base_canonical_path: &str, target_path: &str) -> Option<(String, String)> {
        self(base_canonical_path, target_path)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ResolveError {
    Lex(lexer::LexError),
    Parse(parse::ParseError),
    /// use가 가리키는 경로를 resolver가 찾지 못함.
    NotFound { base: String, target: String },
    /// 같은 이름의 컴포넌트가 서로 다른 소스에 정의됨.
    DuplicateComponent(String),
    /// use 한 이름이 대상 소스에 정의돼 있지 않음.
    MissingExport { path: String, name: String },
    /// use 그래프에 순환이 있음.
    Cycle(String),
    /// prop 타입 참조(`x: Foo`)의 Foo가 평탄화된 컴포넌트에 없음.
    UnknownType(String),
    /// 타입 참조가 순환한다(A의 prop 타입이 B, B가 A).
    TypeCycle(String),
    /// Omit/Pick의 안쪽이 객체(로 환원되는 타입)가 아님.
    NonObjectUtil,
    /// Omit/Pick이 나열한 키가 안쪽 타입에 없음.
    UnknownKey(String),
}

/// 엔트리 소스를 파싱하고 use 그래프를 따라가 컴포넌트를 평탄화한다.
/// 엔트리는 모든 컴포넌트를 가져가고(ID 0부터), use 대상 파일은 나열된 이름만 가져온다.
/// 안 쓰는 컴포넌트는 병합에서 제외된다 - 쓰려면 codegen이 CompLookup에서 막는다.
pub fn flatten(
    entry_path: &str,
    entry_src: &str,
    resolver: &impl Resolver,
) -> Result<Vec<FlatComp>, ResolveError> {
    let mut ctx = Ctx {
        acc: Vec::new(),
        origin: Vec::new(),
        recursed: Vec::new(),
        visiting: Vec::new(),
    };
    // 엔트리는 want=None - 자기 파일 컴포넌트 전부.
    collect(entry_path, entry_src, None, resolver, &mut ctx)?;
    resolve_type_refs(&mut ctx.acc)?;
    Ok(ctx.acc)
}

/// prop 타입 안의 `Type::Ref(컴포넌트명)`를 그 컴포넌트 props를 펼친 Object로 치환한다.
/// 평탄화가 끝나 모든 컴포넌트가 acc에 있어야 참조를 풀 수 있어 여기서 한다.
fn resolve_type_refs(comps: &mut [FlatComp]) -> Result<(), ResolveError> {
    // 컴포넌트명 -> props 스냅샷(치환 전 원본). Ref가 Ref를 가리키는 연쇄는 resolve_type가
    // 재귀로 따라가며 방문 스택으로 순환을 막는다.
    let props_of: Vec<(String, Vec<Prop>)> = comps
        .iter()
        .map(|c| (c.comp.name.clone(), c.comp.props.clone()))
        .collect();

    for c in comps.iter_mut() {
        for p in &mut c.comp.props {
            resolve_type(&mut p.ty, &props_of, &mut Vec::new())?;
        }
    }
    Ok(())
}

/// 타입 트리를 내려가며 Ref를 대상 컴포넌트 props의 Object로 치환한다. visiting은 현재
/// 풀고 있는 Ref 이름 스택 - 같은 이름을 다시 만나면 순환(에러).
fn resolve_type(
    ty: &mut Type,
    props_of: &[(String, Vec<Prop>)],
    visiting: &mut Vec<String>,
) -> Result<(), ResolveError> {
    match ty {
        Type::Bool | Type::Number | Type::String => Ok(()),
        Type::Array(inner) => resolve_type(inner, props_of, visiting),
        Type::Object(fields) => {
            for (_, field_ty) in fields {
                resolve_type(field_ty, props_of, visiting)?;
            }
            Ok(())
        }
        Type::Ref(name) => {
            if visiting.iter().any(|v| v == name) {
                return Err(ResolveError::TypeCycle(name.clone()));
            }
            let props = props_of
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, p)| p)
                .ok_or_else(|| ResolveError::UnknownType(name.clone()))?;
            visiting.push(name.clone());
            // 대상 props를 Object 필드로 펼치고, 그 안의 Ref도 재귀로 푼다.
            let mut fields = Vec::with_capacity(props.len());
            for p in props {
                let mut field_ty = p.ty.clone();
                resolve_type(&mut field_ty, props_of, visiting)?;
                fields.push((p.name.clone(), field_ty));
            }
            visiting.pop();
            *ty = Type::Object(fields);
            Ok(())
        }
        // 유틸 타입: 안쪽을 Object로 풀고 키로 필터한다. 팔은 필터 방향만 다르다(Omit=제거, Pick=선택).
        Type::Omit(inner, keys) => {
            let fields = util_fields(inner, keys, props_of, visiting)?;
            let kept = fields.into_iter().filter(|(n, _)| !keys.contains(n)).collect();
            *ty = Type::Object(kept);
            Ok(())
        }
        Type::Pick(inner, keys) => {
            let fields = util_fields(inner, keys, props_of, visiting)?;
            let kept = fields.into_iter().filter(|(n, _)| keys.contains(n)).collect();
            *ty = Type::Object(kept);
            Ok(())
        }
    }
}

/// 유틸 타입(Omit/Pick)의 안쪽을 Object로 풀어 그 필드를 돌려준다. 나열한 키가 안쪽에
/// 실재하는지 검증한다(오타 방지). 필터 방향은 호출부가 정한다.
fn util_fields(
    inner: &mut Type,
    keys: &[String],
    props_of: &[(String, Vec<Prop>)],
    visiting: &mut Vec<String>,
) -> Result<Vec<(String, Type)>, ResolveError> {
    resolve_type(inner, props_of, visiting)?;
    let fields = match std::mem::replace(inner, Type::Bool) {
        Type::Object(fields) => fields,
        _ => return Err(ResolveError::NonObjectUtil),
    };
    for k in keys {
        if !fields.iter().any(|(n, _)| n == k) {
            return Err(ResolveError::UnknownKey(k.clone()));
        }
    }
    Ok(fields)
}

struct Ctx {
    acc: Vec<FlatComp>,        // 평탄화 결과 (엔트리 ID 0, 순서 유지)
    origin: Vec<(String, String)>, // (컴포넌트명, 출처 정규화 경로) - 동명 충돌 판정용
    recursed: Vec<String>,     // 의존성 재귀를 끝낸 경로 (한 파일의 use 그래프는 한 번만 탐)
    visiting: Vec<String>,     // 현재 DFS 경로 (순환 감지)
}

/// 한 파일에서 want에 해당하는 컴포넌트를 acc에 보장하고(멱등), 그 파일의 의존성을 재귀한다.
/// want=None이면 그 파일의 모든 컴포넌트(엔트리). want=Some이면 나열된 이름만.
/// path = 이 소스의 정규화 경로 (자식 use의 base이자 재귀/순환 키).
fn collect(
    path: &str,
    src: &str,
    want: Option<&[String]>,
    resolver: &impl Resolver,
    ctx: &mut Ctx,
) -> Result<(), ResolveError> {
    let tokens = lexer::lex(src).map_err(ResolveError::Lex)?;
    let source = parse::parse(&tokens).map_err(ResolveError::Parse)?;

    // want로 가져올 컴포넌트를 고른다. None이면 전부.
    let take = |name: &str| want.map_or(true, |ns| ns.iter().any(|n| n == name));

    // 나열한 이름이 이 파일에 실제로 있는지(오타 방지).
    if let Some(names) = want {
        for name in names {
            if !source.comps.iter().any(|c| &c.name == name) {
                return Err(ResolveError::MissingExport {
                    path: path.to_string(),
                    name: name.clone(),
                });
            }
        }
    }

    // 리소스 경로를 정규화한다(컴포넌트 import와 같은 resolver). 정규화 경로의 동일성이
    // 모듈 전역 resId dedup 키 - 상대경로가 달라도 같은 파일이면 합쳐진다. 소스 텍스트는
    // 버린다(내용 해시·복사·URL화는 빌드 단계). drop으로 즉시 반납돼 누적되지 않는다.
    let mut resources = Vec::with_capacity(source.resources.len());
    for res_path in &source.resources {
        let (canonical, _src) =
            resolver
                .resolve(path, res_path)
                .ok_or_else(|| ResolveError::NotFound {
                    base: path.to_string(),
                    target: res_path.clone(),
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
                return Err(ResolveError::DuplicateComponent(comp.name.clone()));
            }
            continue; // 같은 파일 같은 컴포넌트 - 이미 들어감.
        }
        ctx.origin.push((comp.name.clone(), path.to_string()));
        ctx.acc.push(FlatComp {
            comp,
            resources: resources.clone(),
        });
    }

    // 이 파일의 의존성 재귀는 한 번만 (다이아몬드여도 use 그래프는 한 번 탐).
    if ctx.recursed.iter().any(|p| p == path) {
        return Ok(());
    }
    ctx.recursed.push(path.to_string());

    ctx.visiting.push(path.to_string());
    for u in &source.uses {
        let (target_path, target_src) =
            resolver
                .resolve(path, &u.path)
                .ok_or_else(|| ResolveError::NotFound {
                    base: path.to_string(),
                    target: u.path.clone(),
                })?;

        if ctx.visiting.iter().any(|v| v == &target_path) {
            return Err(ResolveError::Cycle(target_path));
        }
        // use 대상은 나열된 이름만 가져온다.
        collect(&target_path, &target_src, Some(&u.names), resolver, ctx)?;
    }
    ctx.visiting.pop();
    Ok(())
}
