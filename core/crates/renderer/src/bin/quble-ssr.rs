//! `quble-ssr <qubb> <data.json> [resource-url...]` - qubb를 data로 렌더한 HTML을 stdout에 낸다.
//! data 자리가 `-`면 표준 입력에서 읽는다. LOAD_RES가 만난 리소스 URL은 stderr에 `link: <url>`로
//! 한 줄씩 낸다.
//! `quble-ssr --snapshot <qubb> <data.json>` - HTML 대신 data를 심은 leaf store 스냅샷(JSON)을 낸다.

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let snapshot = args.first().map(String::as_str) == Some("--snapshot");
    if snapshot {
        args.remove(0);
    }
    if args.len() < 2 {
        eprintln!("usage: quble-ssr <qubb> <data.json> [resource-url...]");
        eprintln!("       quble-ssr <qubb> - [resource-url...]    (data를 표준 입력에서 읽는다)");
        eprintln!("       quble-ssr --snapshot <qubb> <data.json|->");
        return ExitCode::FAILURE;
    }
    let bytes = match std::fs::read(&args[0]) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read `{}`: {e}", args[0]);
            return ExitCode::FAILURE;
        }
    };
    let data = match args[1].as_str() {
        "-" => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).map(|_| s)
        }
        path => std::fs::read_to_string(path),
    };
    let data = match data {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot read `{}`: {e}", args[1]);
            return ExitCode::FAILURE;
        }
    };
    if snapshot {
        return match renderer::snapshot(&bytes, &data) {
            Ok(json) => {
                print!("{json}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("snapshot failed: {e:?}");
                ExitCode::FAILURE
            }
        };
    }
    match renderer::render(&bytes, &data, &args[2..]) {
        Ok(rendered) => {
            print!("{}", rendered.html);
            for link in rendered.links {
                eprintln!("link: {link}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("render failed: {e:?}");
            ExitCode::FAILURE
        }
    }
}
