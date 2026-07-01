// settingspanel.qubc와 동일 마크업 + 상호작용(상태·핸들러) 버전. 핸들러가 붙으면 프레임워크
// 앱 청크가 얼마나 커지는지 측정용. 정적 버전은 SettingsPanelStatic.jsx.
import { useState } from "react";
import "./styles/settings.css";
import "./styles/badge.css";
import "./styles/linkbutton.css";

function Badge({ role, theme }) {
  return <span className={theme}>{role}</span>;
}

function LinkButton({ link, theme }) {
  return <a className={theme} href={link}>프로필 보기</a>;
}

function SettingRow({ label, desc, badge, enabled, onToggle }) {
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__label">{label}</div>
        <p className="row__desc">{desc}</p>
      </div>
      <div className="row__control">
        {enabled ? (
          <>
            <Badge role={badge} theme="badge--on" />
            <button className="switch switch--on" onClick={onToggle}>켜짐</button>
          </>
        ) : (
          <button className="switch switch--off" onClick={onToggle}>꺼짐</button>
        )}
      </div>
    </div>
  );
}

function Section({ section }) {
  const [open, setOpen] = useState(section.open);
  const [a, setA] = useState(section.aEnabled);
  const [b, setB] = useState(section.bEnabled);
  return (
    <section className="section">
      <header className="section__head" onClick={() => setOpen((o) => !o)}>
        <h2 className="section__title">{section.title}</h2>
        {open ? (
          <span className="section__chevron section__chevron--open">접기</span>
        ) : (
          <span className="section__chevron">펼치기</span>
        )}
      </header>
      {open && (
        <div className="section__body">
          <SettingRow label={section.aLabel} desc={section.aDesc} badge={section.aBadge} enabled={a} onToggle={() => setA((v) => !v)} />
          <SettingRow label={section.bLabel} desc={section.bDesc} badge={section.bBadge} enabled={b} onToggle={() => setB((v) => !v)} />
        </div>
      )}
    </section>
  );
}

export default function SettingsPanel({ heading, plan, docsLink, general, privacy, premium }) {
  const [dirty, setDirty] = useState(true);
  return (
    <div className="panel">
      <header className="panel__head">
        <h1 className="panel__title">{heading}</h1>
        <div className="panel__actions">
          {dirty ? (
            <>
              <button className="btn btn--ghost" onClick={() => setDirty(false)}>되돌리기</button>
              <button className="btn btn--primary" onClick={() => setDirty(false)}>저장</button>
            </>
          ) : (
            <span className="panel__saved">저장됨</span>
          )}
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
