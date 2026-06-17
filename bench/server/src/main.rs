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
const REACT_DIST: &str = "../react/dist";

fn main() {
    let components = build_components();
    println!("적재된 컴포넌트: {:?}", components.keys().collect::<Vec<_>>());

    let server = Server::http(ADDR).expect("서버 시작 실패");
    println!("listening on http://{ADDR}");

    for req in server.incoming_requests() {
        let url = req.url().to_string();
        if url == "/" {
            respond(req, page().into_bytes(), "text/html; charset=utf-8");
        } else if url == "/runtime.js" {
            match fs::read(RUNTIME_JS) {
                Ok(b) => respond(req, b, "text/javascript; charset=utf-8"),
                Err(_) => not_found(req),
            }
        } else if let Some(name) = url
            .strip_prefix("/components/")
            .and_then(|n| n.strip_suffix(".qubb"))
        {
            match components.get(name) {
                Some(bytes) => respond(req, bytes.clone(), "application/octet-stream"),
                None => not_found(req),
            }
        } else if let Some(name) = url.strip_prefix("/ssr/") {
            match components.get(name) {
                Some(bytes) => match renderer::render_to_string(bytes, 0) {
                    Ok(html) => respond(req, html.into_bytes(), "text/html; charset=utf-8"),
                    Err(e) => server_error(req, format!("렌더 실패: {e:?}")),
                },
                None => not_found(req),
            }
        } else if url.starts_with("/react/") {
            serve_react_asset(req, &url);
        } else if url.starts_with("/img/") {
            // 예제 상품 이미지는 전부 플레이스홀더 한 장으로.
            serve_public(req, "placeholder.svg");
        } else if let Some(rel) = url.strip_prefix("/public/") {
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

/// index.html을 읽어 React 빌드 엔트리 경로만 치환해 반환.
fn page() -> String {
    let html = fs::read_to_string("index.html").expect("index.html 읽기 실패");
    html.replace("{{REACT_ENTRY}}", &react_entry_path())
}

/// React 빌드의 해시된 엔트리 파일명을 찾아 /react/ 경로로. 없으면 about:blank.
fn react_entry_path() -> String {
    let dir = format!("{REACT_DIST}/assets");
    let entry = fs::read_dir(&dir).ok().and_then(|rd| {
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| n.starts_with("index-") && n.ends_with(".js"))
    });
    match entry {
        Some(name) => format!("/react/assets/{name}"),
        None => "about:blank".to_string(),
    }
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
