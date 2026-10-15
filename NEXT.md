# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

진입점 이름과 층 맞추기 (브랜치 entry-rename)

- `mount.ts` -> `runtime-entry.ts`, 새 `resume-entry.ts`(SSR용 `mount`) - 진입점끼리 서로 의존하지 않는다.
- `loadHandlers`는 `load-handlers.ts`로 따로 뺀다.
- `ssr-page.mjs`의 csr 모드는 `quble-runtime.js`의 `compile`을 직접 쓴다.

## 할 것

없음
