#!/bin/sh
# 린트, 타입, 테스트를 전부 돌린다. .git/hooks/pre-merge-commit이 머지 전에 부른다.
# 훅 설치: ./install-git-hooks.sh
set -e

root=$(git rev-parse --show-toplevel)
cd "$root"

# 순서는 두 가지가 정한다.
# 1) 선행 조건(WORKSPACES.md) - npm test는 quble 바이너리와 wasm이, typecheck는 wasm이 필요하다.
# 2) 그 제약 안에서 실행이 짧은 것을 앞에 둬 빨리 실패시킨다. lint < typecheck < npm test 순이고,
#    lint는 선행이 없어 맨 앞이다.
#
# 각 단계가 보는 것:
#   lint       biome - 레포 전체의 포맷과 규칙
#   cargo test bytecode, compiler, compiler-wasm, quble 크레이트의 단위 테스트
#   typecheck  루트 tsconfig와 ts-plugin(src/test), 그리고 핸들러 타입 검사
#   npm test   quble-web, playground, wasm-compiler, ts-plugin 워크스페이스

echo "== npm run lint"
if ! npm run lint; then
	echo "" >&2
	echo "biome 검사 실패. npm run format 으로 고친 뒤 다시 머지한다." >&2
	exit 1
fi

echo "== cargo test --workspace"
cargo test --manifest-path core/Cargo.toml --workspace

echo "== cargo build --bin quble"
cargo build --manifest-path core/Cargo.toml --bin quble

echo "== build:wasm"
npm run build:wasm --prefix core/wasm-compiler

echo "== npm run typecheck"
npm run typecheck

echo "== npm test"
npm test

echo "== 전부 통과"
