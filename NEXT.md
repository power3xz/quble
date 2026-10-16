# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

React 어댑터(`experiments/react/adapter`)의 `createComponent`를 Next.js의 SSR 환경에서 쓸 수 있게 한다
(브랜치 `feat/react-ssr`). 지금은 서버가 빈 `<div>`만 낸다.

1. 서버 렌더 함수 - 가짜 DOM(jsdom)에서 `mount`한 뒤 HTML 문자열을 꺼낸다.
2. `createComponent`를 `exports`의 `browser` 조건으로 서버용/브라우저용 진입점으로 나눈다. 서버는 그 HTML을 낸다.
   브라우저는 컨테이너가 비어 있으면 `mount`, SSR HTML이 있으면 `resume`한다.
3. Next.js에서 `.qubc` import를 처리한다(지금은 Vite 플러그인뿐).
4. `experiments/react/next`에서 SSR 동작 확인, 스탠드얼론 Vite(`adapter-demo`)에서 CSR 동작 확인.

미확인: 가짜 DOM으로 직렬화한 HTML을 `resume`이 이어받는지(Rust SSR HTML 기준으로 만든 기능).

## 할 것

없음
