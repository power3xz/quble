#!/usr/bin/env bash
# playground를 브라우저에서 띄운다: wasm 컴파일러/quble 바이너리 빌드 -> build-playground.mjs로
# dist 빌드 -> 고정 포트 정적 서버.
#
# quble 인스턴스가 둘이다:
#   #editor  <- 셸(playground.qubc). 빌드 타임에 CLI가 컴파일한다.
#   #preview <- 사용자가 편집한 소스. 미리보기 버튼을 누르면 브라우저의 wasm이 컴파일한다.
#
# 셸 UI/핸들러와 진입 페이지는 모두 core/playground/에 있다(생성물 아님 - 손으로 편집한다).
#
# 사용: ./quble-playground.sh
set -euo pipefail

PORT=8141
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$ROOT/core"
DIST="$CORE/dist/playground"

echo "[playground] 1/4 wasm 컴파일러 빌드"
cargo build --manifest-path "$CORE/Cargo.toml" -p compiler-wasm --target wasm32-unknown-unknown --release -q

echo "[playground] 2/4 quble 바이너리 빌드"
cargo build --manifest-path "$CORE/Cargo.toml" --bin quble -q

echo "[playground] 3/4 dist 빌드"
( cd "$CORE" && node build/build-playground.mjs )

echo "[playground] 4/4 포트 $PORT 정리 후 기동: http://localhost:$PORT"
# lsof는 매치가 없으면 exit 1 - pipefail/set -e에 안 걸리게 실패를 삼킨다(빈 결과가 정상).
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  echo "[playground]   기존 서버 내림(pid $EXISTING)"
  sleep 0.3
fi
cd "$DIST"
exec python3 -m http.server "$PORT"
