//! 프로토타입 HTTP 서버. 두 케이스를 보여준다.
//!  - GET /                  : 서버 SSR. hello.qubc를 Rust VM으로 렌더해 HTML 페이지 응답.
//!  - GET /component/card.qubb : card.qubc를 컴파일한 qubb 바이트 응답 (클라가 fetch).
//!  - GET /vm.js              : 클라이언트 JS VM.
//!
//! 실행: cargo run --bin server  → http://localhost:7878

use std::fs;
use tiny_http::{Header, Response, Server};

const ADDR: &str = "127.0.0.1:7878";

fn main() {
    let server = Server::http(ADDR).expect("서버 시작 실패");
    println!("listening on http://{ADDR}");

    for req in server.incoming_requests() {
        match req.url() {
            "/" => respond_html(req, &page()),
            "/component/card.qubb" => respond_bytes(req, &card_bytecode()),
            "/vm.js" => respond_js(req, &fs::read_to_string("web/vm.js").unwrap()),
            _ => {
                let _ = req.respond(Response::from_string("not found").with_status_code(404));
            }
        }
    }
}

/// 케이스 1: 서버 SSR. hello를 Rust VM으로 렌더하고, 클라 스크립트를 끼운 HTML 페이지.
fn page() -> String {
    let src = fs::read_to_string("examples/hello.qubc").unwrap();
    let ssr_html = quble::render_source(&src, 0).expect("SSR 렌더 실패");

    format!(
        r#"<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>Quble proto</title></head>
<body>
  <h1>서버 SSR 결과 (case 1)</h1>
  <div id="ssr">{ssr_html}</div>

  <h1>클라이언트 렌더 결과 (case 2)</h1>
  <div id="client">로딩 중…</div>

  <script type="module">
    import {{ renderComponent }} from "/vm.js";
    const res = await fetch("/component/card.qubb");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const node = renderComponent(bytes, 0);      // qubb → 실제 DOM 노드
    const slot = document.getElementById("client");
    slot.replaceChildren(node);
  </script>
</body>
</html>"#
    )
}

/// 케이스 2 응답: card.qubc를 컴파일한 qubb 바이트.
fn card_bytecode() -> Vec<u8> {
    let src = fs::read_to_string("examples/card.qubc").unwrap();
    compiler::compile(&src).expect("card 컴파일 실패").into_vec()
}

fn respond_html(req: tiny_http::Request, body: &str) {
    let header = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
    let _ = req.respond(Response::from_string(body).with_header(header));
}

fn respond_js(req: tiny_http::Request, body: &str) {
    let header =
        Header::from_bytes(&b"Content-Type"[..], &b"text/javascript; charset=utf-8"[..]).unwrap();
    let _ = req.respond(Response::from_string(body).with_header(header));
}

fn respond_bytes(req: tiny_http::Request, body: &[u8]) {
    let header =
        Header::from_bytes(&b"Content-Type"[..], &b"application/octet-stream"[..]).unwrap();
    let _ = req.respond(Response::from_data(body).with_header(header));
}
