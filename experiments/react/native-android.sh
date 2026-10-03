#!/usr/bin/env bash
# React Native 산출을 Android 앱(APK)으로 만든다: 의존 설치 -> native_demo.qubc를 quble-react --native로
# 컴파일 -> expo prebuild로 android/ 생성 -> gradle assembleRelease.
#
# release로 빼는 이유: debug APK는 JS를 PC의 Metro 서버에서 받아 단독 설치하면 실행이 안 된다. release는
# JS 번들이 APK 안에 들어가고, Expo 템플릿이 debug 키스토어로 서명해 바로 설치된다(스토어 배포용이 아니다).
#
# 필요한 것: JDK 17 이상, Android SDK(ANDROID_HOME, 없으면 ~/Library/Android/sdk). 첫 빌드는 gradle이 필요한
# SDK 구성요소를 내려받아 오래 걸린다.
#
# 사용: experiments/react/native-android.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/native-app"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

echo "[native-android] 1/5 의존 확인"
[ -d "$ANDROID_HOME" ] || { echo "Android SDK를 못 찾음: $ANDROID_HOME (ANDROID_HOME을 지정한다)"; exit 1; }
[ -d "$APP/node_modules" ] || npm install --prefix "$APP"

echo "[native-android] 2/5 quble-react 빌드, native_demo.qubc 컴파일"
cargo build --manifest-path "$HERE/cli/Cargo.toml" -q
"$HERE/cli/target/debug/quble-react" "$HERE/fixtures/native_demo.qubc" --native --out "$HERE/dist/native/native_demo.tsx"

echo "[native-android] 3/5 expo prebuild (android/ 생성)"
EXPO_NO_TELEMETRY=1 CI=1 npm run prebuild:android --prefix "$APP"

echo "[native-android] 4/5 gradle assembleRelease"
"$APP/android/gradlew" -p "$APP/android" assembleRelease

APK="$APP/android/app/build/outputs/apk/release/app-release.apk"
echo "[native-android] 5/5 완료: $APK"
ls -lh "$APK"
