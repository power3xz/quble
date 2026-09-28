# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

식 부분 재평가 - 식이 읽는 칸 하나가 바뀌면 그 칸을 품지 않은 부분식은 지난번 값을 쓴다
(docs/expr-partial-reeval.draft.md). 남은 것은 draft 7절.
`expr-array-index`에서 딴 브랜치라 끝나면 그 브랜치로 머지한다.

## 할 것

- 식 트리와 후위 표기를 잇는 설명 문서. 건너뛰기 표(core/web/expr-skip-table.ts)는 후위
  바이트만 봐서는 떠올리기 어렵다 - 트리에서 부분식, 가장 바깥 연산, 부모 연산이 무엇인지 보이고
  그것이 후위 바이트의 어느 위치로 옮겨지는지 잇는다. docs/expr-tree-rebind.draft.md,
  docs/expr-partial-reeval.draft.md를 정리하면서 어디에 둘지 정한다.
