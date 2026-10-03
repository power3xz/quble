#!/usr/bin/env bash
# playground 셸을 React로 띄운다: 바이너리 빌드 -> 셸을 quble-react로 컴파일 -> 정적 자산 복사 -> vite 빌드
# -> vite preview.
#
# 셸(#editor)은 playground.qubc의 React 산출이고, 미리보기(#preview)는 qubb 셸과 같이 wasm 컴파일러가
# 사용자 소스를 qubb로 컴파일해 마운트한다. 핸들러는 qubb 셸과 같은 파일을 쓴다.
#
# 사용: ./quble-playground-react.sh
set -euo pipefail

PORT=8147
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$ROOT/core"
APP="$ROOT/playground-react"

if [ ! -d "$APP/node_modules" ]; then
  echo "[playground-react] 1/5 의존 설치"
  npm install --prefix "$APP"
else
  echo "[playground-react] 1/5 의존 확인됨"
fi

echo "[playground-react] 2/5 wasm 컴파일러, quble-react 빌드"
cargo build --manifest-path "$CORE/Cargo.toml" -p compiler-wasm --target wasm32-unknown-unknown --release -q
cargo build --manifest-path "$CORE/Cargo.toml" --bin quble-react -q

echo "[playground-react] 3/5 셸 컴파일, 정적 자산 복사"
"$CORE/target/debug/quble-react" "$CORE/playground/playground.qubc" --out "$APP/gen/playground.tsx"
rm -rf "$APP/public"
mkdir -p "$APP/public/styles"
cp "$CORE/target/wasm32-unknown-unknown/release/compiler_wasm.wasm" "$APP/public/"
cp "$CORE/playground/sources.json" "$APP/public/"
cp -R "$CORE/playground/demo" "$APP/public/demo"
cp "$CORE/web/styles/reset.css" "$CORE/web/styles/global.css" "$APP/public/styles/"

echo "[playground-react] 4/5 vite 빌드"
npm run build --prefix "$APP"

echo "[playground-react] 5/5 포트 $PORT 정리 후 기동: http://localhost:$PORT"
# lsof는 매치가 없으면 exit 1 - pipefail/set -e에 안 걸리게 실패를 삼킨다(빈 결과가 정상).
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  sleep 0.3
fi
exec npx --prefix "$APP" vite preview "$APP" --port "$PORT" --strictPort
