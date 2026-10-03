#!/usr/bin/env bash
# bench-expr의 주문 목록을 canvas로 그리는 데모를 띄운다: 의존 설치 -> orders.qubc 컴파일과 데이터 생성
# (bench-expr/public) -> vite 빌드 -> bench-expr의 serve.mjs로 서빙.
#
# 사용: experiments/canvas/demo.sh
set -euo pipefail

PORT=8149
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BENCH="$ROOT/bench-expr"

echo "[canvas-demo] 1/4 의존 확인"
[ -d "$HERE/node_modules" ] || npm install --prefix "$HERE"

echo "[canvas-demo] 2/4 orders.qubc 컴파일, 데이터 생성"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble -q
"$ROOT/core/target/debug/quble" "$BENCH/quble/orders.qubc" --out-dir "$BENCH/public"
node "$BENCH/gen-data.mjs"

echo "[canvas-demo] 3/4 vite 빌드"
npx --prefix "$HERE" vite build --config "$HERE/demo/vite.config.js" --logLevel warn

echo "[canvas-demo] 4/4 포트 $PORT 정리 후 기동: http://localhost:$PORT/?n=10000"
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  sleep 0.3
fi
PORT="$PORT" DIST="../experiments/canvas/dist/demo-build" exec node "$BENCH/serve.mjs"
