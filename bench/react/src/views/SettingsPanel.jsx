import SettingsPanel from "../SettingsPanel.jsx";

// 자기완결 뷰 — 데이터를 들고 props 받는 SettingsPanel을 렌더. (Svelte SettingsPanel.svelte와 동일 데이터)
const data = {
  heading: "설정",
  dirty: true,
  plan: "PRO",
  docsLink: "/docs",
  general: {
    title: "일반", open: true,
    aLabel: "다크 모드", aDesc: "어두운 테마를 사용합니다", aBadge: "ON", aEnabled: true,
    bLabel: "자동 저장", bDesc: "변경 사항을 자동으로 저장합니다", bBadge: "ON", bEnabled: false,
  },
  privacy: {
    title: "개인정보", open: true,
    aLabel: "활동 표시", aDesc: "다른 사용자에게 활동을 공개합니다", aBadge: "공개", aEnabled: false,
    bLabel: "검색 허용", bDesc: "검색 결과에 프로필을 노출합니다", bBadge: "ON", bEnabled: true,
  },
  premium: {
    title: "프리미엄 기능", open: false,
    aLabel: "우선 지원", aDesc: "24시간 우선 응대를 받습니다", aBadge: "PRO", aEnabled: true,
    bLabel: "고급 분석", bDesc: "상세 통계 대시보드를 엽니다", bBadge: "PRO", bEnabled: true,
  },
};

export default function SettingsPanelView() {
  return <SettingsPanel {...data} />;
}
