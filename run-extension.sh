#!/bin/sh
# quble vscode 확장을 개발 호스트로 띄운다(이 프로젝트를 연 채로).
# code CLI는 기존 인스턴스에 흡수되므로 별도 user-data-dir로 새 인스턴스를 강제한다.
# 확장이 호출하는 컴파일러 바이너리가 있어야 자동완성이 동작한다(아래에서 빌드).

set -e

REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
EXT_DIR="$REPO_ROOT/editors/vscode"
DATA_DIR="$EXT_DIR/.dev-host-data"

# 확장이 호출하는 d.ts 생성 바이너리 빌드(없으면 타입 생성이 조용히 실패).
( cd "$REPO_ROOT/core" && cargo build --quiet --bin quble-dts )

# 깨끗한 프로필로 새 인스턴스를 띄운다(흡수 방지).
rm -rf "$DATA_DIR"
open -n -a "Visual Studio Code" --args \
  --extensionDevelopmentPath="$EXT_DIR" \
  --user-data-dir="$DATA_DIR" \
  --new-window "$REPO_ROOT"
