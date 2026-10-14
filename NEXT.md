# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

없음

## 할 것

runtime 해석기와 resume 해석기의 공통부 추출. `resume-interpreter.ts`에 복사해 둔 도우미와 타입
(`CONST`, `RAW`, `TScope`, `slotKind`, `slotRef`, `scopeWithIteration`, `TWalkStacks`,
`snapshotStacks`, `TSlotPlaceholderContent`)을 `vm.ts`의 export로 합친다. 두 해석기에 비슷하게 있는
`inlineFor`, `runIf`, region 만들기의 같은 부분은 뽑되, 분기(if/else)로 합치지 않는다.
