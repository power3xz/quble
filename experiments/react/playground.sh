#!/usr/bin/env bash
# playground 셸을 React로 띄운다: 의존 설치 -> wasm 컴파일러와 quble-react 빌드 -> 셸 컴파일, 정적 자산 복사
# -> vite 빌드 -> vite preview.
#
# 셸(#editor)은 playground.qubc의 React 산출이고, 미리보기(#preview)는 qubb 셸과 같이 wasm 컴파일러가
# 사용자 소스를 qubb로 컴파일해 마운트한다. 핸들러는 qubb 셸과 같은 파일을 쓴다.
#
# 사용: experiments/react/playground.sh
set -euo pipefail

PORT=8147
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$(cd "$HERE/../../core" && pwd)"
PUBLIC="$HERE/dist/playground-public"

echo "[react-playground] 1/5 의존 확인"
[ -d "$HERE/node_modules" ] || npm install --prefix "$HERE"

echo "[react-playground] 2/5 wasm 컴파일러, quble-react 빌드"
cargo build --manifest-path "$CORE/Cargo.toml" -p compiler-wasm --target wasm32-unknown-unknown --release -q
cargo build --manifest-path "$HERE/cli/Cargo.toml" -q

echo "[react-playground] 3/5 셸 컴파일, 정적 자산 복사"
"$HERE/cli/target/debug/quble-react" "$CORE/playground/playground.qubc" --out "$HERE/dist/playground/playground.tsx"
rm -rf "$PUBLIC"
mkdir -p "$PUBLIC/styles"
cp "$CORE/target/wasm32-unknown-unknown/release/compiler_wasm.wasm" "$PUBLIC/"
cp "$CORE/playground/sources.json" "$PUBLIC/"
cp -R "$CORE/playground/demo" "$PUBLIC/demo"
cp "$CORE/web/styles/reset.css" "$CORE/web/styles/global.css" "$PUBLIC/styles/"

echo "[react-playground] 4/5 vite 빌드"
npx --prefix "$HERE" vite build --config "$HERE/playground/vite.config.js" --logLevel warn

echo "[react-playground] 5/5 포트 $PORT 정리 후 기동: http://localhost:$PORT"
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  sleep 0.3
fi
exec npx --prefix "$HERE" vite preview --config "$HERE/playground/vite.config.js" --port "$PORT" --strictPort
