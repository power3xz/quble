#!/usr/bin/env bash
# 식 갱신 벤치(quble / React / Svelte)를 띄운다: 의존 설치 -> .qubb와 데이터 생성 -> vite 빌드 -> 서버 기동.
#
# quble 페이지는 레포의 core/web 런타임을 번들에 싣고, orders.qubc는 레포의 quble 바이너리로 컴파일한다.
# 둘 다 지금 체크아웃된 코드 그대로다.
#
# 서버(bench-expr/serve.mjs)는 쿠키 enc대로 응답을 압축하고 캐시를 끈다. COOP/COEP를 켜
# performance.now()가 정밀하게 잰다 - python http.server로는 이 둘이 안 된다.
#
# 사용: ./bench-expr.sh
set -euo pipefail

PORT=8143
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/bench-expr"

if [ ! -d "$APP/node_modules" ]; then
  echo "[bench-expr] 1/4 의존 설치"
  ( cd "$APP" && npm install )
else
  echo "[bench-expr] 1/4 의존 확인됨"
fi

echo "[bench-expr] 2/4 orders.qubc 컴파일, 데이터 생성"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble
"$ROOT/core/target/debug/quble" "$APP/quble/orders.qubc" --out-dir "$APP/public"
node "$APP/gen-data.mjs"

echo "[bench-expr] 3/4 릴리즈 빌드"
( cd "$APP" && npx vite build )

echo "[bench-expr] 4/4 포트 $PORT 정리 후 기동: http://localhost:$PORT"
# lsof는 매치가 없으면 exit 1 - pipefail/set -e에 안 걸리게 실패를 삼킨다(빈 결과가 정상).
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  echo "[bench-expr]   기존 서버 내림(pid $EXISTING)"
  sleep 0.3
fi
exec node "$APP/serve.mjs"
