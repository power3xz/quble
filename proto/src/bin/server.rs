//! 프로토타입 HTTP 서버. 두 케이스를 보여준다.
//!  - GET /                      : 서버 SSR(hello) + 클라가 grid·article을 qubb로 받아 렌더.
//!  - GET /component/<name>.qubb : examples/<name>.qubc를 컴파일한 qubb 바이트 응답.
//!  - GET /vm.js                 : 클라이언트 JS VM.
//!
//! 실행: cargo run --bin server  → http://localhost:7878

use std::fs;
use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;
use tiny_http::{Header, Request, Response, Server};

const ADDR: &str = "127.0.0.1:7878";

fn main() {
    let server = Server::http(ADDR).expect("서버 시작 실패");
    println!("listening on http://{ADDR}");

    for req in server.incoming_requests() {
        let url = req.url().to_string();
        if url == "/" {
            respond(req, page().into_bytes(), "text/html; charset=utf-8");
        } else if url == "/vm.js" {
            respond(
                req,
                fs::read("web/vm.js").unwrap(),
                "text/javascript; charset=utf-8",
            );
        } else if let Some(name) = url
            .strip_prefix("/component/")
            .and_then(|s| s.strip_suffix(".qubb"))
        {
            match component_bytecode(name) {
                Some(bytes) => respond(req, bytes, "application/octet-stream"),
                None => {
                    let _ = req
                        .respond(Response::from_string("no such component").with_status_code(404));
                }
            }
        } else if url.starts_with("/react/") {
            serve_react_asset(req, &url);
        } else {
            let _ = req.respond(Response::from_string("not found").with_status_code(404));
        }
    }
}

/// examples/<name>.qubc를 컴파일해 qubb 바이트로. 없으면 None.
fn component_bytecode(name: &str) -> Option<Vec<u8>> {
    // 경로 주입 방지: 단순 이름만 허용.
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let src = fs::read_to_string(format!("examples/{name}.qubc")).ok()?;
    Some(compiler::compile(&src).expect("컴파일 실패").into_vec())
}

/// React 빌드의 해시된 엔트리 파일명을 찾아 /react/ 경로로. 없으면 빈 경로.
fn react_entry_path() -> String {
    let dir = "../bench/react/dist/assets";
    let entry = fs::read_dir(dir).ok().and_then(|rd| {
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| n.starts_with("index-") && n.ends_with(".js"))
    });
    match entry {
        Some(name) => format!("/react/assets/{name}"),
        None => "about:blank".to_string(),
    }
}

/// React 빌드 산출물(bench/react/dist)을 /react/ 아래로 서빙. 비교용.
fn serve_react_asset(req: tiny_http::Request, url: &str) {
    let rel = url.trim_start_matches("/react/");
    // 경로 탈출 방지.
    if rel.contains("..") {
        let _ = req.respond(Response::from_string("bad path").with_status_code(400));
        return;
    }
    let path = format!("../bench/react/dist/{rel}");
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
        Err(_) => {
            let _ = req.respond(
                Response::from_string("react asset not found (빌드했나요?)").with_status_code(404),
            );
        }
    }
}

/// 페이지: 서버 SSR(hello) + 클라이언트가 grid·article을 qubb로 받아 실제 DOM 렌더.
fn page() -> String {
    let src = fs::read_to_string("examples/hello.qubc").unwrap();
    let ssr_html = quble::render_source(&src, 0).expect("SSR 렌더 실패");
    let react_entry = react_entry_path();

    format!(
        r#"<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8"><title>Quble proto</title>
  <style>
    body {{ font-family: system-ui, sans-serif; max-width: 1400px; margin: 1.5rem auto; padding: 0 1rem; }}
    .cols {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; align-items: start; }}
    .col {{ border: 1px solid #e3e3e3; border-radius: 10px; padding: 1rem; }}
    .col h2.head {{ margin: 0 0 .2rem; }}
    .col .badge-quble {{ color: #0a7; }} .col .badge-react {{ color: #61dafb; }}
    .col .size {{ font-size: .85rem; color: #555; margin: 0 0 1rem; font-family: ui-monospace, monospace; }}
    .grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: .7rem; }}
    .card {{ border: 1px solid #ddd; border-radius: 8px; padding: .6rem; position: relative; }}
    .thumb img {{ width: 100%; height: 70px; object-fit: cover; background: #f3f3f3; border-radius: 4px; }}
    .badge {{ position: absolute; top: .4rem; right: .4rem; background: #111; color: #fff; font-size: .65rem; padding: .1rem .4rem; border-radius: 4px; }}
    .name {{ font-size: .82rem; margin: .4rem 0 .3rem; }}
    .meta {{ display: flex; gap: .4rem; font-size: .7rem; color: #666; flex-wrap: wrap; }}
    .price {{ color: #c00; font-weight: bold; }}
    .buy {{ margin-top: .4rem; width: 100%; padding: .35rem; cursor: pointer; font-size: .75rem; }}
    .post {{ line-height: 1.7; }} .post .meta {{ color: #888; }}
    h1.section {{ border-bottom: 2px solid #eee; padding-bottom: .3rem; margin-top: 2rem; }}
  </style>
</head>
<body>
  <h1 class="section">서버 SSR (Rust VM)</h1>
  <div id="ssr">{ssr_html}</div>

  <h1 class="section">좌우 비교 — 같은 컴포넌트, Quble vs React</h1>
  <div class="cols">
    <div class="col">
      <h2 class="head"><span class="badge-quble">● Quble</span></h2>
      <p class="size">전송: <span id="q-size">측정 중…</span> (qubb 바이트코드, JS VM 렌더)</p>
      <div id="q-grid">로딩 중…</div>
      <div id="q-article" style="margin-top:1rem"></div>
    </div>
    <div class="col">
      <h2 class="head"><span class="badge-react">● React</span></h2>
      <p class="size">전송: <span id="r-size">측정 중…</span> (lazy chunk, +최초 런타임 46KB)</p>
      <div id="root">React 로딩 중…</div>
    </div>
  </div>

  <script type="module">
    import {{ renderComponent }} from "/vm.js";
    async function mount(name, slotId) {{
      const res = await fetch(`/component/${{name}}.qubb`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      document.getElementById(slotId).replaceChildren(renderComponent(bytes, 0));
    }}
    await mount("grid", "q-grid");
    await mount("article", "q-article");
  </script>

  <!-- React: 자체 번들이 #root에 ProductGrid·Article을 lazy 로드해 렌더 -->
  <script type="module" src="{react_entry}"></script>
  <script>
    // 양쪽 전송량을 Resource Timing으로 동일 기준 집계 (raw=decodedBodySize, 전송=transferSize=gzip).
    function sumBy(re) {{
      const es = performance.getEntriesByType("resource").filter(e => re.test(e.name));
      return {{
        raw: es.reduce((s, e) => s + (e.decodedBodySize || 0), 0),
        wire: es.reduce((s, e) => s + (e.transferSize || 0), 0),
      }};
    }}
    function fmt(s) {{ return `raw ${{s.raw}} B / 전송(gz) ${{s.wire}} B`; }}
    window.addEventListener("load", () => setTimeout(() => {{
      document.getElementById("q-size").textContent =
        fmt(sumBy(/\/component\/(grid|article)\.qubb/));
      document.getElementById("r-size").textContent =
        fmt(sumBy(/\/react\/assets\/(ProductGrid|Article)-/)) + " (+런타임 별도)";
    }}, 1000));
  </script>
</body>
</html>"#
    )
}

/// 클라이언트가 gzip을 받으면 압축해 응답하고, 아니면 raw로. 실전송(gz) 비교가 가능해진다.
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
