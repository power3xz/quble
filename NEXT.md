# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

`@for` 회차 안의 `@with` 컨텍스트 회수 (브랜치 context-release)

- `createdContexts`를 `Pool`로 바꾸고, 컨텍스트를 만든 branch가 기억했다가 `freeBranchTree`에서 반납한다.
- 근거와 증상은 ISSUES.md의 "createdContexts 회수". 막힌 이유로 적힌 것(핸들러 참조 시점)은 코드와 맞지 않는다 -
  이벤트 바인딩이 만들 때 `fields`를 복사해 발화는 `createdContexts`를 보지 않는다. ISSUES.md는 구현 뒤에 고친다.

## 할 것

없음
