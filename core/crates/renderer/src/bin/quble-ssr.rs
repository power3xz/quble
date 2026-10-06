//! `quble-ssr <qubb> <data.json> [resource-url...]` - qubb를 data로 렌더한 HTML을 stdout에 낸다.
//! LOAD_RES가 만난 리소스 URL은 stderr에 `link: <url>`로 한 줄씩 낸다.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: quble-ssr <qubb> <data.json> [resource-url...]");
        return ExitCode::FAILURE;
    }
    let bytes = match std::fs::read(&args[0]) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read `{}`: {e}", args[0]);
            return ExitCode::FAILURE;
        }
    };
    let data = match std::fs::read_to_string(&args[1]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot read `{}`: {e}", args[1]);
            return ExitCode::FAILURE;
        }
    };
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
