#!/usr/bin/env bash
# React Native 산출을 브라우저에서 확인한다: 의존 설치 -> native_demo.qubc를 quble-react --native로 컴파일
# -> react-native-web으로 vite 빌드 -> vite preview.
#
# 브라우저의 react-native-web 확인이지 실기기 확인이 아니다. 레이아웃은 flexbox 기준으로 비슷하게 나오지만
# 글꼴, 그림자, 터치 동작은 기기마다 다르다.
#
# 사용: experiments/react/native-web.sh
set -euo pipefail

PORT=8151
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[react-native-web] 1/4 의존 확인"
[ -d "$HERE/node_modules" ] || npm install --prefix "$HERE"

echo "[react-native-web] 2/4 quble-react 빌드, native_demo.qubc 컴파일"
cargo build --manifest-path "$HERE/cli/Cargo.toml" -q
"$HERE/cli/target/debug/quble-react" "$HERE/fixtures/native_demo.qubc" --native --out "$HERE/dist/native/native_demo.tsx"

echo "[react-native-web] 3/4 vite 빌드"
npx --prefix "$HERE" vite build --config "$HERE/native-web/vite.config.js" --logLevel warn

echo "[react-native-web] 4/4 포트 $PORT 정리 후 기동: http://localhost:$PORT"
EXISTING="$(lsof -ti "tcp:$PORT" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$EXISTING" ]; then
  echo "$EXISTING" | xargs kill
  sleep 0.3
fi
exec npx --prefix "$HERE" vite preview --config "$HERE/native-web/vite.config.js" --port "$PORT" --strictPort
