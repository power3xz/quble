#!/usr/bin/env bash
# quble 런타임의 수정 전후를 bench-expr 앱으로 빠르게 비교한다: 의존 확인 -> orders.qubb 컴파일과 데이터
# 생성 -> 기준 ref와 작업 트리 빌드 -> 서버 둘 기동 -> bench-expr/quick.mjs.
#
# 기준 빌드는 git ref(기본 HEAD)를 임시 worktree로 꺼내 그 core/web으로 만든다 - 커밋 전 작업 트리를 HEAD와
# 비교하는 것이 기본이다. 두 빌드는 지금 컴파일러로 만든 같은 orders.qubb와 데이터를 싣는다(런타임만 비교한다).
#
# headless로 돌아 창이 뜨지 않는다. 다른 대상(React, Svelte)과의 비교는 ./bench-expr.sh로 본다.
#
# 사용: ./bench-expr-quick.sh [기준 git ref]   예: ./bench-expr-quick.sh main~3
set -euo pipefail

BASE_PORT=8144
NEW_PORT=8145
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/bench-expr"
# serve.mjs의 DIST는 bench-expr 기준 상대 경로다.
OUT="dist-quick"
BASE_REF="${1:-HEAD}"

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

echo "[bench-expr-quick] 3/5 빌드: 기준 $BASE_REF, 작업 트리"
for port in "$BASE_PORT" "$NEW_PORT"; do
  if lsof -ti "tcp:$port" >/dev/null 2>&1; then
    echo "[bench-expr-quick] 포트 ${port}를 이미 쓰는 프로세스가 있다 - 내리고 다시 실행한다" >&2
    exit 1
  fi
done
BASE_TREE="$(mktemp -d)"
# 서버 둘은 시작 때 비어 있던 포트를 듣는다 - 끝날 때 그 포트의 프로세스는 여기서 띄운 서버다.
cleanup() {
  for port in "$BASE_PORT" "$NEW_PORT"; do
    lsof -ti "tcp:$port" 2>/dev/null | xargs kill 2>/dev/null || true
  done
  git -C "$ROOT" worktree remove --force "$BASE_TREE" 2>/dev/null || true
}
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$BASE_TREE" "$BASE_REF" >/dev/null
if [ ! -f "$BASE_TREE/bench-expr/src/quble.ts" ]; then
  echo "[bench-expr-quick] $BASE_REF에는 bench-expr이 없다 - 더 나중 ref를 준다" >&2
  exit 1
fi
# 기준 worktree의 vite 설정이 그 worktree의 core/web을 싣는다. 의존은 작업 트리 것을 함께 쓴다.
ln -s "$APP/node_modules" "$BASE_TREE/bench-expr/node_modules"
mkdir -p "$BASE_TREE/bench-expr/public"
cp "$APP/public/"* "$BASE_TREE/bench-expr/public/"
npm run --prefix "$BASE_TREE/bench-expr" build -- --outDir "$APP/$OUT/base" --emptyOutDir --logLevel warn
npm run --prefix "$APP" build -- --outDir "$APP/$OUT/new" --emptyOutDir --logLevel warn

echo "[bench-expr-quick] 4/5 서버 기동: 기준 $BASE_PORT, 작업 트리 $NEW_PORT"
PORT="$BASE_PORT" DIST="$OUT/base" node "$APP/serve.mjs" &
PORT="$NEW_PORT" DIST="$OUT/new" node "$APP/serve.mjs" &
for port in "$BASE_PORT" "$NEW_PORT"; do
  until curl -s -o /dev/null "http://localhost:$port/"; do
    sleep 0.2
  done
done

echo "[bench-expr-quick] 5/5 측정"
node "$APP/quick.mjs" "base=http://localhost:$BASE_PORT" "new=http://localhost:$NEW_PORT"
