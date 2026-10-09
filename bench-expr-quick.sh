#!/usr/bin/env bash
# 커밋 하나의 quble 런타임을 bench-expr 앱으로 빠르게 재고 기록으로 남긴다: 의존 확인 -> .qubb 컴파일과
# 데이터 생성 -> 그 커밋의 빌드 -> 서버 기동 -> bench-expr/quick.mjs -> 기록 출력.
#
# 런타임(core/web)만 커밋(기본 HEAD)의 것이고, 벤치 앱(bench-expr/의 페이지, 행 템플릿, 시나리오)은 지금
# 작업 트리 것이다 - 어떤 커밋이든 같은 벤치 앱으로 재서 서로 견줄 수 있다. 커밋은 임시 worktree로 꺼내
# 빌드하므로 작업 트리의 커밋 안 한 런타임 변경은 재지 않는다. .qubb와 데이터는 지금 컴파일러로 만든다.
#
# 테스트는 둘이다. orders는 기본 행, orders-deep은 값 자리 사이에 정적 하위 트리와 깊은 값 자리가 낀 행이다.
# 기록은 bench-results/<커밋>.expr.json(orders), <커밋>.expr-deep.json(orders-deep)에 남고, 같은 커밋을
# 다시 재면 덮어쓴다. 커밋끼리 비교는 node bench-compare.mjs <expr|expr-deep> <ref> <ref>로 본다.
#
# headless로 돌아 창이 뜨지 않는다. 다른 대상(React, Svelte)과의 비교는 ./bench-expr.sh로 본다.
#
# 사용: ./bench-expr-quick.sh [git ref] [orders|orders-deep]
#   테스트를 생략하면 둘 다 잰다.   예: ./bench-expr-quick.sh main~3   ./bench-expr-quick.sh HEAD orders-deep
set -euo pipefail

PORT=8144
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/bench-expr"
# serve.mjs의 DIST는 bench-expr 기준 상대 경로다.
OUT="dist-quick"
REF="${1:-HEAD}"
SHA="$(git -C "$ROOT" rev-parse --short=7 "$REF")"
case "${2:-all}" in
  all) TESTS="orders orders-deep" ;;
  orders | orders-deep) TESTS="$2" ;;
  *)
    echo "사용: ./bench-expr-quick.sh [git ref] [orders|orders-deep]" >&2
    exit 1
    ;;
esac

echo "[bench-expr-quick] 1/5 의존 확인"
if [ ! -d "$APP/node_modules/playwright" ]; then
  npm install --prefix "$APP"
fi
# 이미 받았으면 바로 끝난다.
npx --prefix "$APP" playwright install chromium

echo "[bench-expr-quick] 2/5 orders.qubc, orders-deep.qubc 컴파일, 데이터 생성"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble
"$ROOT/core/target/debug/quble" "$APP/quble/orders.qubc" --out-dir "$APP/public"
"$ROOT/core/target/debug/quble" "$APP/quble/orders-deep.qubc" --out-dir "$APP/public"
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
if [ ! -f "$TREE/core/web/runtime.ts" ]; then
  echo "[bench-expr-quick] $REF에는 core/web/runtime.ts가 없다 - 더 나중 ref를 준다" >&2
  exit 1
fi
# 벤치 앱은 지금 작업 트리 것으로 덮는다(데이터 public/ 포함). worktree의 vite 설정이 그 worktree의
# core/web을 싣고, 의존은 작업 트리 것을 함께 쓴다.
rm -rf "$TREE/bench-expr"
mkdir -p "$TREE/bench-expr"
rsync -a --exclude node_modules --exclude dist --exclude dist-quick "$APP/" "$TREE/bench-expr/"
ln -s "$APP/node_modules" "$TREE/bench-expr/node_modules"
npm run --prefix "$TREE/bench-expr" build -- --outDir "$APP/$OUT/$SHA" --emptyOutDir --logLevel error

echo "[bench-expr-quick] 4/5 서버 기동: $PORT"
PORT="$PORT" DIST="$OUT/$SHA" node "$APP/serve.mjs" &
until curl -s -o /dev/null "http://localhost:$PORT/"; do
  sleep 0.2
done

echo "[bench-expr-quick] 5/5 측정"
mkdir -p "$ROOT/bench-results"
for TEST in $TESTS; do
  case "$TEST" in
    orders) KIND="expr" ;;
    orders-deep) KIND="expr-deep" ;;
  esac
  echo "[bench-expr-quick] 테스트: $TEST"
  node "$APP/quick.mjs" "http://localhost:$PORT" "$ROOT/bench-results/$SHA.$KIND.json" "$TEST"
  node "$ROOT/bench-compare.mjs" "$KIND" "$SHA"
done
