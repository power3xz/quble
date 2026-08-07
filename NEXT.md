# Next

지금 하는 일, 앞으로 할 일, 정해야 할 일. 항목은 섹션 사이를 옮겨 다니고(정할 것 -> 할 것 ->
하는 중), 끝나면 여기서 지운다 - 남아 있다는 건 아직 안 했거나 안 정했다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "그래서 지금 뭘 하고
다음에 뭘 하나"만 둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

- **CI에 검증 붙이기** - `pages.yml`이 빌드/배포만 하고 테스트를 안 돌린다. 배포 전 게이트로
  `cargo test`(199개) + `npm test`(346개) + `typecheck` + `lint`를 넣는다(`needs`로 build를
  막는다). 컴파일러(Rust)와 런타임(JS)이 qubb 계약으로 갈려 있어 한쪽만 고치면 조용히
  어긋나는데 그걸 잡을 관문이 없다(포맷 위반이 커밋된 채 남아 있던 것도 같은 이유).
  `paths` 필터가 그대로라 `editors/**`는 안 잡히고 `cancel-in-progress`도 그대로다 -
  독립 검증 워크플로가 필요해지면 그때 분리한다.
  **검증 대기** - 워크플로는 커밋했고 로컬은 CI와 같은 순서로 통과했다(cargo 199 /
  npm 346 / typecheck / lint). 남은 건 CI에서 실제로 도는 것 확인. GitHub 상태가 정상이
  아니라 push를 미뤘다(2026-08-07) - push해서 test job이 도는 걸 보면 지운다.

## 할 것

착수 조건이 다 된 것만 둔다. "무엇을 정한다"도 일이라 여기 온다 - 아래 "정할 것"은 지금
결정할 수 없어(조건이 안 왔거나 판단 근거가 없어) 묵혀 두는 쪽이다.

- **안 쓰는 `use` 트리셰이킹** (ISSUES: 안 쓰는 `use`) - use만 하고 합성 안 한 컴포넌트가 qubb에
  def로 들어간다. 컴파일러에 도달성 분석이 없다. 재현이 있고 범위가 컴파일러 안에 닫힌다.
- **`{expr}` 범위를 정한다** (ROADMAP: 템플릿) - 지금은 단순 변수 참조만 된다. 어디까지
  표현식으로 열지 정하는 것부터가 일이다.
- **SSR 렌더러 구현** (ROADMAP: 바이트코드/실행, ISSUES: renderer 보류) - 타입화된 상수풀에
  미대응이라 워크스페이스에서 `exclude`된 채 멈춰 있다. 되살리면 CI 검증 대상에도 들어온다.
- **leaf-store 메모리 레이아웃 문서** - leaves에 값이 어떻게 놓이고 alloc/free로 어떻게
  변하는지 그림으로 보인다. 지금은 leaf-store.ts 주석에만 있다(크기별 free list, 꼬리 회수
  vs 중간 반납, 재사용 경로). REACTIVITY #3.2는 배열 앵커의 정적 구조를 다루므로 그와
  경계를 그어야 하고, 파일명/위치도 정해야 한다.

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

한때 "에디터 밖 타입 검사를 붙이면 이쪽이 그 자리가 된다"고 봤으나 그 자리는 없어졌다 -
`editors/ts-plugin/typecheck-handlers.ts`가 wasm으로 d.ts를 얻어 검사한다(2026-08-04). 이 바이너리를
남길 이유는 이제 CLI 용도 하나뿐이다.

### 그 밖

- **playground가 `quble-web`을 선언 안 함** - `../web/runtime.ts`를 상대경로로 쓰면서
  `dependencies`에 없다. `quble-wasm-compiler`는 패키지 import로 바꿨으나 이쪽은 기존 방식
  그대로다.
- **`compile_src`/`compile_file`의 접미사** - dts 쪽은 `_src`를 떼고 `_file`을 `_from_path`로
  바꿨는데(같은 이유: `_src`가 안 읽힘) 컴파일 쪽은 그대로다. 함께 갈지 안 정했다.
