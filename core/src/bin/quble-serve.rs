//! quble-serve: <path>(파일 또는 디렉토리)의 .qubc를 컴파일해 메모리에 적재하고, 산출물을
//! HTTP로 바로 서빙한다. dev용 - 디스크의 dist를 거치지 않고 전부 메모리에서 제공한다.
//!
//!  - GET /<name>.qubb         : 컴파일된 바이트코드.
//!  - GET /<name>.resmap.json  : resId -> 산출 리소스 경로(`res/...`) 사이드맵.
//!  - GET /res/<file>          : use한 CSS 자산(내용 해시 파일명).
//!
//! 사용: quble-serve <path> [--port <n>]   (기본 포트 9797)

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::ExitCode;

const DEFAULT_PORT: u16 = 9797;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut path = None;
    let mut port = DEFAULT_PORT;
    while let Some(arg) = args.next() {
        if arg == "--port" {
            match args.next().and_then(|p| p.parse().ok()) {
                Some(p) => port = p,
                None => {
                    eprintln!("--port 뒤에 포트 번호가 필요합니다");
                    return ExitCode::FAILURE;
                }
            }
        } else if path.is_none() {
            path = Some(arg);
        } else {
            eprintln!("인자가 너무 많습니다: {arg}");
            return ExitCode::FAILURE;
        }
    }
    let Some(path) = path else {
        eprintln!("usage: quble-serve <path> [--port <n>]");
        return ExitCode::FAILURE;
    };

    let loaded = match load(Path::new(&path)) {
        Ok(loaded) => loaded,
        Err(e) => {
            eprintln!("적재 실패: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut names = loaded.components.keys().cloned().collect::<Vec<_>>();
    names.sort();
    println!("적재된 컴포넌트: {names:?}");

    let addr = format!("127.0.0.1:{port}");
    let listener = match TcpListener::bind(&addr) {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("바인드 실패 {addr}: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("listening on http://{addr}");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle(stream, &loaded),
            Err(e) => eprintln!("커넥션 오류: {e}"),
        }
    }
    ExitCode::SUCCESS
}

/// 컴파일해 메모리에 적재한 산출물. 디스크에 떨구지 않고 전부 메모리에서 제공한다.
struct Loaded {
    /// name(확장자 제외) -> qubb 바이트.
    components: HashMap<String, Vec<u8>>,
    /// name -> resId별 산출 리소스 경로(`res/<hash>.css`).
    resmaps: HashMap<String, Vec<String>>,
    /// 산출 경로(`res/<hash>.css`) -> CSS 내용. `/res/...` 요청에 응답.
    assets: HashMap<String, Vec<u8>>,
}

/// path가 파일이면 그 하나, 디렉토리면 안의 *.qubc 전부를 컴파일해 적재한다.
fn load(path: &Path) -> std::io::Result<Loaded> {
    let mut loaded = Loaded {
        components: HashMap::new(),
        resmaps: HashMap::new(),
        assets: HashMap::new(),
    };
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry_path = entry?.path();
            if entry_path.extension().and_then(|s| s.to_str()) == Some("qubc") {
                load_one(&entry_path, &mut loaded)?;
            }
        }
    } else {
        load_one(path, &mut loaded)?;
    }
    Ok(loaded)
}

/// 단일 .qubc를 컴파일하고 use한 CSS를 내용 해시 경로로 적재한다.
fn load_one(path: &Path, loaded: &mut Loaded) -> std::io::Result<()> {
    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("out").to_string();
    // compile_file이 엔트리를 읽고 use는 importer 기준 상대경로로 해소한다.
    let output = compiler::compile_file(path.to_str().unwrap())
        .map_err(|e| std::io::Error::other(format!("컴파일 실패 {}: {e:?}", path.display())))?;

    let mut res_paths = Vec::with_capacity(output.resources.len());
    for origin in &output.resources {
        let content = std::fs::read(origin)?;
        // 산출 경로는 resmap 값이자 assets 키 - 둘이 같아야 클라가 받아온다. CLI 산출물과 동일하게
        // 상대경로(`res/...`)로 둔다(SSR 없이 raw resmap만 내주므로 절대경로가 필요 없다).
        let out_path = quble::asset_path(Path::new(origin), &content);
        loaded.assets.entry(out_path.clone()).or_insert(content);
        res_paths.push(out_path);
    }
    loaded.resmaps.insert(name.clone(), res_paths);
    loaded.components.insert(name, output.bytecode.into_vec());
    Ok(())
}

/// 커넥션 하나 처리. 요청 라인(`GET <path> HTTP/1.1`)의 경로만 보고 메모리에서 응답한다.
fn handle(mut stream: TcpStream, loaded: &Loaded) {
    let mut reader = BufReader::new(&mut stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // "GET /card.qubb HTTP/1.1" -> 가운데 토큰.
    let Some(target) = request_line.split_whitespace().nth(1) else {
        return;
    };

    let response = route(target, loaded);
    let (status, content_type, body) = response;
    // inspector 등 다른 origin에서 fetch 하므로 CORS 허용. dev 서버라 와일드카드.
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&body);
}

/// 경로를 라우팅해 (상태줄, Content-Type, 본문)을 만든다.
fn route(target: &str, loaded: &Loaded) -> (&'static str, &'static str, Vec<u8>) {
    if let Some(name) = target.strip_prefix('/').and_then(|n| n.strip_suffix(".qubb")) {
        if let Some(bytes) = loaded.components.get(name) {
            return ("200 OK", "application/octet-stream", bytes.clone());
        }
    } else if let Some(name) = target.strip_prefix('/').and_then(|n| n.strip_suffix(".resmap.json")) {
        if let Some(paths) = loaded.resmaps.get(name) {
            return ("200 OK", "application/json; charset=utf-8", quble::json_array(paths).into_bytes());
        }
    } else if let Some(key) = target.strip_prefix('/') {
        // /res/<file> - assets 키는 선행 '/' 없는 `res/...`.
        if key.starts_with("res/") {
            if let Some(content) = loaded.assets.get(key) {
                return ("200 OK", "text/css; charset=utf-8", content.clone());
            }
        }
    }
    ("404 Not Found", "text/plain; charset=utf-8", b"not found".to_vec())
}
