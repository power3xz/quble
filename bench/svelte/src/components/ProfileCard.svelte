<script>
  // profilecard.qubc와 동일 마크업·합성으로 맞춘다 (공정 비교).
  import Thumbnail from "./Thumbnail.svelte";
  import Badge from "./Badge.svelte";
  import Stat from "./Stat.svelte";
  import MetaRow from "./MetaRow.svelte";
  import Activity from "./Activity.svelte";
  import Tag from "./Tag.svelte";
  import LinkButton from "./LinkButton.svelte";

  let {
    name, role, bio, avatar, link, theme,
    followersLabel, followers, followingLabel, following, postsLabel, posts,
    locationIcon, location, companyIcon, company,
    site, github, twitter,
    act1Icon, act1Text, act1Time, act2Icon, act2Text, act2Time, act3Icon, act3Text, act3Time,
    tag1, tag2, tag3, tag4,
  } = $props();
</script>

<article class={theme}>
  <div class="header">
    <Thumbnail {avatar} {name} />
    <div class="ident">
      <h3 class="name">{name}</h3>
      <Badge {role} {theme} />
    </div>
  </div>
  <p class="bio">{bio}</p>
  <div class="stats">
    <Stat label={followersLabel} value={followers} />
    <Stat label={followingLabel} value={following} />
    <Stat label={postsLabel} value={posts} />
  </div>
  <div class="meta">
    <MetaRow icon={locationIcon} text={location} />
    <MetaRow icon={companyIcon} text={company} />
  </div>
  <div class="activity">
    <Activity icon={act1Icon} text={act1Text} time={act1Time} />
    <Activity icon={act2Icon} text={act2Text} time={act2Time} />
    <Activity icon={act3Icon} text={act3Text} time={act3Time} />
  </div>
  <div class="tags">
    <Tag text={tag1} {theme} />
    <Tag text={tag2} {theme} />
    <Tag text={tag3} {theme} />
    <Tag text={tag4} {theme} />
  </div>
  <div class="links">
    <LinkButton link={site} {theme} />
    <LinkButton link={github} {theme} />
    <LinkButton link={twitter} {theme} />
  </div>
  <a class="profile" href={link}>전체 프로필 보기</a>
</article>

<style>
  article {
    max-width: 360px;
    margin: 0 auto;
    padding: 20px;
    border-radius: 12px;
    font: 14px/1.5 -apple-system, system-ui, sans-serif;
  }

  article.light {
    background: #f5f8fc;
    color: #2a3240;
    border: 1px solid #dde6f0;
  }

  article.dark {
    background: #1f2632;
    color: #cbd3df;
    border: 1px solid #2f3b4d;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .ident {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .name {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
  }

  .bio {
    margin: 14px 0;
    font-size: 13px;
    color: #6b727d;
  }

  .stats {
    display: flex;
    padding: 12px 0;
    border-top: 1px solid rgba(127, 127, 127, 0.18);
    border-bottom: 1px solid rgba(127, 127, 127, 0.18);
  }

  .meta,
  .activity {
    margin: 14px 0;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 14px 0;
  }

  .links {
    display: flex;
    gap: 8px;
    margin: 14px 0;
  }

  .profile {
    display: block;
    text-align: center;
    padding: 8px;
    border-radius: 8px;
    background: #4a90d9;
    color: #fff;
    text-decoration: none;
    font-weight: 600;
  }
</style>
