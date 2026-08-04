# Next

다음에 할 것과, 아직 정하지 못한 것. 처리하면 여기서 지운다 - 남아 있다는 건 아직
안 했거나 안 정했다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "그래서 다음에 뭘
하나"만 둔다.

## 할 것

### playground 핸들러의 타입 오류 (미해결, 이번 작업의 출발점)

`core/playground/playground.qubc.handlers.ts`가 `TStore`/`TCtx`를 **손으로 적어** 쓰는데, plugin이
주입하는 진짜 타입과 어긋난다. `withSink`가 그 `TCtx`로 핸들러를 받아 `handlers`에 넣으므로
대입 검사에서 걸린다.

어긋나는 지점은 조작 함수들이다. 손으로 적은 쪽은 `set: (leafIndex: number, value: unknown)`
인데 주입된 쪽은 `set: <T>(k: LeafIndex<T>, v: T) => void`다. `LeafIndex<T>`가
`number & { readonly __leaf: T }`라 `number`를 받을 수 없어 반공변 자리에서 막힌다.

**시도한 것과 결과** (2026-08-04):

- **`withSink`를 항등 래퍼로** - `<F extends (...args: never[]) => void | Promise<void>>(h: F): F`.
  래퍼가 타입을 만들지 않으므로 주입된 `Partial<Handlers>`가 인라인 화살표의 `data`/`ctx`까지
  흐른다. 실측으로 확인했다(음성 대조 3건 모두 잡힘).
- **`TCtx`를 `handlers`에서 역산** - `Parameters<NonNullable<(typeof handlers)[keyof typeof
  handlers]>>[1]`. 손으로 적는 타입이 없어지고 주입된 것이 유일한 출처가 된다. `$0`은
  `Extract<TCtx, { $0: number }>`로 뽑는다.
- **막힌 곳**: 위 둘을 실제 파일에 적용하면 plugin이 있을 때는 오류 0이지만, **plugin 없는
  `tsc`에서 순환 참조 16건**이 난다(`TCtx circularly references itself`). `TCtx`가 `typeof
  handlers`를 참조하고 handlers가 헬퍼를 부르고 헬퍼가 `TCtx`를 쓰는 닫힌 고리다. 주입이 있으면
  `handlers`에 타입 표기가 붙어 고리가 끊기지만, `npm run typecheck`는 주입 없이 돈다.

**정해야 할 것**: (1) 이 파일을 `tsc` 대상에서 빼고 plugin을 유일한 검사자로 삼을지, (2) 순환을
피하는 다른 역산 경로가 있는지, (3) 아니면 `LeafIndex`를 손으로 한 번 선언하고 `TCtx`를 그것에
맞춰 고칠지(이중 관리가 되지만 순환은 없다).

`store`가 d.ts에서 `any`라(`dts.rs` 주석: 루트 props를 시그니처마다 실어야 하고 대상 트리가
미정) 이 파일이 얻는 실제 타입 안전은 제한적이다 - 이 파일은 `store`를 20번 쓰고 `props`는 0번
쓴다. 그래서 오류 해결과 타입 안전은 별개로 봐야 한다.

### 병합된 브랜치 정리

`dts-array-ops`, `handler-autocomplete` 둘 다 main에 들어갔다(`git branch --merged main`).

## 정할 것

### wasm 크기 - dts를 feature로 가를지

`qb_handlers_dts`를 넣으면서 184,872 -> 227,047 바이트(+42KB, +23%)가 됐다. playground는 컴파일과
자동완성만 쓰고 d.ts는 안 쓰는데 그 비용을 문다(Cargo.toml 주석: "크기가 첫 로딩에 직결된다").

**끊을 자리**: 모듈 전체가 아니라 `dts.rs` 안의 타입 렌더링(`render`/`signature`/`*_to_ts`/
`PRELUDE`)만이다. 트리 순회(`collect`/`walk`)와 `handler_names`는 playground 자동완성이 쓰므로
항상 켜져 있어야 한다. feature 이름은 `dts`가 아니라 대상을 말해야 한다(후보: `handler-types`).

**미룬 이유**: wasm이 두 벌로 갈리고(`build:wasm`도 둘), playground와 확장이 서로 다른 것을 쓰게
된다. 그 복잡도가 42KB만큼 값어치가 있는지 아직 모른다.

### browser.ts의 wasm URL 기본값

`node.ts`는 `wasmPath()` 기본값이 있어 소비자가 경로를 몰라도 되지만 `browser.ts`는 URL을 항상
받아야 한다. `new URL("./compiler_wasm.wasm", import.meta.url)`을 기본값으로 두면 대칭이 된다.

**번들러별 지원** (직접 빌드해 확인):

| 번들러 | `new URL(..., import.meta.url)` | 설정 |
|---|---|---|
| Vite | 지원 | 없음 |
| webpack 5 | 지원 | 없음 |
| Parcel | 지원 | 없음 |
| Rollup | 미지원 | 플러그인 필요 |
| esbuild | **미지원** | 플러그인 필요 (evanw/esbuild#795, 열림) |

**미룬 이유**: 지금 유일한 브라우저 소비자(playground)가 esbuild를 쓴다. 적용하면 빌드는 통과하고
런타임에 404가 나는데, `build-playground.mjs`가 `.wasm`을 따로 복사해 실제로는 안 깨진다 - URL
결정이 두 곳으로 갈리는데 서로 모르는 상태가 된다. 두 번째 브라우저 소비자가 생겨 번들러가
정해지면 그때 판단한다.

### quble-dts 바이너리를 지울지

`core/src/bin/quble-dts.rs`. 확장이 마지막 사용자였는데 wasm으로 옮기면서 참조가 사라졌다
(레포 안에서 부르는 곳 없음).

**미룬 이유**: CLI로 d.ts를 뽑는 용도가 따로 필요한지 안 정했다. 필요 없으면 그 바이너리와
`handlers_dts_from_path`(파일에서 읽는 쪽)를 함께 지울 수 있다.

에디터 밖 타입 검사(ISSUES.md의 미해결 항목)를 빌드 스텝으로 붙이기로 하면 이쪽이 그 자리가
될 수 있다 - 위의 handlers.ts 타입 오류와도 맞물린다.

### 그 밖

- **playground가 `quble-web`을 선언 안 함** - `../web/runtime.ts`를 상대경로로 쓰면서
  `dependencies`에 없다. `quble-wasm-compiler`는 패키지 import로 바꿨으나 이쪽은 기존 방식
  그대로다.
- **`compile_src`/`compile_file`의 접미사** - dts 쪽은 `_src`를 떼고 `_file`을 `_from_path`로
  바꿨는데(같은 이유: `_src`가 안 읽힘) 컴파일 쪽은 그대로다. 함께 갈지 안 정했다.
