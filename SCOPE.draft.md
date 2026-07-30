# 슬롯/배열 미결 (draft)

> 상태: `array-type` 브랜치. 확정된 부분(슬롯 (kind,ref), 배열 arrayPool 앵커, plant, 배열의
> 배열 색인 연쇄)은 REACTIVITY.md #3.1/#3.2 / BYTECODE.md에 흡수됐다. 여기엔 **아직 구현 안 된
> 계획**만 남긴다.

## 배열 push/pop 반응 - 길이 토픽

지금 배열은 정적(plant가 초기 요소만 심고 늘고 줄지 않음). 동적으로 만들려면:

- 배열 길이를 store leaf(`sizeLeafIndex`)로 두고 arrayInfo가 가리킨다. leaf라서 구독이 걸린다.
- `push`: 원소 하나(elemSize칸)를 발급해 `elemStartLeafIndices`에 시작 위치 추가 +
  `store.set(sizeLeafIndex, 새 길이)` 통지. `@for` 몸체가 이미 가진 "원소 하나 심는 명령"을
  재사용한다(새 명령 불필요). 값은 핸들러가 준다(rootValue 무관).
- `pop`/제거: 그 leaf들을 freelist로 회수 + `elemStartLeafIndices`에서 제거. `truncateFor`가
  회차 branch를 회수하는 시점에 leaf도 함께.
- 길이 참조만 있고 안 변하면 leaf만 두고 구독은 건너뛴다.

## lazy plant - 안 쓰는 값 안 심기

지금은 안 쓰는 leaf까지 다 채운다(접근이 순수 `store.get`이라 단순). 큰 배열용 최적화로, 안 쓰는
값을 안 심는 방향. 그때 값 출처(rootValue 유지)와 미충전 표식을 다시 본다. 보통 규모에선 다 채워도
싸서 후순위.

## 객체 배열 원소 타입 참조

원소를 다시 객체로 조립(`assemble`)하려면 원소의 필드 열(step)이 필요한데, `elemSize`는 "몇 칸"만
알려주고 "어떤 모양"은 모른다. 원소 typeRef를 arrayInfo에 둘지 앵커 옆에 둘지 미결. 스칼라 배열
(elemSize=1, 조립 불필요)은 이 결정 없이 동작하므로 뒤로 미룰 수 있었다.

## PLANT_* opcode화

지금 plant는 런타임이 루트 타입 테이블을 순회해 심는다. 심기 절차를 컴파일러가 opcode 열
(`PLANT_LEAF`/`PLANT_ENTER`/`PLANT_ARRAY`)로 펼치면 런타임이 타입 테이블 순회 없이 명령만
실행한다. 지금 방식으로도 도므로 필요해질 때.
