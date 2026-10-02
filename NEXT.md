# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

- 한 `@for` 회차 안의 식/이벤트/`@if`가 스코프(`argumentSourcePairs`) 하나를 공유 - 회차마다 새
  배열을 만들고 push/pop과 지점별 복사를 없앤다. bench-krausest-quick, bench-expr로 전후 비교
- bench-expr 빠른 비교 추가 - `./bench-expr-quick.sh [기준 ref]`로 기준과 작업 트리의 quble mount 시간,
  mount 후 힙, 클릭 시간을 headless로 비교

## 할 것

없음
