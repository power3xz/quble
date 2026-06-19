//! 벤치 전용 서버. bench/components/*.qubc를 시작 시 qubb로 컴파일해 적재하고,
//! 경로에 맞게 제공한다. qubb vs React lazy chunk 네트워크 비용 비교가 목적이고,
//! SSR·클라 렌더는 기능 확인용이다.
//!
//!  - GET /                  : 좌우 비교 페이지(index.html, React 엔트리만 치환).
//!  - GET /components/<name> : <name>.qubc를 컴파일한 qubb 바이트.
//!  - GET /ssr/<name>        : renderer로 렌더한 HTML(기능 확인).
//!  - GET /runtime.js        : 클라이언트 런타임.
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
const REACTIVE_JS: &str = "../../proto/web/reactive.js";
const REACT_DIST: &str = "../react/dist";
const SVELTE_DIST: &str = "../svelte/dist";

fn main() {
    let components = build_components();
    println!("적재된 컴포넌트: {:?}", components.keys().collect::<Vec<_>>());

    let server = Server::http(ADDR).expect("서버 시작 실패");
    println!("listening on http://{ADDR}");

    for req in server.incoming_requests() {
        let url = req.url().to_string();
        // path와 query를 분리. scope는 query의 `scope=` 반복 키(순서=인덱스).
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let path = path.to_string();

        if path == "/" {
            respond(req, page().into_bytes(), "text/html; charset=utf-8");
        } else if path == "/runtime.js" {
            match fs::read(RUNTIME_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if path == "/reactive.js" {
            match fs::read(REACTIVE_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if let Some(name) = path
            .strip_prefix("/components/")
            .and_then(|n| n.strip_suffix(".qubb"))
        {
            match components.get(name) {
                Some(bytes) => respond(req, bytes.clone(), "application/octet-stream"),
                None => not_found(req),
            }
        } else if let Some(name) = path.strip_prefix("/ssr/") {
            match components.get(name) {
                Some(bytes) => match renderer::render_to_string(bytes, 0, &scope_from_query(query)) {
                    Ok(html) => {
                        let page = page_shell(&format!("SSR {name}"), &html);
                        respond(req, page.into_bytes(), "text/html; charset=utf-8");
                    }
                    Err(e) => server_error(req, format!("렌더 실패: {e:?}")),
                },
                None => not_found(req),
            }
        } else if let Some(name) = path.strip_prefix("/csr/") {
            if components.contains_key(name) {
                respond(req, csr_page(name, query).into_bytes(), "text/html; charset=utf-8");
            } else {
                not_found(req);
            }
        } else if let Some(name) = path.strip_prefix("/react-csr/") {
            let name = name.to_string();
            respond(req, react_csr_page(&name, query).into_bytes(), "text/html; charset=utf-8");
        } else if path.starts_with("/react/") {
            serve_react_asset(req, &path);
        } else if path.starts_with("/img/") {
            // 예제 상품 이미지는 전부 플레이스홀더 한 장으로.
            serve_public(req, "placeholder.svg");
        } else if path == "/public/reactive-profilecard.html" {
            // 좌우 비교 페이지 — React 엔트리(해시명)를 주입해 서빙.
            match fs::read_to_string("public/reactive-profilecard.html") {
                Ok(html) => {
                    let html = html.replace("{{REACT_ENTRY}}", &react_entry_path());
                    respond(req, html.into_bytes(), "text/html; charset=utf-8");
                }
                Err(_) => not_found(req),
            }
        } else if path == "/public/react-perf.html" {
            // React 갱신 퍼포먼스 페이지 — perf 엔트리(해시명)를 주입해 서빙.
            match fs::read_to_string("public/react-perf.html") {
                Ok(html) => {
                    let html = html.replace("{{REACT_ENTRY}}", &react_asset_path("perf-"));
                    respond(req, html.into_bytes(), "text/html; charset=utf-8");
                }
                Err(_) => not_found(req),
            }
        } else if path == "/public/svelte-perf.html" {
            // Svelte 갱신 퍼포먼스 페이지 — perf 엔트리(해시명)를 주입해 서빙.
            match fs::read_to_string("public/svelte-perf.html") {
                Ok(html) => {
                    let html = html.replace("{{SVELTE_ENTRY}}", &svelte_asset_path("perf-"));
                    respond(req, html.into_bytes(), "text/html; charset=utf-8");
                }
                Err(_) => not_found(req),
            }
        } else if path.starts_with("/svelte/") {
            serve_svelte_asset(req, &path);
        } else if let Some(rel) = path.strip_prefix("/public/") {
            serve_public(req, rel);
        } else {
            not_found(req);
        }
    }
}

/// components 디렉토리의 *.qubc를 전부 컴파일해 name(확장자 제외) → qubb 맵으로.
fn build_components() -> HashMap<String, Vec<u8>> {
    let mut map = HashMap::new();
    let dir = fs::read_dir(COMPONENTS_DIR).expect("components 디렉토리 읽기 실패");
    for entry in dir.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("qubc") {
            continue;
        }
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap().to_string();
        let src = fs::read_to_string(&path).expect("qubc 읽기 실패");
        let bytes = compiler::compile(&src).expect("컴파일 실패").into_vec();
        map.insert(name, bytes);
    }
    map
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

/// SSR·CSR 공통 페이지 셸. body만 다르고 골격(html+style)은 동일 — 외형을 맞춰 비교 가능.
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

/// CSR 부트스트랩 페이지: runtime.js로 컴포넌트를 클라이언트 렌더. scope는 query에서 받아 주입.
fn csr_page(name: &str, query: &str) -> String {
    let scope = scope_from_query(query);
    // scope를 JS 배열 리터럴로. (간단한 JSON 직렬화 — 따옴표·역슬래시만 이스케이프)
    let scope_js = scope
        .iter()
        .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(",");
    let body = format!(
        r#"  <div id="root">로딩 중…</div>
  <script type="module">
    import {{ renderComponent }} from "/runtime.js";
    const res = await fetch("/components/{name}.qubb");
    const bytes = new Uint8Array(await res.arrayBuffer());
    document.getElementById("root").replaceChildren(renderComponent(bytes, 0, [{scope_js}]));
  </script>"#
    );
    page_shell(&format!("CSR {name}"), &body)
}

/// index.html을 읽어 React 빌드 엔트리 경로만 치환해 반환.
fn page() -> String {
    let html = fs::read_to_string("index.html").expect("index.html 읽기 실패");
    html.replace("{{REACT_ENTRY}}", &react_entry_path())
}

/// React 빌드의 기본 엔트리(main-*.js) 경로.
fn react_entry_path() -> String {
    react_asset_path("main-")
}

/// 해시된 빌드 산출물 중 prefix로 시작하는 .js 엔트리를 찾아 /react/ 경로로. 없으면 about:blank.
fn react_asset_path(prefix: &str) -> String {
    let dir = format!("{REACT_DIST}/assets");
    let entry = fs::read_dir(&dir).ok().and_then(|rd| {
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| n.starts_with(prefix) && n.ends_with(".js"))
    });
    match entry {
        Some(name) => format!("/react/assets/{name}"),
        None => "about:blank".to_string(),
    }
}

/// 해시된 Svelte 빌드 산출물 중 prefix로 시작하는 .js 엔트리를 /svelte/ 경로로. 없으면 about:blank.
fn svelte_asset_path(prefix: &str) -> String {
    let dir = format!("{SVELTE_DIST}/assets");
    let entry = fs::read_dir(&dir).ok().and_then(|rd| {
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| n.starts_with(prefix) && n.ends_with(".js"))
    });
    match entry {
        Some(name) => format!("/svelte/assets/{name}"),
        None => "about:blank".to_string(),
    }
}

/// React CSR 페이지: 키=값 query를 props 객체로 주입하고 react-csr 번들을 로드해 클라 렌더.
fn react_csr_page(component: &str, query: &str) -> String {
    let props_js = props_json_from_query(query);
    let entry = react_asset_path("react-csr-");
    let body = format!(
        r#"  <div id="root">로딩 중…</div>
  <script>window.__CSR__ = {{ component: "{component}", props: {props_js} }};</script>
  <script type="module" src="{entry}"></script>"#
    );
    page_shell(&format!("React CSR {component}"), &body)
}

/// 키=값 query를 JSON 객체 문자열로. (`scope`는 우리 전용 키라 제외 안 함 — react-csr는 이름 props만 씀)
fn props_json_from_query(query: &str) -> String {
    let pairs: Vec<String> = query
        .split('&')
        .filter(|kv| !kv.is_empty())
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| {
            let key = percent_decode(k);
            let val = percent_decode(v);
            format!(
                "\"{}\":\"{}\"",
                json_escape(&key),
                json_escape(&val)
            )
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
            } else {
                "application/octet-stream"
            };
            respond(req, bytes, ct);
        }
        Err(_) => server_error_status(req, "svelte asset not found (빌드했나요?)", 404),
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
