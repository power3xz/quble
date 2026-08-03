//! 브라우저에서 도는 컴파일러(playground). wasm-bindgen 없이 extern "C"만으로 ABI를 낸다.
//!
//! 호출 순서:
//!   1. `qb_alloc(len)`으로 버퍼를 받아 JS가 UTF-8 바이트를 써넣는다.
//!   2. `qb_reset()` 후 파일마다 `qb_add_file(path, src)` - 탭 하나가 파일 하나.
//!   3. `qb_compile(entry)` -> 0=성공, 1=실패.
//!   4. `qb_out_ptr()`/`qb_out_len()`으로 결과를 읽는다. 성공이면 qubb 바이트,
//!      실패면 진단 텍스트(UTF-8). 다음 `qb_compile`까지 유효하다.
//!   5. 성공이면 `qb_res_ptr()`/`qb_res_len()`으로 리소스 경로 목록(개행 구분, resId 순)을
//!      읽는다. JS가 그 순서대로 Blob URL을 만들어 런타임 `compile(bytes, resources)`에 넘긴다.
//!
//! `qb_handler_names(entry)`(개행으로 이은 fullname)와 `qb_handlers_dts(entry)`(핸들러 타입
//! .d.ts 텍스트)도 2번까지는 같은 순서를 쓰고 결과를 out 슬롯에 놓는다. 셋 다 슬롯을
//! 공유하므로 번갈아 부르면 앞의 결과가 지워진다 - 읽고 나서 다음을 부른다.
//!
//! 경로 의미론은 컴파일러가 모른다(flatten.rs 머리주석) - loader가 정규화 책임을 진다.
//! playground의 파일 이름 공간은 평탄해서(탭 목록) `./` 접두어만 벗기면 등록된 이름과 맞는다.
//!
//! wasm은 단일 스레드라 thread_local 하나가 사실상 전역이다. 상태를 여기 모아 두면
//! export 함수들이 unsafe 없이(포인터를 받는 자리만 예외) 돌아간다.

use std::cell::RefCell;

/// 등록된 파일과 마지막 컴파일 결과. wasm 인스턴스 하나가 곧 세션 하나다.
struct State {
    /// (정규화 경로, 소스). playground 탭 이름을 그대로 경로로 쓴다.
    files: Vec<(String, String)>,
    /// 마지막 `qb_compile` 결과. 성공이면 qubb, 실패면 진단 텍스트의 UTF-8 바이트.
    out: Vec<u8>,
    /// 마지막 성공 컴파일의 리소스 경로들을 개행으로 이은 것(resId 순). 실패면 빈다.
    /// 런타임 `compile(bytes, resources)`의 resources는 resId -> URL 배열이라, JS가 이 순서대로
    /// 각 경로의 내용을 Blob URL로 만들어 넘긴다. 경로에 개행은 안 들어간다.
    res: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State {
        files: Vec::new(),
        out: Vec::new(),
        res: Vec::new(),
    }) };
}

/// JS가 소스를 써넣을 버퍼를 wasm 메모리에 확보한다. 반환 포인터는 `qb_free`로 돌려주거나
/// `qb_add_file`/`qb_compile`에 넘긴다(그 함수들은 읽기만 하고 해제하지 않는다).
#[no_mangle]
pub extern "C" fn qb_alloc(len: usize) -> *mut u8 {
    // Vec의 버퍼를 그대로 빌려준다 - 길이를 len으로 맞춰 두면 qb_free가 같은 레이아웃으로 되돌린다.
    let mut buf = vec![0u8; len];
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// `qb_alloc`으로 받은 버퍼를 해제한다. len은 alloc에 넘긴 값과 같아야 한다.
///
/// # Safety
/// ptr/len은 `qb_alloc`이 돌려준 그 쌍이어야 하고, 한 번만 넘겨야 한다.
#[no_mangle]
pub unsafe extern "C" fn qb_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len, len));
}

/// 등록된 파일을 모두 비운다. 컴파일 전 탭 목록을 다시 심을 때 호출한다.
#[no_mangle]
pub extern "C" fn qb_reset() {
    STATE.with(|s| s.borrow_mut().files.clear());
}

/// 파일 하나를 등록한다. 같은 경로를 다시 등록하면 소스를 덮어쓴다(탭 편집).
/// 경로/소스가 UTF-8이 아니면 조용히 무시한다 - JS가 문자열을 인코딩해 넘기므로 일어나지 않는다.
///
/// # Safety
/// 두 포인터는 각자 len 바이트만큼 읽을 수 있어야 한다.
#[no_mangle]
pub unsafe extern "C" fn qb_add_file(
    path_ptr: *const u8,
    path_len: usize,
    src_ptr: *const u8,
    src_len: usize,
) {
    let path = match str_from(path_ptr, path_len) {
        Some(p) => p.to_string(),
        None => return,
    };
    let src = match str_from(src_ptr, src_len) {
        Some(s) => s.to_string(),
        None => return,
    };
    STATE.with(|s| {
        let files = &mut s.borrow_mut().files;
        match files.iter_mut().find(|(p, _)| *p == path) {
            Some(slot) => slot.1 = src,
            None => files.push((path, src)),
        }
    });
}

/// 등록된 파일 중 entry를 엔트리로 컴파일한다. 0=성공(out=qubb), 1=실패(out=진단 텍스트).
/// entry가 등록돼 있지 않아도 1을 내며 그 사실을 진단으로 낸다.
///
/// # Safety
/// entry_ptr은 entry_len 바이트만큼 읽을 수 있어야 한다.
#[no_mangle]
pub unsafe extern "C" fn qb_compile(entry_ptr: *const u8, entry_len: usize) -> u32 {
    let entry = match str_from(entry_ptr, entry_len) {
        Some(path) => path.to_string(),
        None => {
            set_out(b"entry path is not valid UTF-8".to_vec());
            return 1;
        }
    };
    STATE.with(|s| {
        // 컴파일 중에도 loader가 files를 읽어야 해 borrow를 겹치지 않게 소스를 먼저 복사한다.
        let files = s.borrow().files.clone();
        let entry_src = match files.iter().find(|(p, _)| *p == entry) {
            Some((_, src)) => src.clone(),
            None => {
                let mut state = s.borrow_mut();
                state.out = format!("no such file: {entry}").into_bytes();
                state.res.clear();
                return 1;
            }
        };
        // loader: `./x.qubc`의 `./`만 벗겨 등록된 이름과 맞춘다. 탭 이름 공간이 평탄해
        // base(어느 파일이 use했는지)는 볼 것이 없다.
        let loader = |_base: &str, target: &str| {
            let name = target.strip_prefix("./").unwrap_or(target);
            files
                .iter()
                .find(|(p, _)| p == name)
                .map(|(p, src)| (p.clone(), src.clone()))
        };
        let (out, res, status) = match compiler::compile_src(&entry, &entry_src, &loader) {
            Ok(output) => (
                output.bytecode.into_vec(),
                output.resources.join("\n").into_bytes(),
                0,
            ),
            Err(err) => {
                // base_dir=None - 가상 경로라 줄일 기준이 없다(compiler::format_error 주석).
                (
                    compiler::format_error(None, &entry, &entry_src, &err).into_bytes(),
                    Vec::new(),
                    1,
                )
            }
        };
        let mut state = s.borrow_mut();
        state.out = out;
        state.res = res;
        status
    })
}

/// 등록된 파일 중 entry의 핸들러 fullname 목록을 낸다. 0=성공(out=개행으로 이은 이름들),
/// 1=실패(out=진단 텍스트). 이름이 없으면 성공이되 out이 빈다.
///
/// 에디터 자동완성이 편집 중에 계속 부르는 자리다 - codegen까지 가지 않고 평탄화한 AST만
/// 걸으므로 `qb_compile`보다 가볍다.
///
/// # Safety
/// entry_ptr은 entry_len 바이트만큼 읽을 수 있어야 한다.
#[no_mangle]
pub unsafe extern "C" fn qb_handler_names(entry_ptr: *const u8, entry_len: usize) -> u32 {
    with_entry_src(entry_ptr, entry_len, |entry, src, loader| {
        compiler::handler_names_src(entry, src, loader).map(|names| names.join("\n").into_bytes())
    })
}

/// 등록된 파일 중 entry의 핸들러 타입(.d.ts 텍스트)을 낸다. 0=성공(out=d.ts), 1=실패(out=진단).
///
/// 짝 핸들러 파일에 타입을 붙이는 쪽(에디터)이 쓴다 - 바이너리(quble-dts)를 띄우지 않고
/// 같은 프로세스에서 부르려고 여기에 낸다.
///
/// # Safety
/// entry_ptr은 entry_len 바이트만큼 읽을 수 있어야 한다.
#[no_mangle]
pub unsafe extern "C" fn qb_handlers_dts(entry_ptr: *const u8, entry_len: usize) -> u32 {
    with_entry_src(entry_ptr, entry_len, |entry, src, loader| {
        compiler::handlers_dts_src(entry, src, loader).map(String::into_bytes)
    })
}

/// `qb_add_file`로 등록된 파일들에서 `use` 대상을 찾는 loader. 클로저가 아니라 이름 있는 타입인
/// 이유는 with_entry_src가 이걸 만들어 콜백에 넘기기 때문이다 - 클로저는 저마다 타입이 달라
/// 호출자가 고르는 제네릭으로 묶이지 않는다.
struct RegisteredFiles<'a>(&'a [(String, String)]);

impl compiler::SourceLoader for RegisteredFiles<'_> {
    /// wasm은 디렉터리가 없어 base를 안 본다 - 등록된 이름으로 곧장 맞춘다(`./` 접두는 뗀다).
    fn load(&self, _base: &str, target: &str) -> Option<(String, String)> {
        let name = target.strip_prefix("./").unwrap_or(target);
        self.0
            .iter()
            .find(|(path, _)| path == name)
            .map(|(path, src)| (path.clone(), src.clone()))
    }
}

/// entry 경로를 읽고 등록된 파일에서 그 소스를 찾아 `run`에 넘긴다. 결과는 out 슬롯에 놓고
/// 상태를 돌려준다 - 소스를 받아 텍스트를 내는 함수들(handler_names/handlers_dts)의 공통부다.
/// loader는 등록된 파일 목록에서 `use` 대상을 찾는다(`./` 접두는 떼고 이름으로 맞춘다).
///
/// # Safety
/// entry_ptr은 entry_len 바이트만큼 읽을 수 있어야 한다.
unsafe fn with_entry_src<R>(entry_ptr: *const u8, entry_len: usize, run: R) -> u32
where
    R: FnOnce(&str, &str, &RegisteredFiles) -> Result<Vec<u8>, compiler::CompileError>,
{
    let entry = match str_from(entry_ptr, entry_len) {
        Some(path) => path.to_string(),
        None => {
            set_out(b"entry path is not valid UTF-8".to_vec());
            return 1;
        }
    };
    STATE.with(|s| {
        let files = s.borrow().files.clone();
        let entry_src = match files.iter().find(|(p, _)| *p == entry) {
            Some((_, src)) => src.clone(),
            None => {
                set_out(format!("no such file: {entry}").into_bytes());
                return 1;
            }
        };
        let loader = RegisteredFiles(&files);
        let (out, status) = match run(&entry, &entry_src, &loader) {
            Ok(bytes) => (bytes, 0),
            Err(err) => (
                compiler::format_error(None, &entry, &entry_src, &err).into_bytes(),
                1,
            ),
        };
        set_out(out);
        status
    })
}

/// 마지막 컴파일 결과의 시작 주소. 다음 `qb_compile`까지 유효하다.
#[no_mangle]
pub extern "C" fn qb_out_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().out.as_ptr())
}

/// 마지막 컴파일 결과의 바이트 길이.
#[no_mangle]
pub extern "C" fn qb_out_len() -> usize {
    STATE.with(|s| s.borrow().out.len())
}

/// 마지막 성공 컴파일의 리소스 경로 목록(개행 구분, resId 순)의 시작 주소.
/// 실패한 컴파일 뒤에는 길이 0이다.
#[no_mangle]
pub extern "C" fn qb_res_ptr() -> *const u8 {
    STATE.with(|s| s.borrow().res.as_ptr())
}

/// 리소스 경로 목록의 바이트 길이. 0이면 리소스가 없거나 컴파일이 실패한 것이다.
#[no_mangle]
pub extern "C" fn qb_res_len() -> usize {
    STATE.with(|s| s.borrow().res.len())
}

/// 결과 슬롯을 덮어쓴다(실패 경로) - 리소스 목록도 함께 비운다.
fn set_out(bytes: Vec<u8>) {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.out = bytes;
        state.res.clear();
    });
}

/// 포인터/길이를 &str로. UTF-8이 아니면 None.
///
/// # Safety
/// ptr은 len 바이트만큼 읽을 수 있어야 한다.
unsafe fn str_from<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 파일 등록을 JS가 하는 것과 같은 경로(포인터+길이)로 태운다.
    fn add_file(path: &str, src: &str) {
        unsafe {
            qb_add_file(path.as_ptr(), path.len(), src.as_ptr(), src.len());
        }
    }

    /// 컴파일하고 (상태, 결과 바이트)를 돌려준다. 결과는 out 슬롯을 ptr/len으로 읽어
    /// JS가 보는 것과 같은 바이트를 확인한다.
    fn compile(entry: &str) -> (u32, Vec<u8>) {
        let status = unsafe { qb_compile(entry.as_ptr(), entry.len()) };
        let out = unsafe { std::slice::from_raw_parts(qb_out_ptr(), qb_out_len()) }.to_vec();
        (status, out)
    }

    /// 핸들러 이름을 뽑고 (상태, 목록)을 돌려준다. out 슬롯을 JS와 같은 방식으로 읽어 쪼갠다.
    fn handler_names(entry: &str) -> (u32, Vec<String>) {
        let status = unsafe { qb_handler_names(entry.as_ptr(), entry.len()) };
        let out = unsafe { std::slice::from_raw_parts(qb_out_ptr(), qb_out_len()) };
        let names = match std::str::from_utf8(out).unwrap() {
            "" => Vec::new(),
            text => text.split('\n').map(str::to_string).collect(),
        };
        (status, names)
    }

    /// 리소스 슬롯을 JS와 같은 방식으로 읽어 경로 목록으로 쪼갠다. 빈 슬롯은 빈 목록.
    fn resources() -> Vec<String> {
        let bytes = unsafe { std::slice::from_raw_parts(qb_res_ptr(), qb_res_len()) };
        match std::str::from_utf8(bytes).unwrap() {
            "" => Vec::new(),
            text => text.split('\n').map(str::to_string).collect(),
        }
    }

    /// 테스트는 한 프로세스에서 thread_local 상태를 공유한다 - cargo test가 스레드마다
    /// 따로 돌려 서로 안 섞이지만, 같은 스레드에서 이어 도는 경우를 위해 매번 비운다.
    fn reset() {
        qb_reset();
    }

    /// qubb 매직(bytecode::serialize의 MAGIC) - 성공 산출물이 바이트코드인지 보는 표식.
    const QUBB_MAGIC: &[u8] = b"QBL\0";

    const HELLO: &str = r#"
        component Hello {
          template { h1() { "hi" } }
        }
    "#;

    /// 단일 파일이 컴파일돼 qubb 바이트가 나온다. 앞 4바이트는 매직.
    #[test]
    fn compiles_single_file() {
        reset();
        add_file("main.qubc", HELLO);
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 0, "성공이어야: {}", String::from_utf8_lossy(&out));
        assert_eq!(&out[..4], QUBB_MAGIC, "qubb 매직으로 시작해야");
    }

    /// `use`로 엮인 두 파일이 한 모듈로 평탄화된다 - loader가 `./` 접두어를 벗겨
    /// 등록된 탭 이름과 맞추는 경로.
    #[test]
    fn compiles_use_graph() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use Card from "./card.qubc"
            component Main { template { Card( /) } }
        "#,
        );
        add_file(
            "card.qubc",
            r#"component Card { template { p() { "card" } } }"#,
        );
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 0, "성공이어야: {}", String::from_utf8_lossy(&out));
        assert_eq!(&out[..4], QUBB_MAGIC);
    }

    /// `./` 없이 쓴 use도 같은 탭을 가리킨다(loader가 접두어만 벗기므로 양쪽 다 맞는다).
    #[test]
    fn use_without_dot_prefix_resolves() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use Card from "card.qubc"
            component Main { template { Card( /) } }
        "#,
        );
        add_file(
            "card.qubc",
            r#"component Card { template { p() { "card" } } }"#,
        );
        let (status, _) = compile("main.qubc");
        assert_eq!(status, 0);
    }

    /// 문법 오류는 status=1 + 진단 텍스트. 위치(라인)와 밑줄이 실려야 에디터가 쓸 수 있다.
    #[test]
    fn syntax_error_returns_diagnostic() {
        reset();
        add_file("main.qubc", "component C { template { div() { } ");
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 1, "실패여야");
        let text = String::from_utf8(out).expect("진단은 UTF-8이어야");
        assert!(text.contains("main.qubc"), "파일명이 있어야: {text}");
        assert!(text.contains("error:"), "error: 가 있어야: {text}");
    }

    /// use가 등록 안 된 파일을 가리키면 실패하고 그 사실이 진단에 나온다.
    #[test]
    fn missing_use_target_errors() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use Card from "./nope.qubc"
            component Main { template { Card( /) } }
        "#,
        );
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 1);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("nope.qubc"), "못 찾은 대상이 나와야: {text}");
    }

    /// 등록 안 된 엔트리는 컴파일 자체가 안 된다(진단에 이름이 나온다).
    #[test]
    fn unknown_entry_errors() {
        reset();
        add_file("main.qubc", HELLO);
        let (status, out) = compile("other.qubc");
        assert_eq!(status, 1);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("other.qubc"), "엔트리 이름이 나와야: {text}");
    }

    /// 같은 경로를 다시 등록하면 소스를 덮어쓴다(탭 편집) - 파일이 늘지 않고 새 내용이 쓰인다.
    #[test]
    fn re_adding_path_overwrites_source() {
        reset();
        add_file("main.qubc", "component C { template { BROKEN");
        assert_eq!(compile("main.qubc").0, 1, "처음엔 깨진 소스라 실패");
        add_file("main.qubc", HELLO);
        let (status, out) = compile("main.qubc");
        assert_eq!(
            status,
            0,
            "덮어쓴 뒤엔 성공: {}",
            String::from_utf8_lossy(&out)
        );
        STATE.with(|s| assert_eq!(s.borrow().files.len(), 1, "파일이 늘지 않아야"));
    }

    /// reset은 등록을 비운다 - 이전 탭이 다음 컴파일에 남지 않는다.
    #[test]
    fn reset_clears_files() {
        reset();
        add_file("main.qubc", HELLO);
        assert_eq!(compile("main.qubc").0, 0);
        reset();
        assert_eq!(compile("main.qubc").0, 1, "reset 뒤엔 엔트리가 없어야");
    }

    /// 실패 뒤 성공하면 out 슬롯이 진단 텍스트가 아니라 qubb로 바뀐다(슬롯 재사용 회귀).
    #[test]
    fn out_slot_replaced_between_compiles() {
        reset();
        add_file("bad.qubc", "component C { template {");
        let (_, err_out) = compile("bad.qubc");
        assert!(!err_out.starts_with(QUBB_MAGIC));
        add_file("good.qubc", HELLO);
        let (status, out) = compile("good.qubc");
        assert_eq!(status, 0);
        assert_eq!(&out[..4], QUBB_MAGIC, "이전 진단이 남으면 안 된다");
    }

    /// `use "./x.css"`가 있으면 리소스 슬롯에 그 경로가 resId 순으로 실린다 - JS가 이 순서대로
    /// Blob URL을 만들어 런타임에 넘긴다. css도 loader를 거치므로 탭으로 등록돼 있어야 한다.
    #[test]
    fn resource_paths_exposed_in_order() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use "./a.css"
            use "./b.css"
            component Main { template { div( /) } }
        "#,
        );
        add_file("a.css", "div { color: red }");
        add_file("b.css", "div { color: blue }");
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 0, "성공이어야: {}", String::from_utf8_lossy(&out));
        assert_eq!(
            resources(),
            vec!["a.css", "b.css"],
            "선언 순서 = resId 순서",
        );
    }

    /// 등록 안 된 css를 use하면 실패한다(css도 loader를 탄다) - 탭이 없으면 컴파일 자체가 안 된다.
    #[test]
    fn missing_css_errors() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use "./nope.css"
            component Main { template { div( /) } }
        "#,
        );
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 1);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("nope.css"), "못 찾은 css가 나와야: {text}");
    }

    /// 리소스가 없으면 슬롯이 비어 있다(빈 목록).
    #[test]
    fn no_resources_leaves_slot_empty() {
        reset();
        add_file("main.qubc", HELLO);
        assert_eq!(compile("main.qubc").0, 0);
        assert_eq!(qb_res_len(), 0, "리소스 없으면 빈 슬롯");
        assert!(resources().is_empty());
    }

    /// 실패한 컴파일은 이전 성공의 리소스 목록을 남기지 않는다 - JS가 낡은 목록으로
    /// Blob URL을 만들면 엉뚱한 css가 붙는다.
    #[test]
    fn failed_compile_clears_resources() {
        reset();
        add_file(
            "styled.qubc",
            r#"
            use "./a.css"
            component Styled { template { div( /) } }
        "#,
        );
        add_file("a.css", "div { color: red }");
        assert_eq!(compile("styled.qubc").0, 0);
        assert_eq!(resources(), vec!["a.css"]);

        add_file("broken.qubc", "component C { template {");
        assert_eq!(compile("broken.qubc").0, 1);
        assert!(resources().is_empty(), "실패 뒤엔 리소스가 비어야");
    }

    /// alloc/free 왕복 - JS가 소스를 써넣는 경로. 받은 버퍼는 len만큼 쓰기 가능하고
    /// 0으로 초기화돼 있다.
    #[test]
    fn alloc_gives_writable_zeroed_buffer() {
        let len = 32;
        let ptr = qb_alloc(len);
        assert!(!ptr.is_null());
        unsafe {
            let buf = std::slice::from_raw_parts_mut(ptr, len);
            assert!(buf.iter().all(|&b| b == 0), "0으로 초기화돼야");
            buf.copy_from_slice(&[7u8; 32]);
            assert_eq!(buf[31], 7);
            qb_free(ptr, len);
        }
    }

    /// 이름 목록이 fullname으로 나온다 - use로 엮인 자식의 이벤트도 use-site 경로가 붙는다.
    #[test]
    fn handler_names_are_fullnames() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use Card from "./card.qubc"
            component Main {
              props { x: string }
              events { ADD({ x }) }
              template {
                button(@click:ADD /)
                @for (item of 3) { Ticket: Card( /) }
              }
            }
        "#,
        );
        add_file(
            "card.qubc",
            r#"
            component Card {
              props { id: string }
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#,
        );
        let (status, names) = handler_names("main.qubc");
        assert_eq!(status, 0, "성공이어야: {names:?}");
        assert_eq!(names, vec!["ADD", "Ticket[$0].PICK"]);
    }

    /// 이벤트가 없으면 성공이되 빈 목록(빈 슬롯) - 후보 없음은 에러가 아니다.
    #[test]
    fn handler_names_empty_when_no_events() {
        reset();
        add_file("main.qubc", HELLO);
        let (status, names) = handler_names("main.qubc");
        assert_eq!(status, 0);
        assert!(names.is_empty(), "실제: {names:?}");
    }

    /// 문법이 깨지면 1 + 진단 텍스트. 편집 중 계속 부르는 자리라 실패가 정상 경로다.
    #[test]
    fn handler_names_syntax_error_returns_diagnostic() {
        reset();
        add_file("main.qubc", "component C { template {");
        let (status, _) = handler_names("main.qubc");
        assert_eq!(status, 1);
        let out = unsafe { std::slice::from_raw_parts(qb_out_ptr(), qb_out_len()) };
        let text = std::str::from_utf8(out).unwrap();
        assert!(text.contains("main.qubc"), "파일명이 있어야: {text}");
    }

    /// 등록 안 된 엔트리는 1 + 그 이름이 진단에 나온다.
    #[test]
    fn handler_names_unknown_entry_errors() {
        reset();
        add_file("main.qubc", HELLO);
        let (status, _) = handler_names("other.qubc");
        assert_eq!(status, 1);
        let out = unsafe { std::slice::from_raw_parts(qb_out_ptr(), qb_out_len()) };
        assert!(std::str::from_utf8(out).unwrap().contains("other.qubc"));
    }

    /// out 슬롯을 컴파일과 공유한다 - 이름을 뽑은 뒤 컴파일하면 슬롯이 qubb로 바뀐다.
    /// JS가 둘을 번갈아 부를 때 앞의 결과를 들고 있으면 안 된다는 계약(머리주석)의 회귀.
    #[test]
    fn handler_names_shares_out_slot_with_compile() {
        reset();
        add_file(
            "main.qubc",
            r#"
            component Main {
              props { x: string }
              events { ADD({ x }) }
              template { button(@click:ADD /) }
            }
        "#,
        );
        assert_eq!(handler_names("main.qubc").1, vec!["ADD"]);
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 0);
        assert_eq!(&out[..4], QUBB_MAGIC, "이름 목록이 남으면 안 된다");
    }

    /// 핸들러 d.ts를 내고 (상태, 텍스트)를 돌려준다. out 슬롯을 JS와 같은 방식으로 읽는다.
    fn handlers_dts(entry: &str) -> (u32, String) {
        let status = unsafe { qb_handlers_dts(entry.as_ptr(), entry.len()) };
        let out = unsafe { std::slice::from_raw_parts(qb_out_ptr(), qb_out_len()) };
        (status, std::str::from_utf8(out).unwrap().to_string())
    }

    /// 합성 트리를 걸어 fullname마다 시그니처를 낸다 - 이름만 내는 handler_names와 달리
    /// payload/props까지 타입으로 나온다.
    #[test]
    fn handlers_dts_emits_typed_interface() {
        reset();
        add_file(
            "main.qubc",
            r#"
            component Main {
              props { x: string, tags: string[] }
              events { ADD({ x }) }
              template { button(@click:ADD /) }
            }
        "#,
        );
        let (status, text) = handlers_dts("main.qubc");
        assert_eq!(status, 0, "성공이어야: {text}");
        assert!(text.contains("export interface Handlers {"), "실제: {text}");
        assert!(
            text.contains(
                "'ADD': Handler<{ x: string }, { x: LeafIndex<string>; tags: LeafIndex<string[]> }"
            ),
            "실제: {text}"
        );
    }

    /// use 그래프를 등록된 파일로 해소해 자식 이벤트까지 낸다(loader가 도는지).
    #[test]
    fn handlers_dts_follows_use_graph() {
        reset();
        add_file(
            "main.qubc",
            r#"
            use Card from "./card.qubc"
            component Main {
              props { id: string }
              template { div() { Ticket: Card(id={id} /) } }
            }
        "#,
        );
        add_file(
            "card.qubc",
            r#"
            component Card {
              props { id: string }
              events { PICK({ id }) }
              template { button(@click:PICK /) }
            }
        "#,
        );
        let (status, text) = handlers_dts("main.qubc");
        assert_eq!(status, 0, "성공이어야: {text}");
        assert!(text.contains("'Ticket.PICK':"), "실제: {text}");
    }

    /// 문법이 깨지면 1 + 진단 텍스트. 편집 중 계속 부르는 자리라 실패가 정상 경로다.
    #[test]
    fn handlers_dts_syntax_error_returns_diagnostic() {
        reset();
        add_file("main.qubc", "component C { template {");
        let (status, text) = handlers_dts("main.qubc");
        assert_eq!(status, 1);
        assert!(text.contains("main.qubc"), "파일명이 있어야: {text}");
    }

    /// 등록 안 된 엔트리는 1 + 그 이름이 진단에 나온다.
    #[test]
    fn handlers_dts_unknown_entry_errors() {
        reset();
        add_file("main.qubc", HELLO);
        let (status, text) = handlers_dts("other.qubc");
        assert_eq!(status, 1);
        assert!(text.contains("other.qubc"), "실제: {text}");
    }

    /// out 슬롯을 컴파일과 공유한다 - d.ts를 낸 뒤 컴파일하면 슬롯이 qubb로 바뀐다.
    #[test]
    fn handlers_dts_shares_out_slot_with_compile() {
        reset();
        add_file(
            "main.qubc",
            r#"
            component Main {
              props { x: string }
              events { ADD({ x }) }
              template { button(@click:ADD /) }
            }
        "#,
        );
        assert!(handlers_dts("main.qubc").1.contains("'ADD':"));
        let (status, out) = compile("main.qubc");
        assert_eq!(status, 0);
        assert_eq!(&out[..4], QUBB_MAGIC, "d.ts 텍스트가 남으면 안 된다");
    }

    /// UTF-8이 아닌 경로/소스는 등록을 무시한다(파일이 늘지 않는다).
    #[test]
    fn invalid_utf8_add_is_ignored() {
        reset();
        let bad = [0xffu8, 0xfe];
        let src = "x";
        unsafe {
            qb_add_file(bad.as_ptr(), bad.len(), src.as_ptr(), src.len());
        }
        STATE.with(|s| assert_eq!(s.borrow().files.len(), 0, "등록되면 안 된다"));
    }
}
