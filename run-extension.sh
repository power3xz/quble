#!/bin/sh
# quble vscode 확장을 개발 호스트로 띄운다(이 프로젝트를 연 채로).
# code CLI는 기존 인스턴스에 흡수되므로 별도 user-data-dir로 새 인스턴스를 강제한다.
# 확장은 번들(dist/extension.js)을 로드하므로 소스를 고쳤으면 여기서 다시 묶어야 한다.

set -e

REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
EXT_DIR="$REPO_ROOT/editors/vscode"
DATA_DIR="$EXT_DIR/.dev-host-data"

# 확장이 품는 wasm 컴파일러 - 없으면 타입 생성이 조용히 실패한다.
npm run --silent build:wasm -w quble-wasm-compiler --prefix "$REPO_ROOT"

# 확장 번들(+ wasm 복사).
npm run --silent build -w quble-vscode --prefix "$REPO_ROOT"

# 깨끗한 프로필로 새 인스턴스를 띄운다(흡수 방지).
rm -rf "$DATA_DIR"
open -n -a "Visual Studio Code" --args \
  --extensionDevelopmentPath="$EXT_DIR" \
  --user-data-dir="$DATA_DIR" \
  --new-window "$REPO_ROOT"
