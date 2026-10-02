#!/usr/bin/env bash
# 커밋 하나의 quble 런타임을 krausest 앱으로 빠르게 재고 기록으로 남긴다: 의존 확인 -> app.qubb 컴파일 ->
# 그 커밋의 번들 빌드 -> bench-krausest/quick.mjs -> 기록 출력.
#
# 커밋(기본 HEAD)을 임시 worktree로 꺼내 그 core/web으로 번들을 만든다 - 작업 트리의 커밋 안 한 변경은
# 재지 않는다. app.qubb는 지금 컴파일러로 만든다(런타임만 비교한다).
#
# 기록은 bench-results/<커밋>.krausest.json에 남고, 같은 커밋을 다시 재면 덮어쓴다. 커밋끼리 비교는
# node bench-compare.mjs krausest <ref> <ref>로 본다.
#
# headless로 돌아 창이 뜨지 않는다. paint를 포함한 최종 수치는 ./bench-krausest.sh로 본다.
#
# 사용: ./bench-krausest-quick.sh [git ref]   예: ./bench-krausest-quick.sh main~3
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$ROOT/bench-krausest"
OUT="$DIR/quble/dist"
REF="${1:-HEAD}"
SHA="$(git -C "$ROOT" rev-parse --short=7 "$REF")"

echo "[bench-krausest-quick] 1/4 의존 확인"
if [ ! -d "$DIR/node_modules" ]; then
  npm install --prefix "$DIR"
fi
# 이미 받았으면 바로 끝난다.
npx --prefix "$DIR" playwright install chromium

echo "[bench-krausest-quick] 2/4 app.qubc 컴파일"
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble
"$ROOT/core/target/debug/quble" "$DIR/quble/src/app.qubc" --out-dir "$OUT"

echo "[bench-krausest-quick] 3/4 번들 빌드: $REF($SHA)"
TREE="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$TREE" 2>/dev/null || true' EXIT
git -C "$ROOT" worktree add --detach "$TREE" "$SHA" >/dev/null
if [ ! -f "$TREE/bench-krausest/quble/src/main.ts" ]; then
  echo "[bench-krausest-quick] $REF에는 bench-krausest/quble이 없다 - 더 나중 ref를 준다" >&2
  exit 1
fi
mkdir -p "$TREE/bench-krausest/quble/dist"
cp "$OUT/app.qubb" "$TREE/bench-krausest/quble/dist/"
"$DIR/node_modules/.bin/esbuild" "$TREE/bench-krausest/quble/src/main.ts" --bundle --minify --format=iife \
  --loader:.qubb=binary --outfile="$OUT/$SHA.js"

echo "[bench-krausest-quick] 4/4 측정"
mkdir -p "$ROOT/bench-results"
node "$DIR/quick.mjs" "$OUT/$SHA.js" "$ROOT/bench-results/$SHA.krausest.json"
node "$ROOT/bench-compare.mjs" krausest "$SHA"
