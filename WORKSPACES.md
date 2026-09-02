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

`editors/vscode`도 워크스페이스 밖이다. 자기 `node_modules`를 갖지만 `npm install`이
`quble-ts-plugin: 0.0.1`을 레지스트리에서 못 찾아 404다(ISSUES.md). 그래서 루트 `npm ci`로는
그 의존이 안 깔린다 - 루트 tsconfig가 보는 `editors/vscode/src`용 `@types/vscode`만 루트
`devDependencies`에 둔다.

## lock 파일

`package-lock.json`에는 **플랫폼별 네이티브 바이너리가 전부 들어 있어야 한다.** npm은 설치를
돌린 플랫폼 것만 기록하는 버릇이 있어(npm/cli#8320), macOS에서 만든 lock으로 linux CI가
`npm ci`를 하면 biome 바이너리를 못 찾는다. 지금 lock에는 `@biomejs/cli-*` 8종이 들어 있다 -
의존을 바꾼 뒤 이 목록이 줄지 않았는지 본다.

```
grep -o '"node_modules/@biomejs/cli-[a-z0-9-]*"' package-lock.json | sort -u | wc -l   # 8
```

## 빌드 산출물 의존

gitignore(`*.wasm`, `target/`)라 레포에 없다.

| 산출물 | 만드는 명령 | 필요한 곳 |
|---|---|---|
| `core/wasm-compiler/compiler_wasm.wasm` | `npm run build:wasm --prefix core/wasm-compiler` | `quble-wasm-compiler` 실행, `npm run typecheck`, `editors/vscode` 빌드(build.mjs가 `dist/`로 복사) |
| `core/target/debug/quble` | `cargo build --manifest-path core/Cargo.toml --bin quble` | `core/web` 테스트 (`test-helpers/build.ts`) |
| `core/target/wasm32-unknown-unknown/release/compiler_wasm.wasm` | `cargo build -p compiler-wasm --target wasm32-unknown-unknown --release` | `build:wasm`이 `core/wasm-compiler/`로 복사 |

## 명령별 선행 조건

| 명령 | 먼저 필요한 것 |
|---|---|
| `cargo test --workspace` | 없음 |
| `npm test` | `npm ci`, `cargo build --bin quble` |
| `npm run typecheck` | `npm ci`, `build:wasm` |
| `npm run lint` | `npm ci` |
| `node build/build-playground.mjs` (cwd `core`) | `npm ci --prefix core/build`, `cargo build --bin quble`, `cargo build -p compiler-wasm --target wasm32-unknown-unknown --release` |
| `npm run install-local --prefix editors/vscode` | `build:wasm` - 확장은 `core/wasm-compiler/`의 wasm을 복사한다. 플레이그라운드 빌드는 `core/target/`에만 내므로 그것으로는 안 갱신된다 |
