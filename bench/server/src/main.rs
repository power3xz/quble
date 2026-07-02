//! 벤치 전용 서버. bench/components/*.qubc를 시작 시 qubb로 컴파일해 적재하고,
//! 경로에 맞게 제공한다. qubb vs React lazy chunk 네트워크 비용 비교가 목적이고,
//! SSR·클라 렌더는 기능 확인용이다.
//!
//!  - GET /components/<name> : <name>.qubc를 컴파일한 qubb 바이트.
//!  - GET /ssr/<name>        : renderer로 렌더한 HTML(기능 확인).
//!  - GET /runtime.js, /region.js : 클라이언트 런타임.
//!  - GET /react/*           : React 빌드 산출물(bench/react/dist).
//!
//! 실행: bench/server에서 `cargo run`  → http://localhost:7878

use std::collections::HashMap;
use std::fs;
use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;
use tiny_http::{Header, Request, Response, Server};

const ADDR: &str = "127.0.0.1:7878";
const COMPONENTS_DIR: &str = "../components";
const RUNTIME_JS: &str = "../../proto/web/runtime.js";
const REGION_JS: &str = "../../proto/web/region.js";
const LEAF_STORE_JS: &str = "../../proto/web/leaf-store.js";
const DISASM_JS: &str = "../../proto/web/disasm.js";
const MOUNT_JS: &str = "../../proto/web/mount.js";
const REACT_DIST: &str = "../react/dist";
const SVELTE_DIST: &str = "../svelte/dist";
const QUBB_DIST: &str = "../dist";

fn main() {
    let loaded = build_components();
    println!(
        "적재된 컴포넌트: {:?}",
        loaded.components.keys().collect::<Vec<_>>()
    );

    let server = Server::http(ADDR).expect("서버 시작 실패");
    println!("listening on http://{ADDR}");

    for req in server.incoming_requests() {
        let url = req.url().to_string();
        // path와 query를 분리. scope는 query의 `scope=` 반복 키(순서=인덱스).
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let path = path.to_string();

        if path == "/runtime.js" {
            match fs::read(RUNTIME_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if path == "/region.js" {
            match fs::read(REGION_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if path == "/leaf-store.js" {
            match fs::read(LEAF_STORE_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if path == "/disasm.js" {
            match fs::read(DISASM_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if path == "/mount.js" {
            match fs::read(MOUNT_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if path == "/components" {
            // 적재 컴포넌트 이름 목록(JSON 배열) - inspector 셀렉트박스용.
            // litprofilecard(리터럴 인자 데모)를 맨 앞으로 - 나머지는 알파벳순.
            let mut names = loaded.components.keys().cloned().collect::<Vec<_>>();
            names.sort_by_key(|n| (n != "litprofilecard", n.clone()));
            let json = format!(
                "[{}]",
                names
                    .iter()
                    .map(|n| format!("\"{n}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            respond(req, json.into_bytes(), "application/json; charset=utf-8");
        } else if let Some(name) = path
            .strip_prefix("/components/")
            .and_then(|n| n.strip_suffix(".qubb"))
        {
            match loaded.components.get(name) {
                Some(bytes) => respond(req, bytes.clone(), "application/octet-stream"),
                None => not_found(req),
            }
        } else if let Some(name) = path.strip_prefix("/resmap/") {
            // 리소스맵(JSON 배열, 인덱스=resId, 값=`/res/...` URL) - 클라 런타임이 LOAD_RES에 쓴다.
            match loaded.resmaps.get(name) {
                Some(paths) => {
                    let json = format!(
                        "[{}]",
                        paths
                            .iter()
                            .map(|p| format!("\"{p}\""))
                            .collect::<Vec<_>>()
                            .join(",")
                    );
                    respond(req, json.into_bytes(), "application/json; charset=utf-8");
                }
                None => not_found(req),
            }
        } else if path.starts_with("/res/") {
            // 산출 리소스(`res/<hash>.css`) 정적 서빙 - SSR <link href>가 가리키는 경로.
            // path는 선행 '/'가 있으므로 떼고 assets 키(`res/...`)와 맞춘다.
            match loaded.assets.get(&path[1..]) {
                Some(content) => respond(req, content.clone(), "text/css; charset=utf-8"),
                None => not_found(req),
            }
        } else if let Some(name) = path.strip_prefix("/ssr/") {
            match loaded.components.get(name) {
                Some(bytes) => {
                    let res_paths = loaded.resmaps.get(name).map(Vec::as_slice).unwrap_or(&[]);
                    match renderer::render_to_string(bytes, 0, &scope_from_query(query), res_paths)
                    {
                        Ok(html) => {
                            let page = page_shell(&format!("SSR {name}"), &html);
                            respond(req, page.into_bytes(), "text/html; charset=utf-8");
                        }
                        Err(e) => server_error(req, format!("렌더 실패: {e:?}")),
                    }
                }
                None => not_found(req),
            }
        } else if let Some(name) = path.strip_prefix("/react-csr/") {
            let name = name.to_string();
            respond(
                req,
                react_csr_page(&name, query).into_bytes(),
                "text/html; charset=utf-8",
            );
        } else if path.starts_with("/react/assets/") {
            serve_react_asset(req, &path);
        } else if let Some(name) = path.strip_prefix("/react/") {
            // /react/<Name> → 부트 HTML. _boot.js가 views/<Name>.jsx를 동적 import 해 렌더.
            respond(
                req,
                boot_page("/react/assets/_boot.js", name).into_bytes(),
                "text/html; charset=utf-8",
            );
        } else if path.starts_with("/svelte/assets/") {
            serve_svelte_asset(req, &path);
        } else if let Some(name) = path.strip_prefix("/svelte/") {
            // /svelte/<Name> → 부트 HTML. _boot.js가 views/<Name>.svelte를 동적 import 해 mount.
            respond(
                req,
                boot_page("/svelte/assets/_boot.js", name).into_bytes(),
                "text/html; charset=utf-8",
            );
        } else if path.starts_with("/dist/") {
            // build.mjs 산출물(qubb + manifest.json + res/*handlers.js)을 그대로 서빙.
            // inspector URL 입력에 /dist/<name>.qubb를 넣으면 manifest.handlers까지 로드된다.
            serve_qubb_dist(req, &path);
        } else if path.starts_with("/img/") {
            // 예제 상품 이미지는 전부 플레이스홀더 한 장으로.
            serve_public(req, "placeholder.svg");
        } else if let Some(rel) = path.strip_prefix("/public/") {
            serve_public(req, rel);
        } else {
            not_found(req);
        }
    }
}

/// 시작 시 컴파일해 메모리에 적재한 산출물. 디스크에 떨구지 않고 전부 메모리에서 제공한다.
struct Loaded {
    /// name(확장자 제외) → qubb 바이트.
    components: HashMap<String, Vec<u8>>,
    /// name → resId별 산출 리소스 경로(`res/<hash>.css`). SSR이 <link href>로 인라인.
    resmaps: HashMap<String, Vec<String>>,
    /// 산출 경로(`res/<hash>.css`) → CSS 내용. `/res/...` 요청에 응답.
    assets: HashMap<String, Vec<u8>>,
}

/// components 디렉토리의 *.qubc를 전부 컴파일하고, use한 CSS를 내용 해시 경로로 메모리에 적재한다.
fn build_components() -> Loaded {
    let mut loaded = Loaded {
        components: HashMap::new(),
        resmaps: HashMap::new(),
        assets: HashMap::new(),
    };
    let dir = fs::read_dir(COMPONENTS_DIR).expect("components 디렉토리 읽기 실패");
    for entry in dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("qubc") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap()
            .to_string();
        // compile_file이 엔트리를 읽고 use는 importer 기준 상대경로로 해소한다.
        let output = compiler::compile_file(path.to_str().unwrap()).expect("컴파일 실패");

        // 리소스(원본 정규화 경로)를 읽어 내용 해시 경로(`res/<basename>.<hash>.css`)로.
        // 산출 경로는 SSR <link href>이자 assets 키 - 둘이 같아야 브라우저가 받아온다.
        let mut res_paths = Vec::with_capacity(output.resources.len());
        for origin in &output.resources {
            let content = fs::read(origin).expect("리소스 읽기 실패");
            let out_path = asset_path(std::path::Path::new(origin), &content);
            // assets 키는 `res/...`(라우팅이 선행 '/'를 떼고 맞춘다). SSR href는 페이지 경로와
            // 무관하게 `/res/...` 절대경로여야 한다(상대경로면 /ssr/ 기준으로 잘못 요청됨).
            res_paths.push(format!("/{out_path}"));
            loaded.assets.entry(out_path).or_insert(content);
        }
        loaded.resmaps.insert(name.clone(), res_paths);
        loaded.components.insert(name, output.bytecode.into_vec());
    }
    loaded
}

/// 원본 경로 + 내용으로 산출 자산 경로 `res/<basename>.<내용해시>.<ext>`를 만든다.
/// CLI(main.rs)의 산출 규칙과 같아야 한다. 평탄화 시 동명 충돌 방지 + 캐시 버스팅.
fn asset_path(origin: &std::path::Path, content: &[u8]) -> String {
    let stem = origin.file_stem().and_then(|s| s.to_str()).unwrap_or("res");
    let ext = origin.extension().and_then(|s| s.to_str()).unwrap_or("");
    let hash = content_hash(content);
    if ext.is_empty() {
        format!("res/{stem}.{hash}")
    } else {
        format!("res/{stem}.{hash}.{ext}")
    }
}

/// 콘텐츠 해시(FNV-1a 64bit). CLI(main.rs)와 같은 알고리즘 - 산출 경로가 일치해야 한다.
fn content_hash(bytes: &[u8]) -> String {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET_BASIS;
    for &byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// query의 `scope=` 반복 키를 순서대로 scope 배열로. (퍼센트 디코딩 포함)
fn scope_from_query(query: &str) -> Vec<String> {
    query
        .split('&')
        .filter_map(|kv| kv.strip_prefix("scope="))
        .map(percent_decode)
        .collect()
}

/// 최소 퍼센트 디코딩(`%XX`, `+`→공백). 쿼리 값 한글·공백 처리용.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 범용 부트 페이지: 빈 #root + 부트 스크립트. 부트가 URL의 <Name>으로 뷰를 동적 import 해 렌더한다.
/// 뷰가 자체적으로 #log·#cards를 만들므로 공통 스타일만 둔다(perf 등 외형 일치).
fn boot_page(boot_src: &str, name: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>{name}</title>
<link rel="stylesheet" href="/public/style.css"></head>
<body>
  <div id="root"></div>
  <script type="module" src="{boot_src}"></script>
</body></html>"#
    )
}

/// SSR·CSR 공통 페이지 셸. body만 다르고 골격(html+style)은 동일 - 외형을 맞춰 비교 가능.
fn page_shell(title: &str, body: &str) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>{title}</title>
<link rel="stylesheet" href="/public/style.css"></head>
<body>
{body}
</body></html>"#
    )
}

/// React CSR 페이지: 키=값 query를 props 객체로 주입하고 react-csr 번들을 로드해 클라 렌더.
fn react_csr_page(component: &str, query: &str) -> String {
    let props_js = props_json_from_query(query);
    let entry = "/react/assets/react-csr.js";
    let body = format!(
        r#"  <div id="root">로딩 중…</div>
  <script>window.__CSR__ = {{ component: "{component}", props: {props_js} }};</script>
  <script type="module" src="{entry}"></script>"#
    );
    page_shell(&format!("React CSR {component}"), &body)
}

/// 키=값 query를 JSON 객체 문자열로. (`scope`는 우리 전용 키라 제외 안 함 - react-csr는 이름 props만 씀)
fn props_json_from_query(query: &str) -> String {
    let pairs: Vec<String> = query
        .split('&')
        .filter(|kv| !kv.is_empty())
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| {
            let key = percent_decode(k);
            let val = percent_decode(v);
            format!("\"{}\":\"{}\"", json_escape(&key), json_escape(&val))
        })
        .collect();
    format!("{{{}}}", pairs.join(","))
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// React 빌드 산출물을 /react/ 아래로 서빙. 비교용.
fn serve_react_asset(req: Request, url: &str) {
    let rel = url.trim_start_matches("/react/");
    if rel.contains("..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let path = format!("{REACT_DIST}/{rel}");
    match fs::read(&path) {
        Ok(bytes) => {
            let ct = if rel.ends_with(".js") {
                "text/javascript; charset=utf-8"
            } else if rel.ends_with(".css") {
                "text/css; charset=utf-8"
            } else if rel.ends_with(".html") {
                "text/html; charset=utf-8"
            } else {
                "application/octet-stream"
            };
            respond(req, bytes, ct);
        }
        Err(_) => server_error_status(req, "react asset not found (빌드했나요?)", 404),
    }
}

/// Svelte 빌드 산출물을 /svelte/ 아래로 서빙. 비교용.
fn serve_svelte_asset(req: Request, url: &str) {
    let rel = url.trim_start_matches("/svelte/");
    if rel.contains("..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let path = format!("{SVELTE_DIST}/{rel}");
    match fs::read(&path) {
        Ok(bytes) => {
            let ct = if rel.ends_with(".js") {
                "text/javascript; charset=utf-8"
            } else if rel.ends_with(".css") {
                "text/css; charset=utf-8"
            } else {
                "application/octet-stream"
            };
            respond(req, bytes, ct);
        }
        Err(_) => server_error_status(req, "svelte asset not found (빌드했나요?)", 404),
    }
}

/// build.mjs 산출물(../dist)을 /dist/ 아래로 서빙. qubb·manifest.json·핸들러 JS·CSS를 그대로.
/// inspector가 /dist/<name>.qubb를 열면 manifest.handlers까지 로드해 실제 핸들러를 확인할 수 있다.
fn serve_qubb_dist(req: Request, url: &str) {
    let rel = url.trim_start_matches("/dist/");
    if rel.contains("..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let path = format!("{QUBB_DIST}/{rel}");
    match fs::read(&path) {
        Ok(bytes) => {
            let ct = if rel.ends_with(".js") {
                "text/javascript; charset=utf-8"
            } else if rel.ends_with(".json") {
                "application/json; charset=utf-8"
            } else if rel.ends_with(".css") {
                "text/css; charset=utf-8"
            } else {
                "application/octet-stream"
            };
            respond(req, bytes, ct);
        }
        Err(_) => server_error_status(req, "dist asset not found (build.mjs 돌렸나요?)", 404),
    }
}

/// public 디렉토리의 정적 자산(css·svg 등)을 서빙. 경로 탈출 방지.
fn serve_public(req: Request, rel: &str) {
    if rel.contains("..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let path = format!("public/{rel}");
    match fs::read(&path) {
        Ok(bytes) => {
            let ct = if rel.ends_with(".css") {
                "text/css; charset=utf-8"
            } else if rel.ends_with(".svg") {
                "image/svg+xml"
            } else if rel.ends_with(".html") {
                "text/html; charset=utf-8"
            } else {
                "application/octet-stream"
            };
            respond(req, bytes, ct);
        }
        Err(_) => not_found(req),
    }
}

/// 클라이언트가 gzip을 받으면 압축해 응답. 실전송(gz) 비교가 가능해진다.
fn respond(req: Request, body: Vec<u8>, content_type: &str) {
    let accepts_gzip = req
        .headers()
        .iter()
        .any(|h| h.field.equiv("Accept-Encoding") && h.value.as_str().contains("gzip"));

    let ct = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap();

    if accepts_gzip {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&body).unwrap();
        let gz = enc.finish().unwrap();
        let ce = Header::from_bytes(&b"Content-Encoding"[..], &b"gzip"[..]).unwrap();
        let _ = req.respond(Response::from_data(gz).with_header(ct).with_header(ce));
    } else {
        let _ = req.respond(Response::from_data(body).with_header(ct));
    }
}

fn not_found(req: Request) {
    server_error_status(req, "not found", 404);
}

fn server_error(req: Request, msg: String) {
    let _ = req.respond(Response::from_string(msg).with_status_code(500));
}

fn server_error_status(req: Request, msg: &str, code: u16) {
    let _ = req.respond(Response::from_string(msg).with_status_code(code));
}
