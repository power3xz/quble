#!/usr/bin/env bash
# playground 셸을 Next.js(Pages Router)로 서버에서 그려 띄운다: 의존 설치 -> wasm 컴파일러와 quble-react 빌드
# -> 셸 컴파일, wasm 복사 -> next build -> next start.
#
# 셸은 playground.qubc의 React 산출이고 getServerSideProps가 데모 소스로 첫 화면을 서버에서 그린다. 미리보기는
# qubb 셸과 같이 wasm 컴파일러가 브라우저에서 컴파일해 마운트한다.
#
# 사용: experiments/react/next.sh
set -euo pipefail

PORT=8150
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$(cd "$HERE/../../core" && pwd)"
APP="$HERE/next"

echo "[react-next] 1/5 의존 확인"
[ -d "$HERE/node_modules" ] || npm install --prefix "$HERE"

echo "[react-next] 2/5 wasm 컴파일러, quble-react 빌드"
cargo build --manifest-path "$CORE/Cargo.toml" -p compiler-wasm --target wasm32-unknown-unknown --release -q
cargo build --manifest-path "$HERE/cli/Cargo.toml" -q

echo "[react-next] 3/5 셸 컴파일, wasm과 셸 CSS 복사"
"$HERE/cli/target/debug/quble-react" "$CORE/playground/playground.qubc" --out "$HERE/dist/playground/playground.tsx"
# public/은 Next가 자리를 정한다(next/public, gitignore).
mkdir -p "$APP/public" "$HERE/dist/next-shell-css"
cp "$CORE/target/wasm32-unknown-unknown/release/compiler_wasm.wasm" "$APP/public/"
cp "$CORE"/playground/{playground,completion,filerow,logrow}.css "$HERE/dist/next-shell-css/"

echo "[react-next] 4/5 next build"
npx --prefix "$HERE" next build "$APP"

echo "[react-next] 5/5 포트 $PORT 정리 후 기동: http://localhost:$PORT"
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  sleep 0.3
fi
exec npx --prefix "$HERE" next start "$APP" --port "$PORT"
