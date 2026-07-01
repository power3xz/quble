<script>
  // 자기완결 뷰 — 설정 패널. props 표시 + @if 분기(상태관리 없음, quble settingspanel.qubc와 동일 UI).
  import Section from "../components/Section.svelte";
  import Badge from "../components/Badge.svelte";
  import LinkButton from "../components/LinkButton.svelte";
  import "../settings.css";

  const heading = "설정";
  let dirty = $state(true);
  const plan = "PRO";
  const docsLink = "/docs";

  const general = {
    title: "일반", open: true,
    aLabel: "다크 모드", aDesc: "어두운 테마를 사용합니다", aBadge: "ON", aEnabled: true,
    bLabel: "자동 저장", bDesc: "변경 사항을 자동으로 저장합니다", bBadge: "ON", bEnabled: false,
  };
  const privacy = {
    title: "개인정보", open: true,
    aLabel: "활동 표시", aDesc: "다른 사용자에게 활동을 공개합니다", aBadge: "공개", aEnabled: false,
    bLabel: "검색 허용", bDesc: "검색 결과에 프로필을 노출합니다", bBadge: "ON", bEnabled: true,
  };
  const premium = {
    title: "프리미엄 기능", open: false,
    aLabel: "우선 지원", aDesc: "24시간 우선 응대를 받습니다", aBadge: "PRO", aEnabled: true,
    bLabel: "고급 분석", bDesc: "상세 통계 대시보드를 엽니다", bBadge: "PRO", bEnabled: true,
  };
</script>

<div class="panel">
  <header class="panel__head">
    <h1 class="panel__title">{heading}</h1>
    <div class="panel__actions">
      {#if dirty}
        <button class="btn btn--ghost" onclick={() => (dirty = false)}>되돌리기</button>
        <button class="btn btn--primary" onclick={() => (dirty = false)}>저장</button>
      {:else}
        <span class="panel__saved">저장됨</span>
      {/if}
    </div>
  </header>

  <Section {...general} />
  <Section {...privacy} />

  <div class="panel__premium">
    <div class="panel__premium-head">
      <h2 class="panel__premium-title">프리미엄</h2>
      <Badge role={plan} theme="badge--pro" />
    </div>
    <Section {...premium} />
  </div>

  <footer class="panel__foot">
    <LinkButton link={docsLink} theme="btn--link" />
  </footer>
</div>
