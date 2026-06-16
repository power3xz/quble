//! 루트 크레이트: 컴파일러와 VM을 잇는 통합 지점.

#[derive(Debug)]
pub enum RenderError {
    Compile(compiler::CompileError),
    Vm(vm::VmError),
}

/// .qubc 소스를 컴파일하고 comp_id를 진입점으로 렌더해 HTML을 만든다.
pub fn render_source(src: &str, comp_id: u16) -> Result<String, RenderError> {
    let bytecode = compiler::compile(src).map_err(RenderError::Compile)?;
    vm::render(&bytecode, comp_id).map_err(RenderError::Vm)
}
