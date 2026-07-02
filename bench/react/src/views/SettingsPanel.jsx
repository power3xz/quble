import SettingsPanel from "../SettingsPanel.jsx";

// 자기완결 뷰 - settingspanel.data.json(quble)과 동일 데이터. Section title은 quble에서 리터럴이고
// aLabel/bLabel 등은 gen*/priv*/pro* props에 대응한다.
const data = {
  heading: "설정",
  plan: "PRO",
  docsLink: "#",
  general: {
    title: "일반",
    aLabel: "알림", aDesc: "푸시 알림 받기", aBadge: "새 기능",
    bLabel: "소리", bDesc: "효과음 재생", bBadge: "기본",
  },
  privacy: {
    title: "개인정보",
    aLabel: "위치", aDesc: "위치 공유", aBadge: "권장",
    bLabel: "추적", bDesc: "활동 기록", bBadge: "주의",
  },
  premium: {
    title: "프리미엄 기능",
    aLabel: "고급 분석", aDesc: "상세 리포트", aBadge: "PRO",
    bLabel: "우선 지원", bDesc: "빠른 응답", bBadge: "PRO",
  },
};

export default function SettingsPanelView() {
  return <SettingsPanel {...data} />;
}
