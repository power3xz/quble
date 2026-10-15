# Next

지금 하는 일. 착수하면 여기 적고, 끝나면 "## 하는 중" 섹션의 진행중인 내용을 "없음"으로
바꾼다 - 남아 있다는 건 아직 안 끝났다는 뜻이다.

문제(증상/재현)는 ISSUES.md, 피처 진행은 ROADMAP.md에 있다. 여기는 "지금 뭘 하고 있나"만
둔다 - 본문을 옮겨 적지 말고 원문을 가리킨다.

## 하는 중

SSR이 내보내는 펴진 데이터의 이름을 snapshot에서 flat data로 바꾸고, 인스턴스의 snapshot이 타입과 위치를 받게 하기 (브랜치 flat-data)

- `TLeafSnapshot` -> `TFlatData` 등. 인스턴스의 `inst.snapshot()`(현재 값 읽기)은 이름을 유지한다.
- `inst.snapshot(typeRef?, base?, offset?)` - 생략하면 루트 props 전체.

## 할 것

없음
