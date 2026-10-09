#!/usr/bin/env node
// SSR + resume 프리뷰 서버. build-preview.mjs가 만든 dist/preview를 정적으로 서빙하고, `/`만
// quble-ssr로 렌더한 HTML을 내준다. 페이지의 스크립트가 그 HTML을 노드를 새로 만들지 않고 이어받는다
// (compile(...)(0)(data, handlers, { resumeFrom, snapshot })).
//
// 사용: node serve-ssr-preview.mjs <dist/preview> <stem> <port> <quble-ssr 바이너리>
//   /          SSR HTML + leaf store 스냅샷(HTML에 JSON으로 실음) + resume. data를 따로 받지 않는다
//   /?data     SSR HTML + resume, data.json을 받아 plantRoot로 시작 - 스냅샷과 견주는 용도
//   /?nojs     SSR HTML만(스크립트 없음) - 서버가 보낸 그대로 본다
//   /?csr      SSR HTML 없이 클라이언트가 처음부터 그린다 - resume과 견주는 용도

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const [distDir, stem, portArg, ssrBin] = process.argv.slice(2);
if (!distDir || !stem || !portArg || !ssrBin) {
  console.error("usage: serve-ssr-preview.mjs <dist/preview> <stem> <port> <quble-ssr>");
  process.exit(1);
}
const port = Number(portArg);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".qubb": "application/octet-stream",
};

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// quble-ssr로 렌더한다. 리소스 URL은 클라이언트의 loadResource가 head에서 찾는 값(절대 URL)과 같아야 한다.
const renderSsr = (origin) => {
  const manifest = JSON.parse(readFileSync(join(distDir, `${stem}.manifest.json`), "utf8"));
  const base = new URL(`${stem}.qubb`, `${origin}/`);
  const urls = manifest.resources.map((path) => new URL(path, base).href);
  const started = performance.now();
  const run = spawnSync(ssrBin, [join(distDir, `${stem}.qubb`), join(distDir, "data.json"), ...urls], {
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
// `<`로 바꾼다 - JSON으로는 같은 값이고 `</script`나 `<!--`가 본문에서 태그를 닫지 못한다.
const snapshotJson = () => {
  const run = spawnSync(ssrBin, ["--snapshot", join(distDir, `${stem}.qubb`), join(distDir, "data.json")], {
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

// 컴포넌트 CSS의 절대 URL로 dist 안 파일을 읽는다. 런타임의 loadResource가 이 URL을 `data-qb-href`와 견줘
// 이미 넣었는지 안다.
const inlineResource = (href) => {
  const file = join(distDir, normalize(new URL(href).pathname));
  return `  <style data-qb-href="${escapeHtml(href)}">${inlineCss(readFileSync(file, "utf8"))}</style>`;
};

const page = (origin, mode) => {
  const { html, links, ms } = mode === "csr" ? { html: "", links: [], ms: 0 } : renderSsr(origin);
  const globalStyles = ["reset.css", "global.css"]
    .map((name) => `  <style>${inlineCss(readFileSync(join(distDir, name), "utf8"))}</style>`)
    .join("\n");
  const linkTags = links.map(inlineResource).join("\n");
  const snapshot = mode === "resume" ? snapshotJson() : null;
  const snapshotTag =
    snapshot === null ? "" : `\n  <script id="qb-snapshot" type="application/json">${snapshot}</script>`;
  const script =
    mode === "nojs"
      ? ""
      : `
  <script type="module">
    import { compile, loadHandlers, resume } from "./quble-resume.js";
    const status = document.getElementById("ssr-status");
    const app = document.getElementById("quble-app");
    const csr = ${mode === "csr"};
    const snapshotTag = document.getElementById("qb-snapshot");
    const snapshot = snapshotTag ? JSON.parse(snapshotTag.textContent) : null;
    const ssrNodes = app.querySelectorAll("*").length;
    const firstElement = app.firstElementChild;
    const base = new URL("./${stem}.qubb", location.href);
    const [manifest, bytes, data] = await Promise.all([
      fetch("./${stem}.manifest.json").then((r) => r.json()),
      fetch("./${stem}.qubb").then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      snapshot ? undefined : fetch("./data.json").then((r) => r.json()),
    ]);
    const handlers = await loadHandlers(manifest, base);
    const resources = manifest.resources.map((p) => new URL(p, base).href);
    const t0 = performance.now();
    try {
      const inst = csr
        ? compile(bytes, resources)(0)(data, handlers)
        : resume(bytes, resources)(0)(data, handlers, snapshot ? { resumeFrom: app, snapshot } : { resumeFrom: app });
      app.replaceChildren(...inst.nodes);
      const ms = (performance.now() - t0).toFixed(1);
      window.__quble = inst;
      status.textContent = csr
        ? "CSR: 처음부터 그림 " + ms + "ms"
        : "resume(" + (snapshot ? "스냅샷" : "data") + "): SSR 요소 " + ssrNodes + "개를 " + ms + "ms로 이어받음, 첫 요소 재사용 " + (app.firstElementChild === firstElement);
    } catch (error) {
      status.textContent = "resume 실패: " + error.message;
      status.className = "error";
      console.error(error);
    }
  </script>`;
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>${stem} (SSR)</title>
${globalStyles}
${linkTags}
  <style>
    #ssr-status { position: fixed; right: 8px; bottom: 8px; margin: 0; padding: 4px 8px; font: 12px monospace; background: #222; color: #9f9; }
    #ssr-status.error { color: #f99; }
  </style>
</head>
<body>
  <div id="quble-app">${html}</div>
  <p id="ssr-status">${mode === "nojs" ? `SSR만(스크립트 없음), 서버 렌더 ${ms.toFixed(1)}ms` : "..."}</p>${snapshotTag}${script}
</body>
</html>
`;
};

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") {
      const mode = ["nojs", "csr", "data"].find((name) => url.searchParams.has(name)) ?? "resume";
      const body = page(`http://${req.headers.host}`, mode);
      res.writeHead(200, { "content-type": TYPES[".html"] });
      res.end(body);
      return;
    }
    const file = join(distDir, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(distDir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(error.message ?? error));
  }
}).listen(port, () => {
  console.log(`[ssr-preview] http://localhost:${port}`);
});
