// greeting.qubc와 동일한 마크업으로 맞춘다 (기능 비교). name prop를 보간한다.
export default function Greeting({ name }) {
  return (
    <div className="card">
      <h3 className="name">안녕하세요, {name}님</h3>
      <p>props로 받은 이름이 보간됩니다.</p>
    </div>
  );
}
