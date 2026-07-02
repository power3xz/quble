// settingspanel.qubc와 동일 UI·동작. quble 핸들러는 open/enabled를 flip하지만 문자열이라
// @if가 불변(항상 열림/켜짐) - 눈에 보이는 변화는 title/label/heading 텍스트 마킹뿐이다.
// React도 그 동작에 맞춘다: 섹션은 항상 열림, 행은 항상 켜짐, 클릭은 텍스트만 마킹.
import { useState } from "react";
import "./styles/settings.css";
import "./styles/badge.css";
import "./styles/linkbutton.css";

// "제목" <-> "제목 (접힘)"처럼 상태 표시를 텍스트 뒤에 토글해 붙인다(quble의 mark와 동일).
const mark = (text, suffix) => (text.endsWith(suffix) ? text.slice(0, -suffix.length) : text + suffix);

function Badge({ role, theme }) {
  return <span className={theme}>{role}</span>;
}

function LinkButton({ link, theme }) {
  return <a className={theme} href={link}>프로필 보기</a>;
}

function SettingRow({ label: initialLabel, desc, badge }) {
  const [label, setLabel] = useState(initialLabel);
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__label">{label}</div>
        <p className="row__desc">{desc}</p>
      </div>
      <div className="row__control">
        <Badge role={badge} theme="badge--on" />
        <button className="switch switch--on" onClick={() => setLabel((l) => mark(l, " [ON]"))}>켜짐</button>
      </div>
    </div>
  );
}

function Section({ section }) {
  const [title, setTitle] = useState(section.title);
  return (
    <section className="section">
      <header className="section__head" onClick={() => setTitle((t) => mark(t, " (접힘)"))}>
        <h2 className="section__title">{title}</h2>
        <span className="section__chevron section__chevron--open">접기</span>
      </header>
      <div className="section__body">
        <SettingRow label={section.aLabel} desc={section.aDesc} badge={section.aBadge} />
        <SettingRow label={section.bLabel} desc={section.bDesc} badge={section.bBadge} />
      </div>
    </section>
  );
}

export default function SettingsPanel({ heading: initialHeading, plan, docsLink, general, privacy, premium }) {
  const [heading, setHeading] = useState(initialHeading);
  return (
    <div className="panel">
      <header className="panel__head">
        <h1 className="panel__title">{heading}</h1>
        <div className="panel__actions">
          <button className="btn btn--ghost" onClick={() => setHeading((h) => mark(h, " (되돌림)"))}>되돌리기</button>
          <button className="btn btn--primary" onClick={() => setHeading((h) => mark(h, " (저장됨)"))}>저장</button>
        </div>
      </header>

      <Section section={general} />
      <Section section={privacy} />

      <div className="panel__premium">
        <div className="panel__premium-head">
          <h2 className="panel__premium-title">프리미엄</h2>
          <Badge role={plan} theme="badge--pro" />
        </div>
        <Section section={premium} />
      </div>

      <footer className="panel__foot">
        <LinkButton link={docsLink} theme="btn--link" />
      </footer>
    </div>
  );
}
