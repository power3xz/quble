// 벤치 컴포넌트를 qubc와 jsx로 "같은 마크업·같은 데이터"로 펼쳐 생성한다.
// 둘 다 정적으로 펼쳐 인코딩 방식 차이를 배제한다. 데이터는 전부 다르게 둬서
// 상수풀 중복제거·gzip 반복압축이 한쪽에 부당하게 유리해지지 않게 한다.
import { writeFileSync } from "node:fs";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===== 구조-heavy: 상품 카드 그리드 (이커머스) =====
const adjectives = ["프리미엄", "클래식", "모던", "빈티지", "에코", "스마트", "컴팩트", "라이트", "프로", "베이직"];
const nouns = ["헤드폰", "백팩", "키보드", "텀블러", "스니커즈", "데스크램프", "노트북 스탠드", "블루투스 스피커", "기계식 마우스", "캔버스 토트백"];
const products = Array.from({ length: 24 }, (_, i) => ({
  name: `${adjectives[i % adjectives.length]} ${nouns[i % nouns.length]} ${100 + i}`,
  price: `${(19000 + i * 3700).toLocaleString("ko-KR")}원`,
  rating: (3.5 + ((i * 7) % 15) / 10).toFixed(1),
  reviews: `${(i * 37 + 12)}개 리뷰`,
  badge: i % 3 === 0 ? "베스트" : i % 3 === 1 ? "신상품" : "할인",
  img: `/img/product-${100 + i}.jpg`,
}));

function cardQubc(p) {
  return `      div(class="card") {
        div(class="thumb") { img(src="${p.img}" alt="${esc(p.name)}") {} }
        span(class="badge") { "${p.badge}" }
        h3(class="name") { "${esc(p.name)}" }
        div(class="meta") {
          span(class="price") { "${p.price}" }
          span(class="rating") { "★ ${p.rating}" }
          span(class="reviews") { "${p.reviews}" }
        }
        button(class="buy") { "장바구니 담기" }
      }`;
}
function cardJsx(p) {
  return `      <div className="card">
        <div className="thumb"><img src="${p.img}" alt="${esc(p.name)}" /></div>
        <span className="badge">${p.badge}</span>
        <h3 className="name">${esc(p.name)}</h3>
        <div className="meta">
          <span className="price">${p.price}</span>
          <span className="rating">★ ${p.rating}</span>
          <span className="reviews">${p.reviews}</span>
        </div>
        <button className="buy">장바구니 담기</button>
      </div>`;
}
function gridQubc() {
  return `component ProductGrid {\n  template {\n    div(class="grid") {\n${products.map(cardQubc).join("\n")}\n    }\n  }\n}\n`;
}
function gridJsx() {
  return `export default function ProductGrid() {\n  return (\n    <div className="grid">\n${products.map(cardJsx).join("\n")}\n    </div>\n  );\n}\n`;
}

// ===== 텍스트-heavy: 블로그 아티클 (문단마다 내용 다름) =====
const title = "정적 분석 기반 컴포넌트 언어를 설계하며 배운 것들";
const meta = "김개발 · 2026년 6월 17일 · 12분 읽기";
const blocks = [
  { h: null, p: "프론트엔드 프레임워크를 직접 설계하기 시작했을 때, 가장 먼저 부딪힌 질문은 이벤트의 정체를 무엇이 결정하느냐였다. 컴포넌트는 자신이 어디에 쓰일지 모른 채 추상적인 이벤트만 선언하고, 그 구체적인 의미는 합성되는 순간 결정되어야 한다고 생각했다." },
  { h: "왜 새로운 컴파일 언어인가", p: "타입 시스템만으로 이 모델을 구현하면 컴포넌트가 한 겹 중첩될 때마다 경로 누적 타입을 손으로 감싸 올려야 한다. 트리가 깊어질수록 이 보일러플레이트는 기하급수적으로 늘어난다. 합성 트리 정보는 이미 템플릿에 적혀 있는데 타입 시스템이 그것을 모르기 때문에 같은 정보를 두 번 적는 셈이다." },
  { h: null, p: "그래서 컴파일러가 템플릿의 합성 트리를 직접 읽어 풀네임 이벤트 식별자를 자동으로 생성하도록 했다. 개발자는 경로 누적을 한 번도 손으로 쓰지 않는다. 이 보일러플레이트 제거가 새 언어를 정당화하는 핵심 근거였다." },
  { h: "바이트코드를 본체로 선택하다", p: "실행 모델로는 바이트코드와 가상 머신을 택했다. 프레임워크별 트랜스파일도 후보였지만, 어떤 언어로도 런타임을 구현할 수 있어야 한다는 기술 중립 요건이 트랜스파일 우선 설계를 사실상 배제했다. 리액트로 변환하는 경로는 자바스크립트 생태계에 묶이기 때문이다." },
  { h: null, p: "바이트코드의 정체는 결국 바이트 배열이다. 메모리상의 구조체는 그 바이트를 다루기 위한 편의 표현일 뿐이며, 직렬화된 형태가 네트워크와 웹어셈블리 경계를 건넌다. 이 구분을 분명히 하자 컴파일러의 반환 타입부터 가상 머신의 입력까지 자연스럽게 정렬되었다." },
  { h: "서버와 클라이언트, 하나의 계약", p: "최초 요청에는 서버가 직접 HTML을 렌더링하고, 이후 필요한 컴포넌트는 컴파일된 바이트코드로 응답한다. 클라이언트는 그것을 받아 실제 DOM을 만든다. 서버는 러스트로, 클라이언트는 자바스크립트로 가상 머신을 구현했지만 둘은 완전히 같은 바이트코드 포맷을 공유한다." },
  { h: null, p: "이 지점에서 설계 초기에 내린 결정이 빛을 발했다. 바이트코드라는 안정적인 계약을 먼저 못박아 두었기에, 내부 구현을 여러 번 갈아엎는 동안에도 사용하는 쪽과 최종 출력은 한 번도 흔들리지 않았다. 변경에 강한 경계를 만든 것이다." },
  { h: "측정이 알려준 것", p: "같은 컴포넌트를 비동기로 로드할 때 네트워크 비용을 리액트와 비교해 보았다. 작은 컴포넌트에서는 바이트코드가 분명히 작았지만, 반복 구조가 많아지면 지퍼 압축이 리액트의 반복 패턴을 극적으로 줄여 격차가 좁혀졌다. 압축 전과 후를 같은 기준으로 비교해야 정직한 결론이 나온다는 것을 데이터가 보여주었다." },
  { h: null, p: "결국 중요한 것은 절대 크기보다 컴포넌트 수가 늘어날 때 누적되는 차이였다. 그리고 반복을 위한 명령이 언어에 추가되면, 펼쳐서 측정한 지금의 수치는 다시 크게 달라질 것이다." },
  { h: "다음 단계", p: "남은 큰 주제는 반응성이다. 클라이언트가 받은 바이트코드를 매번 해석할 것인지, 아니면 한 번 함수로 변환해 둘 것인지에 따라 가상 머신의 역할이 달라진다. 이 결정은 동적 리스트의 항목 단위 갱신 추적과 맞물려 있어, 인스턴스 식별 구조와 함께 풀어야 할 숙제로 남아 있다." },
];

function articleQubc() {
  const body = blocks
    .map((b) => {
      const h = b.h ? `      h2(class="sub") { "${esc(b.h)}" }\n` : "";
      return `${h}      p() { "${esc(b.p)}" }`;
    })
    .join("\n");
  return `component Article {
  template {
    article(class="post") {
      h1(class="title") { "${esc(title)}" }
      p(class="meta") { "${esc(meta)}" }
${body}
    }
  }
}
`;
}
function articleJsx() {
  const body = blocks
    .map((b) => {
      const h = b.h ? `      <h2 className="sub">${esc(b.h)}</h2>\n` : "";
      return `${h}      <p>${esc(b.p)}</p>`;
    })
    .join("\n");
  return `export default function Article() {
  return (
    <article className="post">
      <h1 className="title">${esc(title)}</h1>
      <p className="meta">${esc(meta)}</p>
${body}
    </article>
  );
}
`;
}

writeFileSync(new URL("./components/grid.qubc", import.meta.url), gridQubc());
writeFileSync(new URL("./components/article.qubc", import.meta.url), articleQubc());
writeFileSync(new URL("./react/src/ProductGrid.jsx", import.meta.url), gridJsx());
writeFileSync(new URL("./react/src/Article.jsx", import.meta.url), articleJsx());
console.log("generated grid.qubc, article.qubc, ProductGrid.jsx, Article.jsx");
