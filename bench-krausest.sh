#!/usr/bin/env bash
# krausest js-framework-benchmark로 quble(non-keyed)과 비교 대상 6개를 잰다:
# krausest clone, 의존 설치 -> quble 빌드 -> 서버 기동 -> 비교 대상 빌드와 검사 -> quble 검사 -> 측정 -> 결과 표.
#
# krausest는 bench-krausest/js-framework-benchmark에 받는다(gitignore). quble 번들은 레포의 core/web 런타임과
# quble 바이너리로 만든다 - 둘 다 지금 체크아웃된 코드 그대로다.
#
# 측정 중 runner가 Chrome 창을 띄운다. 창이 가려지면 paint 이벤트가 빠져 수치가 틀어진다 - 측정은
# caffeinate -d로 감싸 화면 보호기와 디스플레이 꺼짐을 막는다.
#
# 사용: ./bench-krausest.sh [runner 인자...]   예: ./bench-krausest.sh --benchmark 01_ 02_ --count 3
set -euo pipefail

PORT=8080
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$ROOT/bench-krausest"
JFB="$DIR/js-framework-benchmark"
QUBLE_OUT="$JFB/frameworks/non-keyed/quble"
COMPARE=(non-keyed/vanillajs non-keyed/svelte-classic keyed/vanillajs keyed/svelte keyed/react-hooks keyed/solid)

if [ ! -d "$JFB" ]; then
  echo "[bench-krausest] 1/7 krausest clone"
  git clone --depth 1 https://github.com/krausest/js-framework-benchmark.git "$JFB"
else
  echo "[bench-krausest] 1/7 krausest 확인됨"
fi

if [ ! -d "$JFB/node_modules" ]; then
  echo "[bench-krausest] 2/7 krausest 의존 설치(서버, webdriver-ts, 결과 표)"
  # 루트 devDependencies의 eslint 10과 eslint-plugin-react(peer eslint <= 9)가 충돌한다. krausest 자기 lint용이라
  # 측정과 무관해 peer 검사만 끈다.
  ( cd "$JFB" && npm ci --legacy-peer-deps && npm run install-local )
else
  echo "[bench-krausest] 2/7 krausest 의존 확인됨"
fi

echo "[bench-krausest] 3/7 quble 빌드"
if [ ! -d "$DIR/node_modules" ]; then
  npm install --prefix "$DIR"
fi
cargo build --manifest-path "$ROOT/core/Cargo.toml" --bin quble
"$ROOT/core/target/debug/quble" "$DIR/quble/src/app.qubc" --out-dir "$DIR/quble/dist"
"$DIR/node_modules/.bin/esbuild" "$DIR/quble/src/main.ts" --bundle --minify --format=iife \
  --loader:.qubb=binary --outfile="$DIR/quble/dist/main.js"
mkdir -p "$QUBLE_OUT/dist"
# krausest 서버는 package.json과 package-lock.json이 둘 다 있는 디렉터리만 프레임워크로 나열한다.
cp "$DIR/quble/index.html" "$DIR/quble/package.json" "$DIR/quble/package-lock.json" "$QUBLE_OUT/"
cp "$DIR/quble/dist/main.js" "$QUBLE_OUT/dist/"

echo "[bench-krausest] 4/7 서버 기동: http://localhost:$PORT"
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "[bench-krausest] 포트 ${PORT}를 이미 쓰는 프로세스가 있다 - 내리고 다시 실행한다" >&2
  exit 1
fi
( cd "$JFB" && npm start ) &
# 서버는 npm -> sh -> tsx 아래 손자 프로세스라 npm pid로는 못 내린다. 시작 때 포트가 비어 있었으니
# 끝날 때 그 포트를 듣는 프로세스는 여기서 띄운 서버다.
trap 'lsof -ti "tcp:$PORT" 2>/dev/null | xargs kill 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://localhost:$PORT/"; do
  sleep 0.5
done

# 비교 대상은 레포 코드와 무관해 한 번 빌드와 검사를 통과하면 다시 하지 않는다. 다시 하려면 이 파일을 지운다.
COMPARE_BUILT="$JFB/.quble-compare-built"
if [ ! -f "$COMPARE_BUILT" ]; then
  echo "[bench-krausest] 5/7 비교 대상 빌드와 검사"
  ( cd "$JFB" && npm run rebuild-ci -- "${COMPARE[@]}" )
  touch "$COMPARE_BUILT"
else
  echo "[bench-krausest] 5/7 비교 대상 빌드 확인됨"
fi

echo "[bench-krausest] 6/7 quble 검사(smoketest, keyed 판정)"
( cd "$JFB/webdriver-ts" && npm run bench -- --headless true --smoketest true non-keyed/quble )
( cd "$JFB/webdriver-ts" && npm run isKeyed -- --headless true non-keyed/quble )

echo "[bench-krausest] 7/7 측정과 결과 표"
( cd "$JFB" && caffeinate -d npm run bench -- "$@" --framework non-keyed/quble "${COMPARE[@]}" )
( cd "$JFB" && npm run results )
echo "[bench-krausest] 결과: $JFB/webdriver-ts/results, 표: http://localhost:$PORT/webdriver-ts-results/dist/index.html"
