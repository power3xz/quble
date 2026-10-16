# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

manifest inline - `globalThis.__quble.manifests[manifestUrl]`에 값이 있으면 `fetch`를 건너뛰고 없으면
`fetch`하는 `loadManifest`를 두고, manifest를 읽는 세 곳(`runtime-entry.ts`, `ssr-page.mjs`의 생성
스크립트, `playground/index.html`)을 바꾼다(브랜치 `inline-manifest`).

- 남은 것: `loadManifest`와 단위 테스트, 호출처 세 곳 교체, HTML을 만드는 빌더가 `__quble`을 내게 하기

## 할 것

없음
