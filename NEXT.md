# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

runtime에서 resume 코드를 걷어내기 위해 runtime 해석기와 resume 해석기를 대등하게 나눈다. 둘은
공통 객체 `VM`의 `interpreter` 필드에 끼워지고, 첫 그리기 뒤에 `VM`이 resume 해석기를 runtime
해석기로 바꾼다. 1) `Interpreter` 클래스를 `VM`(`vm.ts`)으로 이름 변경. 2) 바이트코드를 해석하는
멤버를 `RuntimeInterpreter`(`runtime-interpreter.ts`)로 이동하고 `TInterpreter`(`interpreter.ts`)를
정의. 3) `ResumeInterpreter`가 `VM`에만 기대도록 변경하고 첫 그리기 뒤 `vm.interpreter`를 교체.
4) 공통부 추출. `resume-split` 브랜치.

## 할 것

없음
