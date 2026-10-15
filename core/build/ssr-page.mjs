// SSR + resume 페이지 한 장을 HTML 문자열로 만든다. 요청마다 만드는 프리뷰 서버(serve-ssr-preview.mjs)와
// 빌드 때 파일로 쓰는 SSG(build-ssg.mjs)가 같이 쓴다. build-preview.mjs가 만든 dist/preview를 읽는다.
// renderSsr, snapshotJson, inlineResource는 playground 빌드(build-playground.mjs)도 부른다.
//
// mode
//   resume  SSR HTML + leaf store 스냅샷(HTML에 JSON으로 실음) + resume. data를 따로 받지 않는다
//   data    SSR HTML + resume, data.json을 받아 plantRoot로 시작 - 스냅샷과 견주는 용도
//   nojs    SSR HTML만(스크립트 없음)
//   csr     SSR HTML 없이 클라이언트가 처음부터 그린다 - resume과 견주는 용도
// showStatus  오른쪽 아래에 이어받은 결과를 알리는 줄을 둔다(개발자 확인용).
// assetsUrl   자산(런타임 번들, qubb, manifest, data.json, 리소스 CSS)이 있는 주소. 없으면 이 페이지 기준
//             상대 경로(`./`)다. 자산을 다른 출처(CDN)에 올릴 때 준다.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// quble-ssr로 렌더한다. 리소스는 manifest의 상대 경로 그대로 넘기고 quble-ssr는 만난 것을 그대로 돌려준다.
// dataFile - 렌더할 data. 없으면 distDir의 data.json.
export const renderSsr = (distDir, stem, ssrBin, dataFile = join(distDir, "data.json")) => {
  const manifest = JSON.parse(readFileSync(join(distDir, `${stem}.manifest.json`), "utf8"));
  const started = performance.now();
  const run = spawnSync(ssrBin, [join(distDir, `${stem}.qubb`), dataFile, ...manifest.resources], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = performance.now() - started;
  if (run.status !== 0) {
    throw new Error(run.stderr || "quble-ssr 실패");
  }
  const links = run.stderr
    .split("\n")
    .filter((line) => line.startsWith("link: "))
    .map((line) => line.slice("link: ".length));
  return { html: run.stdout, links, ms };
};

// leaf store 스냅샷을 만든다(quble-ssr --snapshot). <script type="application/json"> 안에 넣으므로 `<`를
// 유니코드 이스케이프(u003c)로 바꾼다 - JSON으로는 같은 값이고 `</script`나 `<!--`가 본문에서 태그를 닫지 못한다.
export const snapshotJson = (distDir, stem, ssrBin, dataFile = join(distDir, "data.json")) => {
  const run = spawnSync(ssrBin, ["--snapshot", join(distDir, `${stem}.qubb`), dataFile], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(run.stderr || "quble-ssr --snapshot 실패");
  }
  return run.stdout.replace(/</g, "\\u003c");
};

// CSS를 <style>로 인라인한다 - 렌더를 막는 stylesheet 요청이 없어진다. `</style`이 본문에 있으면 태그가
// 일찍 닫히므로 `<\/`로 바꾼다.
const inlineCss = (css) => css.replace(/<\/(style)/gi, "<\\/$1");

// 컴포넌트 CSS를 dist 안 상대 경로로 읽어 인라인한다. 런타임의 resume이 `data-qb-href`를 문서 주소 기준으로 풀어
// 이미 넣었는지 안다.
export const inlineResource = (distDir, asset, path) => {
  const file = join(distDir, normalize(path));
  return `  <style data-qb-href="${escapeHtml(asset(path))}">${inlineCss(readFileSync(file, "utf8"))}</style>`;
};

export const renderPage = ({ distDir, stem, ssrBin, assetsUrl, mode, showStatus }) => {
  // 자산을 가리키는 주소. assetsUrl이 없으면 이 페이지 기준 상대 경로, 있으면 그 주소 아래.
  const asset = (path) => (assetsUrl ? `${assetsUrl.replace(/\/+$/, "")}/${path}` : `./${path}`);
  const { html, links, ms } = mode === "csr" ? { html: "", links: [], ms: 0 } : renderSsr(distDir, stem, ssrBin);
  const globalStyles = ["reset.css", "global.css"]
    .map((name) => `  <style>${inlineCss(readFileSync(join(distDir, name), "utf8"))}</style>`)
    .join("\n");
  const linkTags = links.map((path) => inlineResource(distDir, asset, path)).join("\n");
  const snapshot = mode === "resume" ? snapshotJson(distDir, stem, ssrBin) : null;
  const snapshotTag =
    snapshot === null ? "" : `\n  <script id="qb-snapshot" type="application/json">${snapshot}</script>`;
  // 상태 표시줄(showStatus)을 쓰는 스크립트 조각. 끄면 코드째 빠진다.
  const statusInit = showStatus
    ? `
    const status = document.getElementById("ssr-status");
    const ssrNodes = app.querySelectorAll("*").length;
    const firstElement = app.firstElementChild;`
    : "";
  const statusDone = showStatus
    ? `
      const ms = (performance.now() - t0).toFixed(1);
      status.textContent = csr
        ? "CSR: 처음부터 그림 " + ms + "ms"
        : "resume(" + (snapshot ? "스냅샷" : "data") + "): SSR 요소 " + ssrNodes + "개를 " + ms + "ms로 이어받음, 첫 요소 재사용 " + (app.firstElementChild === firstElement);`
    : "";
  const statusFail = showStatus
    ? `
      status.textContent = "resume 실패: " + error.message;
      status.className = "error";`
    : "";
  const script =
    mode === "nojs"
      ? ""
      : `
  <script type="module">
    import { loadHandlers, ${mode === "csr" ? "mount" : "resume"} } from "${asset(mode === "csr" ? "quble-runtime.js" : "quble-resume.js")}";
    const app = document.getElementById("quble-app");
    const csr = ${mode === "csr"};
    const snapshotTag = document.getElementById("qb-snapshot");
    const snapshot = snapshotTag ? JSON.parse(snapshotTag.textContent) : null;${statusInit}
    const base = new URL("${asset(`${stem}.qubb`)}", location.href);
    const [manifest, bytes, data] = await Promise.all([
      fetch("${asset(`${stem}.manifest.json`)}").then((r) => r.json()),
      fetch("${asset(`${stem}.qubb`)}").then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      snapshot ? undefined : fetch("${asset("data.json")}").then((r) => r.json()),
    ]);
    const handlers = await loadHandlers(manifest, base);
    const resources = manifest.resources.map((p) => new URL(p, base).href);
    const t0 = performance.now();
    try {
      window.__quble = csr
        ? mount(bytes, app, { data, handlers, resources })
        : resume(bytes, app, { snapshot, data, handlers, resources });${statusDone}
    } catch (error) {${statusFail}
      console.error(error);
    }
  </script>`;
  const statusStyle = showStatus
    ? `
  <style>
    #ssr-status { position: fixed; right: 8px; bottom: 8px; margin: 0; padding: 4px 8px; font: 12px monospace; background: #222; color: #9f9; }
    #ssr-status.error { color: #f99; }
  </style>`
    : "";
  const statusLine = showStatus
    ? `
  <p id="ssr-status">${mode === "nojs" ? `SSR만(스크립트 없음), 서버 렌더 ${ms.toFixed(1)}ms` : "..."}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>${stem} (SSR)</title>
${globalStyles}
${linkTags}${statusStyle}
</head>
<body>
  <div id="quble-app">${html}</div>${statusLine}${snapshotTag}${script}
</body>
</html>
`;
};
