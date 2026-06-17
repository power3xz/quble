//! 루트 크레이트: 컴파일러와 렌더러를 잇는 통합 지점.

#[derive(Debug)]
pub enum RenderError {
    Compile(compiler::CompileError),
    Render(renderer::RenderError),
}

/// .qubc 소스를 컴파일하고 comp_id를 진입점으로 렌더해 HTML을 만든다.
pub fn render_source(src: &str, comp_id: u16, scope: &[String]) -> Result<String, RenderError> {
    let bytecode = compiler::compile(src).map_err(RenderError::Compile)?;
    renderer::render_to_string(&bytecode, comp_id, scope).map_err(RenderError::Render)
}
