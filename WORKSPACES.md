# 워크스페이스와 의존

Rust(cargo)와 JS(npm) 워크스페이스가 각각 있다.

## Rust - `core/Cargo.toml`

members: `crates/bytecode`, `crates/compiler`, `crates/compiler-wasm`
exclude: `crates/renderer`
루트 패키지 `quble`가 `quble` 바이너리를 낸다.

| 크레이트 | 의존 |
|---|---|
| `bytecode` | 없음 |
| `compiler` | `bytecode` |
| `compiler-wasm` | `compiler` |
| `renderer` | `bytecode` |
| `quble` (루트) | `compiler` |

## JS - 루트 `package.json`

workspaces: `core/web`, `core/playground`, `core/wasm-compiler`, `editors/ts-plugin`

| 멤버 | 이름 | 의존 |
|---|---|---|
| `core/web` | `quble-web` | 없음 |
| `core/playground` | `quble-playground` | `quble-wasm-compiler`, `quble-web`(상대경로 import, 미선언) |
| `core/wasm-compiler` | `quble-wasm-compiler` | 없음 |
| `editors/ts-plugin` | `quble-ts-plugin` | `quble-wasm-compiler` |

`core/build`는 워크스페이스 밖이다. 자기 `package.json`과 `node_modules`(esbuild)를 갖는다.

## 빌드 산출물 의존

gitignore(`*.wasm`, `target/`)라 레포에 없다.

| 산출물 | 만드는 명령 | 필요한 곳 |
|---|---|---|
| `core/wasm-compiler/compiler_wasm.wasm` | `npm run build:wasm --prefix core/wasm-compiler` | `quble-wasm-compiler` 실행, `npm run typecheck` |
| `core/target/debug/quble` | `cargo build --manifest-path core/Cargo.toml --bin quble` | `core/web` 테스트 (`test-helpers/build.ts`) |
| `core/target/wasm32-unknown-unknown/release/compiler_wasm.wasm` | `cargo build -p compiler-wasm --target wasm32-unknown-unknown --release` | `build:wasm`이 `core/wasm-compiler/`로 복사 |

## 명령별 선행 조건

| 명령 | 먼저 필요한 것 |
|---|---|
| `cargo test --workspace` | 없음 |
| `npm test` | `npm ci`, `cargo build --bin quble` |
| `npm run typecheck` | `npm ci`, `build:wasm` |
| `npm run lint` | 없음 |
| `node build/build-playground.mjs` (cwd `core`) | `npm ci --prefix core/build`, `cargo build --bin quble`, `cargo build -p compiler-wasm --target wasm32-unknown-unknown --release` |
