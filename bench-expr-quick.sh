#!/usr/bin/env bash
# 커밋 하나의 quble 런타임을 bench-expr 앱으로 빠르게 재고 기록으로 남긴다: 의존 확인 -> orders.qubb 컴파일과
# 데이터 생성 -> 그 커밋의 빌드 -> 서버 기동 -> bench-expr/quick.mjs -> 기록 출력.
#
# 커밋(기본 HEAD)을 임시 worktree로 꺼내 그 core/web으로 빌드한다 - 작업 트리의 커밋 안 한 변경은 재지
# 않는다. orders.qubb와 데이터는 지금 컴파일러로 만든다(런타임만 비교한다).
#
# 기록은 bench-results/<커밋>.expr.json에 남고, 같은 커밋을 다시 재면 덮어쓴다. 커밋끼리 비교는
# node bench-compare.mjs expr <ref> <ref>로 본다.
#
# headless로 돌아 창이 뜨지 않는다. 다른 대상(React, Svelte)과의 비교는 ./bench-expr.sh로 본다.
#
# 사용: ./bench-expr-quick.sh [git ref]   예: ./bench-expr-quick.sh main~3
set -euo pipefail

PORT=8144
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/bench-expr"
# serve.mjs의 DIST는 bench-expr 기준 상대 경로다.
OUT="dist-quick"
REF="${1:-HEAD}"
SHA="$(git -C "$ROOT" rev-parse --short=7 "$REF")"

echo "[bench-expr-quick] 1/5 의존 확인"
if [ ! -d "$APP/node_modules/playwright" ]; then
  npm install --prefix "$APP"
fi
# 이미 받았으면 바로 끝난다.
npx --prefix "$APP" playwright install chromium

echo "[bench-expr-quick] 2/5 orders.qubc 컴파일, 데이터 생성"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble
"$ROOT/core/target/debug/quble" "$APP/quble/orders.qubc" --out-dir "$APP/public"
node "$APP/gen-data.mjs"

echo "[bench-expr-quick] 3/5 빌드: $REF($SHA)"
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "[bench-expr-quick] 포트 ${PORT}를 이미 쓰는 프로세스가 있다 - 내리고 다시 실행한다" >&2
  exit 1
fi
TREE="$(mktemp -d)"
# 서버는 시작 때 비어 있던 포트를 듣는다 - 끝날 때 그 포트의 프로세스는 여기서 띄운 서버다.
cleanup() {
  lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  git -C "$ROOT" worktree remove --force "$TREE" 2>/dev/null || true
}
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$TREE" "$SHA" >/dev/null
if [ ! -f "$TREE/bench-expr/src/quble.ts" ]; then
  echo "[bench-expr-quick] $REF에는 bench-expr이 없다 - 더 나중 ref를 준다" >&2
  exit 1
fi
# worktree의 vite 설정이 그 worktree의 core/web을 싣는다. 의존은 작업 트리 것을 함께 쓴다.
ln -s "$APP/node_modules" "$TREE/bench-expr/node_modules"
mkdir -p "$TREE/bench-expr/public"
cp "$APP/public/"* "$TREE/bench-expr/public/"
npm run --prefix "$TREE/bench-expr" build -- --outDir "$APP/$OUT/$SHA" --emptyOutDir --logLevel error

echo "[bench-expr-quick] 4/5 서버 기동: $PORT"
PORT="$PORT" DIST="$OUT/$SHA" node "$APP/serve.mjs" &
until curl -s -o /dev/null "http://localhost:$PORT/"; do
  sleep 0.2
done

echo "[bench-expr-quick] 5/5 측정"
mkdir -p "$ROOT/bench-results"
node "$APP/quick.mjs" "http://localhost:$PORT" "$ROOT/bench-results/$SHA.expr.json"
node "$ROOT/bench-compare.mjs" expr "$SHA"
