#!/usr/bin/env bash
# Svelte로 다시 그린 playground 셸을 띄운다: vite 릴리즈 빌드 -> 고정 포트 정적 서버.
#
# core/playground(.qubc 셸)와 별개다 - 이쪽은 편집까지만 하고 컴파일/미리보기가 없다.
# 그래서 cargo 선행 빌드가 필요 없다(wasm도 quble 바이너리도 안 쓴다).
#
# 편집 대상은 core/playground/demo의 실물 소스다 - vite publicDir로 걸어 dist에 함께 실린다.
# 결과 dist/는 자기완결이다(quble-playground.sh와 같은 성질).
#
# 사용: ./svelte-playground.sh
set -euo pipefail

PORT=8142
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/svelte-playground"
DIST="$APP/dist"

if [ ! -d "$APP/node_modules" ]; then
  echo "[svelte-playground] 1/3 의존 설치"
  ( cd "$APP" && npm install )
else
  echo "[svelte-playground] 1/3 의존 확인됨"
fi

echo "[svelte-playground] 2/3 릴리즈 빌드"
( cd "$APP" && npx vite build )

echo "[svelte-playground] 3/3 포트 $PORT 정리 후 기동: http://localhost:$PORT"
# lsof는 매치가 없으면 exit 1 - pipefail/set -e에 안 걸리게 실패를 삼킨다(빈 결과가 정상).
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  echo "[svelte-playground]   기존 서버 내림(pid $EXISTING)"
  sleep 0.3
fi
cd "$DIST"
exec python3 -m http.server "$PORT"
