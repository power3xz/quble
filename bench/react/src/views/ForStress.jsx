// forstress.qubc와 동일 구조로 맞춘다 (공정 비교).
// Quble의 Depth1 -> Depth2 -> Depth3 -> ProfileCard 3단 @for 중첩에 대응해
// 컴포넌트도 3단으로 분리하고 각 단이 @for처럼 map 반복한다. 10 x 100 x 100 = 100,000 카드.
// 카드 클릭 시 3뎁스 회차 인덱스를 콘솔에 찍는다 (Quble의 $0/$1/$2 fullname에 대응).
import "./ForStress.css";

const D1 = 10;
const D2 = 100;
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

function Depth1() {
  return Array.from({ length: D1 }, (_, i) => <Depth2 key={i} i={i} />);
}

export default function ForStress() {
  return (
    <div className="stress">
      <h1>react 부하: 10 x 100 x 100 = 100,000 카드</h1>
      <Depth1 />
    </div>
  );
}
