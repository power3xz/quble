// card.qubc와 동일한 마크업·텍스트로 맞춘다 (공정 비교).
export default function Card() {
  return (
    <div className="card">
      <h2>Loaded from server</h2>
      <p>이 컴포넌트는 클라이언트가 qubb로 받아서 렌더했습니다.</p>
    </div>
  );
}
