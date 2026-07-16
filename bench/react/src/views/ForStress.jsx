// forstress.qubc와 동일 구조로 맞춘다 (공정 비교).
// Quble의 Depth1 -> Depth2 -> Depth3 -> ProfileCard 3단 @for 중첩에 대응해
// 컴포넌트도 3단으로 분리하고 각 단이 @for처럼 map 반복한다. 10 x 100 x 100 = 100,000 카드.
// 카드 클릭 시 3뎁스 회차 인덱스를 콘솔에 찍는다 (Quble의 $0/$1/$2 fullname에 대응).
import { useEffect, useState } from "react";
import "./ForStress.css";

const D1 = 1;
const D2 = 50;
const D3 = 100;

function ProfileCard({ i, j, k }) {
  const onClick = () => {
    console.log("card clicked", { $0: i, $1: j, $2: k });
  };
  return (
    <div className="card" onClick={onClick}>
      <div className="card__name">Jane Doe</div>
      <div className="card__job">Engineer</div>
      <div className="card__loc">Seoul</div>
    </div>
  );
}

function Depth3({ i, j }) {
  return Array.from({ length: D3 }, (_, k) => (
    <ProfileCard key={k} i={i} j={j} k={k} />
  ));
}

function Depth2({ i }) {
  return Array.from({ length: D2 }, (_, j) => <Depth3 key={j} i={i} j={j} />);
}

function Depth1({ rows }) {
  return Array.from({ length: rows }, (_, i) => <Depth2 key={i} i={i} />);
}

export default function ForStress() {
  const [rows, setRows] = useState(D1);
  // 초기 렌더 계측: 트리 생성 시작(본문 진입) -> 커밋 후(useEffect) -> 페인트 후(rAF).
  // 세 프레임워크(quble/react/svelte)를 같은 방식으로 재 나란히 비교한다.
  const t0 = performance.now();
  useEffect(() => {
    const committed = performance.now();
    requestAnimationFrame(() => {
      const painted = performance.now();
      console.log(
        `[react] 트리+커밋 ${(committed - t0).toFixed(1)}ms, 페인트까지 ${(painted - t0).toFixed(1)}ms`,
      );
    });
  }, []);
  // 행 추가(+5,000 카드) 계측 - quble ADD 핸들러와 같은 방식(클릭 t0 -> rAF).
  const addRow = () => {
    const t = performance.now();
    setRows((r) => r + 1);
    requestAnimationFrame(() => {
      console.log(`[react] 행 추가(+5,000) ${(performance.now() - t).toFixed(1)}ms`);
    });
  };
  return (
    <div className="stress">
      <h1>react 부하: rows x 50 x 100 카드</h1>
      <button className="stress__add" onClick={addRow}>행 추가 (+5,000 카드)</button>
      <Depth1 rows={rows} />
    </div>
  );
}
