# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

배열 인덱스 접근을 주소 식(`rows[pivot]`)과 값 읽기 식(`LoadInput FieldAt ReadLeaf`)으로 떼어 내 바깥 식이
`LoadInput`으로 읽게 한다. `@for` 안에서 바깥 배열을 인덱스로 읽는 식이 root 인스턴스를 함께 사용한다. 바이트코드
형식은 그대로다. 런타임에서 건너뛰기 표의 `readLeafIndexOpsByVar`, `hasIndexAccess`와 READ_LEAF 구독 다시 걸기를
readLeaves 전후 비교로 줄인다. docs/expr-graph.draft.md "배열 접근".

## 할 것

없음
