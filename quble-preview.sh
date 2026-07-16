#!/usr/bin/env bash
# 컴포넌트를 브라우저에서 확인한다: quble 컴파일 -> build.mjs로 dist 빌드 -> 고정 포트 정적 서버.
# 서버가 이미 그 포트에 떠 있으면 내리고 다시 올린다. data는 dist/data.json으로 서빙돼 런타임이 fetch한다.
#
# 사용: ./quble-preview.sh <component.qubc> [--data <data.json>]
set -euo pipefail

PORT=8140
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO="$ROOT/proto"
BUILD="$PROTO/build"
DIST="$PROTO/dist"

if [ $# -lt 1 ]; then
  echo "usage: ./quble-preview.sh <component.qubc> [--data <data.json>]" >&2
  exit 1
fi

# build.mjs는 proto/ cwd에서 돌아 dist를 proto/dist에 낸다 - 인자 경로를 절대경로로 바꿔
# cwd와 무관하게 해소되게 한다(entry, --data 파일 모두).
BUILD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --*) BUILD_ARGS+=("$arg") ;;
    *)   BUILD_ARGS+=("$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")") ;;
  esac
done

echo "[preview] 1/4 quble 바이너리 빌드"
cargo build --manifest-path "$PROTO/Cargo.toml" --bin quble -q

echo "[preview] 2/4 컴포넌트 빌드: ${BUILD_ARGS[*]}"
( cd "$PROTO" && node "$BUILD/build.mjs" "${BUILD_ARGS[@]}" )

echo "[preview] 3/4 포트 $PORT 정리"
# lsof는 매치가 없으면 exit 1 - pipefail·set -e에 걸리지 않게 실패를 삼킨다(빈 결과가 정상).
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  echo "[preview]   기존 서버 내림(pid $EXISTING)"
  sleep 0.3
else
  echo "[preview]   떠 있는 서버 없음"
fi

echo "[preview] 4/4 서버 기동: http://localhost:$PORT"
cd "$DIST"
exec python3 -m http.server "$PORT"
