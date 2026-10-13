#!/usr/bin/env node
// SSG - 빌드 때 SSR + resume 페이지를 정적 파일(index.html)로 쓴다. 서버 없는 정적 호스팅(GitHub Pages)용.
//
// 사용: node build-ssg.mjs <dist/preview> <stem> <quble-ssr 바이너리> [--assets-url <url>]
//   <dist/preview>  build-preview.mjs가 만든 디렉터리. 여기에 index.html을 쓴다(진입 페이지를 덮는다).
//   --assets-url    자산을 index.html과 다른 주소(CDN 등)에 올릴 때 그 주소. 없으면 index.html 기준 상대 경로.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPage } from "./ssr-page.mjs";

const args = process.argv.slice(2);
const flag = args.indexOf("--assets-url");
const assetsUrl = flag === -1 ? undefined : args.splice(flag, 2)[1];
const [distDir, stem, ssrBin] = args;
if (!distDir || !stem || !ssrBin || (flag !== -1 && !assetsUrl)) {
  console.error("usage: build-ssg.mjs <dist/preview> <stem> <quble-ssr> [--assets-url <url>]");
  process.exit(1);
}

writeFileSync(
  join(distDir, "index.html"),
  renderPage({ distDir, stem, ssrBin, assetsUrl, mode: "resume", showStatus: false }),
);
