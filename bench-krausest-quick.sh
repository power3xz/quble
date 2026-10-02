#!/usr/bin/env bash
# quble 런타임의 수정 전후를 krausest 앱으로 빠르게 비교한다: 의존 확인 -> app.qubb 컴파일 -> 기준 ref와
# 작업 트리 번들 빌드 -> bench-krausest/quick.mjs.
#
# 기준 번들은 git ref(기본 HEAD)를 임시 worktree로 꺼내 만든다 - 커밋 전 작업 트리를 HEAD와 비교하는 것이
# 기본이다. 두 번들은 지금 컴파일러로 만든 같은 app.qubb를 싣는다(런타임만 비교한다).
#
# headless로 돌아 창이 뜨지 않는다. paint를 포함한 최종 수치는 ./bench-krausest.sh로 본다.
#
# 사용: ./bench-krausest-quick.sh [기준 git ref]   예: ./bench-krausest-quick.sh main~3
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$ROOT/bench-krausest"
OUT="$DIR/quble/dist"
BASE_REF="${1:-HEAD}"

echo "[bench-krausest-quick] 1/4 의존 확인"
if [ ! -d "$DIR/node_modules" ]; then
  npm install --prefix "$DIR"
fi
# 이미 받았으면 바로 끝난다.
npx --prefix "$DIR" playwright install chromium

echo "[bench-krausest-quick] 2/4 app.qubc 컴파일"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble
"$ROOT/core/target/debug/quble" "$DIR/quble/src/app.qubc" --out-dir "$OUT"

echo "[bench-krausest-quick] 3/4 번들 빌드: 기준 $BASE_REF, 작업 트리"
BASE_TREE="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$BASE_TREE" 2>/dev/null || true' EXIT
git -C "$ROOT" worktree add --detach "$BASE_TREE" "$BASE_REF" >/dev/null
if [ ! -f "$BASE_TREE/bench-krausest/quble/src/main.ts" ]; then
  echo "[bench-krausest-quick] $BASE_REF에는 bench-krausest/quble이 없다 - 더 나중 ref를 준다" >&2
  exit 1
fi
mkdir -p "$BASE_TREE/bench-krausest/quble/dist"
cp "$OUT/app.qubb" "$BASE_TREE/bench-krausest/quble/dist/"
"$DIR/node_modules/.bin/esbuild" "$BASE_TREE/bench-krausest/quble/src/main.ts" --bundle --minify --format=iife \
  --loader:.qubb=binary --outfile="$OUT/base.js"
"$DIR/node_modules/.bin/esbuild" "$DIR/quble/src/main.ts" --bundle --minify --format=iife \
  --loader:.qubb=binary --outfile="$OUT/main.js"

echo "[bench-krausest-quick] 4/4 측정"
node "$DIR/quick.mjs" "base=$OUT/base.js" "new=$OUT/main.js"
