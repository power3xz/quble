# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

식 인스턴스의 표 의존 제거와 식 번호 조회 (브랜치 `expr-id-lookup`).

1. `TExprInstance.table` 필드를 없애고 `evaluator.skipTable(expr)`로 조회한다.
2. 모듈 로드 때 def별 `exprBase`를 계산해 `exprId = exprBase[compId] + exprIndex`로 `exprBytes`와 표를 배열에서 찾는다.
   바이트코드 포맷은 바꾸지 않는다.

## 할 것

없음
