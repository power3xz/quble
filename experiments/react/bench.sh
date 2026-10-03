#!/usr/bin/env bash
# bench-expr의 주문 목록을 React 산출로 띄운다: 의존 설치 -> bench-expr 데이터 생성 -> orders.qubc를
# quble-react로 컴파일 -> vite 빌드 -> bench-expr의 serve.mjs로 서빙.
#
# bench-expr의 비교 표와는 따로 잰다(포트가 달라 저장 결과도 따로다). 비교할 때는 ./bench-expr.sh와 나란히 띄운다.
#
# 사용: experiments/react/bench.sh
set -euo pipefail

PORT=8148
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BENCH="$ROOT/bench-expr"

echo "[react-bench] 1/4 의존 확인"
[ -d "$HERE/node_modules" ] || npm install --prefix "$HERE"
[ -d "$BENCH/node_modules" ] || npm install --prefix "$BENCH"

echo "[react-bench] 2/4 데이터 생성, orders.qubc 컴파일"
node "$BENCH/gen-data.mjs"
cargo build --manifest-path "$HERE/cli/Cargo.toml" -q
"$HERE/cli/target/debug/quble-react" "$BENCH/quble/orders.qubc" --out "$HERE/dist/bench/orders.tsx"

echo "[react-bench] 3/4 vite 빌드"
npx --prefix "$HERE" vite build --config "$HERE/bench/vite.config.js" --logLevel warn

echo "[react-bench] 4/4 포트 $PORT 정리 후 기동: http://localhost:$PORT/?n=10000"
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  sleep 0.3
fi
PORT="$PORT" DIST="../experiments/react/dist/bench-build" exec node "$BENCH/serve.mjs"
