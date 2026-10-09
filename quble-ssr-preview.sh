#!/usr/bin/env bash
# SSR + resume을 브라우저에서 확인한다: quble/quble-ssr 빌드 -> build-preview.mjs로 dist 빌드 -> 고정 포트 서버.
# 서버가 `/`를 quble-ssr로 렌더한 HTML로 내주고, 페이지의 스크립트가 그 HTML을 노드를 새로 만들지 않고 이어받는다
# (resume). 오른쪽 아래 표시가 이어받았는지, 첫 요소를 그대로 썼는지 알려 준다.
#
#   /          SSR HTML + resume
#   /?nojs     SSR HTML만(스크립트 없음) - 서버가 보낸 그대로
#   /?csr      SSR HTML 없이 클라이언트가 처음부터 그림 - resume과 견주는 용도
#
# 컴포넌트와 data는 quble-preview.sh와 같은 관례다(짝 파일 <name>.data.json, <name>.qubc.handlers.ts).
# 서버가 이미 그 포트에 떠 있으면 내리고 다시 올린다.
#
# 사용: ./quble-ssr-preview.sh <component.qubc> [--data <data.json>]
#   예: ./quble-ssr-preview.sh components/todo_list.qubc --data components/todo_list.data.json
set -euo pipefail

PORT=8152
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$ROOT/core"
BUILD="$CORE/build"
DIST="$CORE/dist/preview"

if [ $# -lt 1 ]; then
  echo "usage: ./quble-ssr-preview.sh <component.qubc> [--data <data.json>]" >&2
  exit 1
fi

# build-preview.mjs는 core/ cwd에서 돌아 산출물을 core/dist/preview에 낸다 - 인자 경로를 절대경로로 바꿔
# cwd와 무관하게 해소되게 한다(entry, --data 파일 모두).
BUILD_ARGS=()
ENTRY=""
for arg in "$@"; do
  case "$arg" in
    --*) BUILD_ARGS+=("$arg") ;;
    *)
      ABS="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
      BUILD_ARGS+=("$ABS")
      # 첫 .qubc가 entry다. --data 값은 .qubc가 아니라 건너뛴다.
      if [ -z "$ENTRY" ] && [[ "$arg" == *.qubc ]]; then
        ENTRY="$ABS"
      fi
      ;;
  esac
done
STEM="$(basename "$ENTRY" .qubc)"

echo "[ssr-preview] 1/4 quble, quble-ssr 바이너리 빌드"
cargo build --manifest-path "$CORE/Cargo.toml" --bin quble -q
cargo build --manifest-path "$CORE/Cargo.toml" -p renderer --bin quble-ssr -q

echo "[ssr-preview] 2/4 컴포넌트 빌드: ${BUILD_ARGS[*]}"
( cd "$CORE" && node "$BUILD/build-preview.mjs" "${BUILD_ARGS[@]}" )

echo "[ssr-preview] 3/4 포트 $PORT 정리"
# lsof는 매치가 없으면 exit 1 - pipefail/set -e에 걸리지 않게 실패를 삼킨다(빈 결과가 정상).
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  echo "[ssr-preview]   기존 서버 내림(pid $EXISTING)"
  sleep 0.3
else
  echo "[ssr-preview]   떠 있는 서버 없음"
fi

echo "[ssr-preview] 4/4 서버 기동: http://localhost:$PORT"
exec node "$BUILD/serve-ssr-preview.mjs" "$DIST" "$STEM" "$PORT" "$CORE/target/debug/quble-ssr"
