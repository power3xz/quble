<script>
  // 자기완결 뷰 - settingspanel.qubc와 동일 UI·동작. quble 핸들러는 heading/title/label 텍스트
  // 마킹만 하므로(문자열 boolean이라 @if 불변) Svelte도 그에 맞춘다. data는 settingspanel.data.json.
  import Section from "../components/Section.svelte";
  import Badge from "../components/Badge.svelte";
  import LinkButton from "../components/LinkButton.svelte";
  import "../settings.css";

  let heading = $state("설정");
  const plan = "PRO";
  const docsLink = "#";
  const mark = (text, suffix) => (text.endsWith(suffix) ? text.slice(0, -suffix.length) : text + suffix);

  const general = {
    title: "일반",
    aLabel: "알림", aDesc: "푸시 알림 받기", aBadge: "새 기능",
    bLabel: "소리", bDesc: "효과음 재생", bBadge: "기본",
  };
  const privacy = {
    title: "개인정보",
    aLabel: "위치", aDesc: "위치 공유", aBadge: "권장",
    bLabel: "추적", bDesc: "활동 기록", bBadge: "주의",
  };
  const premium = {
    title: "프리미엄 기능",
    aLabel: "고급 분석", aDesc: "상세 리포트", aBadge: "PRO",
    bLabel: "우선 지원", bDesc: "빠른 응답", bBadge: "PRO",
  };
</script>

<div class="panel">
  <header class="panel__head">
    <h1 class="panel__title">{heading}</h1>
    <div class="panel__actions">
      <button class="btn btn--ghost" onclick={() => (heading = mark(heading, " (되돌림)"))}>되돌리기</button>
      <button class="btn btn--primary" onclick={() => (heading = mark(heading, " (저장됨)"))}>저장</button>
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
