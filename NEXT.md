# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

payload/context 변수 필드의 data 타입이 전부 `string`으로 나오는 문제(ISSUES.md) - `dts.rs`의
`value_type`이 `ArgValue::Var`를 선언 타입으로 따라가게 고친다. context 값은 `@with`를 쓴 쪽
컴포넌트의 props라 `context_stack`에 그 시점 props를 함께 싣는다.
