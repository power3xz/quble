//! use 그래프를 따라가 여러 소스의 컴포넌트를 하나의 평탄한 Vec<Component>로 모은다(A안).
//! 모듈 포맷은 안 건드린다 — codegen이 평탄화된 정의들을 단일 패스로 처리한다.
//!
//! 경로 의미론은 컴파일러가 모른다. resolver가 (base, target)을 정규화된 경로로 풀어 소스와 함께
//! 돌려준다. 컴파일러는 그 정규화된 경로의 동일성만으로 다이아몬드(중복 skip)와 순환(에러)을 본다.
//! esbuild/rollup의 resolve(importer, specifier) -> 정규화 경로 패턴의 최소 버전이다.

use crate::ast::Component;
use crate::lexer;
use crate::parse;

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
}

/// 엔트리 소스를 파싱하고 use 그래프를 따라가 모든 컴포넌트를 평탄화한다.
/// 각 소스의 컴포넌트를 먼저 acc에 넣고 의존성을 뒤에 붙인다(전위 순회) — 엔트리가 ID 0.
/// child_id 해소는 codegen의 CompLookup이 전체를 먼저 보므로 순서와 무관하다.
pub fn flatten(
    entry_path: &str,
    entry_src: &str,
    resolver: &impl Resolver,
) -> Result<Vec<Component>, ResolveError> {
    let mut acc = Vec::new();
    let mut visited = Vec::new(); // 수집 끝난 정규화 경로 (다이아몬드 skip)
    let mut visiting = Vec::new(); // 현재 DFS 경로의 정규화 경로 (순환 감지)
    collect(entry_path, entry_src, resolver, &mut acc, &mut visited, &mut visiting)?;
    Ok(acc)
}

/// 한 소스의 의존성을 먼저 재귀로 끌어오고, 그 소스의 컴포넌트를 acc에 더한다.
/// path = 이 소스 자신의 정규화 경로 (자식 use의 base이자 중복/순환 키).
fn collect(
    path: &str,
    src: &str,
    resolver: &impl Resolver,
    acc: &mut Vec<Component>,
    visited: &mut Vec<String>,
    visiting: &mut Vec<String>,
) -> Result<(), ResolveError> {
    let tokens = lexer::lex(src).map_err(ResolveError::Lex)?;
    let source = parse::parse(&tokens).map_err(ResolveError::Parse)?;

    // 이 소스의 컴포넌트를 먼저 넣는다(엔트리가 맨 앞 = ID 0). 그 다음 의존성을 뒤에 붙인다.
    for comp in source.comps {
        if acc.iter().any(|c| c.name == comp.name) {
            return Err(ResolveError::DuplicateComponent(comp.name.clone()));
        }
        acc.push(comp);
    }
    visited.push(path.to_string());

    visiting.push(path.to_string());
    for u in &source.uses {
        let (target_path, target_src) =
            resolver
                .resolve(path, &u.path)
                .ok_or_else(|| ResolveError::NotFound {
                    base: path.to_string(),
                    target: u.path.clone(),
                })?;

        if visiting.iter().any(|v| v == &target_path) {
            return Err(ResolveError::Cycle(target_path));
        }

        // 이미 수집한 소스라도, use 한 이름이 거기 실제로 있는지는 확인한다(오타 방지).
        verify_exports(&target_path, &target_src, &u.names)?;

        if visited.iter().any(|v| v == &target_path) {
            continue; // 다이아몬드 — 한 번만 수집.
        }
        collect(&target_path, &target_src, resolver, acc, visited, visiting)?;
    }
    visiting.pop();
    Ok(())
}

/// use 한 이름들이 대상 소스에 정의돼 있는지 검사.
fn verify_exports(path: &str, src: &str, names: &[String]) -> Result<(), ResolveError> {
    let tokens = lexer::lex(src).map_err(ResolveError::Lex)?;
    let source = parse::parse(&tokens).map_err(ResolveError::Parse)?;
    for name in names {
        if !source.comps.iter().any(|c| &c.name == name) {
            return Err(ResolveError::MissingExport {
                path: path.to_string(),
                name: name.clone(),
            });
        }
    }
    Ok(())
}
