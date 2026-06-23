// profilecard.qubc와 동일 마크업으로 맞춘다 (공정 비교).
// Quble의 Thumbnail·Badge·Stat·MetaRow·LinkButton 합성에 대응해 컴포넌트도 분리한다.
// CSS도 컴포넌트별 파일로 분리해 import — Vite가 이 청크의 스타일로 묶는다(관용 방식).
import "./styles/profilecard.css";
import "./styles/thumbnail.css";
import "./styles/badge.css";
import "./styles/stat.css";
import "./styles/metarow.css";
import "./styles/activity.css";
import "./styles/tag.css";
import "./styles/linkbutton.css";

function Thumbnail({ avatar, name }) {
  return <img className="avatar" src={avatar} alt={name} />;
}

function Badge({ role, theme }) {
  return <span className={theme}>{role}</span>;
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="value">{value}</span>
      <span className="label">{label}</span>
    </div>
  );
}

function MetaRow({ icon, text }) {
  return (
    <p className="metarow">
      <span className="icon">{icon}</span>
      <span className="text">{text}</span>
    </p>
  );
}

function Activity({ icon, text, time }) {
  return (
    <div className="act">
      <span className="icon">{icon}</span>
      <span className="text">{text}</span>
      <span className="time">{time}</span>
    </div>
  );
}

function Tag({ text, theme }) {
  return <span className={theme}>#{text}</span>;
}

function LinkButton({ link, theme }) {
  return <a className={theme} href={link}>프로필 보기</a>;
}

export default function ProfileCard({
  name, role, bio, avatar, link, theme,
  followersLabel, followers, followingLabel, following, postsLabel, posts,
  locationIcon, location, companyIcon, company,
  site, github, twitter,
  act1Icon, act1Text, act1Time, act2Icon, act2Text, act2Time, act3Icon, act3Text, act3Time,
  tag1, tag2, tag3, tag4,
}) {
  return (
    <article className={theme}>
      <div className="header">
        <Thumbnail avatar={avatar} name={name} />
        <div className="ident">
          <h3 className="name">{name}</h3>
          <Badge role={role} theme={theme} />
        </div>
      </div>
      <p className="bio">{bio}</p>
      <div className="stats">
        <Stat label={followersLabel} value={followers} />
        <Stat label={followingLabel} value={following} />
        <Stat label={postsLabel} value={posts} />
      </div>
      <div className="meta">
        <MetaRow icon={locationIcon} text={location} />
        <MetaRow icon={companyIcon} text={company} />
      </div>
      <div className="activity">
        <Activity icon={act1Icon} text={act1Text} time={act1Time} />
        <Activity icon={act2Icon} text={act2Text} time={act2Time} />
        <Activity icon={act3Icon} text={act3Text} time={act3Time} />
      </div>
      <div className="tags">
        <Tag text={tag1} theme={theme} />
        <Tag text={tag2} theme={theme} />
        <Tag text={tag3} theme={theme} />
        <Tag text={tag4} theme={theme} />
      </div>
      <div className="links">
        <LinkButton link={site} theme={theme} />
        <LinkButton link={github} theme={theme} />
        <LinkButton link={twitter} theme={theme} />
      </div>
      <a className="profile" href={link}>전체 프로필 보기</a>
    </article>
  );
}
