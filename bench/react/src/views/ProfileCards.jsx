import ProfileCard from "../ProfileCard.jsx";

// 자기완결 뷰 — 같은 ProfileCard를 데이터만 다르게 5장. (reactive-profilecard.html의 Quble 쪽과 동일 데이터)
// 데이터는 이 뷰가 들고, props 받는 ProfileCard를 import 한다.
const common = {
  followersLabel: "팔로워", followingLabel: "팔로잉", postsLabel: "게시물",
  locationIcon: "📍", companyIcon: "🏢",
  act1Icon: "✅", act1Time: "2시간 전", act2Icon: "⭐", act2Time: "어제", act3Icon: "💬", act3Time: "3일 전",
};
const people = [
  { name: "김에이", role: "엔지니어", bio: "백엔드와 컴파일러를 좋아합니다. 작게 만들고 빠르게 검증합니다.", avatar: "/img/a", link: "/u/a", theme: "light", followers: "1.2k", following: "180", posts: "342", location: "서울", company: "Quble Inc.", site: "/s/a", github: "/gh/a", twitter: "/tw/a", act1Text: "바이트코드 풀 최적화 머지", act2Text: "컴파일러 PR 리뷰", act3Text: "반응성 모델 논의", tag1: "rust", tag2: "compiler", tag3: "wasm", tag4: "ssr" },
  { name: "이비",   role: "디자이너", bio: "타이포그래피와 여백에 진심입니다. 손에 잡히는 디테일을 좋아합니다.", avatar: "/img/b", link: "/u/b", theme: "dark",  followers: "3.4k", following: "210", posts: "128", location: "부산", company: "Studio B", site: "/s/b", github: "/gh/b", twitter: "/tw/b", act1Text: "디자인 시스템 v2 공개", act2Text: "아이콘 세트 업데이트", act3Text: "컬러 토큰 정리", tag1: "figma", tag2: "type", tag3: "system", tag4: "a11y" },
  { name: "박시",   role: "PM",       bio: "문제를 잘게 쪼개고 우선순위를 세웁니다. 측정 없이는 결정하지 않습니다.", avatar: "/img/c", link: "/u/c", theme: "light", followers: "870",  following: "450", posts: "96",  location: "대전", company: "Flow", site: "/s/c", github: "/gh/c", twitter: "/tw/c", act1Text: "분기 로드맵 확정", act2Text: "지표 대시보드 개편", act3Text: "사용자 인터뷰 10건", tag1: "roadmap", tag2: "metrics", tag3: "growth", tag4: "ops" },
  { name: "최디",   role: "리서처",   bio: "읽고 쓰고 측정합니다. 모르는 것을 모른다고 적는 일을 합니다.", avatar: "/img/d", link: "/u/d", theme: "dark",  followers: "2.1k", following: "320", posts: "510", location: "제주", company: "Lab", site: "/s/d", github: "/gh/d", twitter: "/tw/d", act1Text: "벤치 결과 리포트 발행", act2Text: "논문 세미나 발표", act3Text: "실험 재현 스크립트 공개", tag1: "research", tag2: "bench", tag3: "paper", tag4: "data" },
  { name: "정이",   role: "프론트",   bio: "반응성 모델에 관심이 많습니다. 런타임을 작게 유지하려 애씁니다.", avatar: "/img/e", link: "/u/e", theme: "light", followers: "5.6k", following: "90",  posts: "233", location: "서울", company: "Quble Inc.", site: "/s/e", github: "/gh/e", twitter: "/tw/e", act1Text: "런타임 4kb 달성", act2Text: "합성 바인딩 구현", act3Text: "DOM 갱신 경로 단순화", tag1: "frontend", tag2: "reactive", tag3: "dom", tag4: "perf" },
];

// 초기 렌더 성능 — 같은 5명을 200번 반복해 1000장을 그린다.
const REPEAT = 200;
const all = [];
for (let r = 0; r < REPEAT; r++) {
  for (const p of people) {
    all.push(p);
  }
}

export default function ProfileCards() {
  return (
    <div className="cards">
      {all.map((p, i) => (
        <ProfileCard key={i} {...common} {...p} />
      ))}
    </div>
  );
}
