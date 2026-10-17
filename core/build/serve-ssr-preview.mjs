#!/usr/bin/env node
// SSR + resume 프리뷰 서버. build-preview.mjs가 만든 dist/preview를 정적으로 서빙하고, `/`만
// quble-ssr로 렌더한 HTML을 내준다. 페이지의 스크립트가 그 HTML을 노드를 새로 만들지 않고 resume한다
// (compile(...)(0)(data, handlers, { resumeFrom, flatData })). 페이지 조립은 ssr-page.mjs.
//
// 사용: node serve-ssr-preview.mjs <dist/preview> <stem> <port> <quble-ssr 바이너리>
//   /          SSR HTML + leaf store 펴진 데이터(HTML에 JSON으로 실음) + resume. data를 따로 받지 않는다
//   /?data     SSR HTML + resume, data.json을 받아 plantRoot로 시작 - 펴진 데이터와 견주는 용도
//   /?nojs     SSR HTML만(스크립트 없음) - 서버가 보낸 그대로 본다
//   /?csr      SSR HTML 없이 클라이언트가 처음부터 그린다 - resume과 견주는 용도

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { renderPage } from "./ssr-page.mjs";

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

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") {
      const mode = ["nojs", "csr", "data"].find((name) => url.searchParams.has(name)) ?? "resume";
      const body = renderPage({ distDir, stem, ssrBin, mode, showStatus: true });
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
