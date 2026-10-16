# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

React 어댑터 시험 (브랜치 `react-adapter`, 위치 `experiments/react/adapter/`). `.qubc` import가
프레임워크 중립인 `TQubleBytecode`(Uint8Array)를 내고, 그 위에 React 층 `createComponent`를 얹는다.
같은 import를 순수 `mount`와 `createComponent` 두 경로로 검증한다.

- Vite 플러그인: `.qubc`를 wasm 컴파일러로 컴파일, `use`된 CSS는 생성 모듈의 CSS import로 넘겨 번들러가 처리한다.
- `createComponent(bytecode)`: props를 data로 mount, 핸들러는 예약 prop `handlers`로 그릴 때 받는다.
- 첫 단계 한계: props가 바뀌면 리마운트(이름 기준 `update(props)` 없음), 콜백 props 변환 없음.

## 할 것

없음
