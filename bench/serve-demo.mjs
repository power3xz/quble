// React/Svelte/quble 데모 정적 서버 (bench-server가 보류된 renderer 의존으로 안 떠서 우회).
// prefix 매핑: /react/* -> react/dist, /svelte/* -> svelte/dist, /dist/* -> ./dist(quble qubb).
// /react/<Name>, /svelte/<Name>은 부트 HTML을 낸다 - _boot.js가 그 <Name> 뷰를 동적 import.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const PORT = 8140;
const ROOT = new URL(".", import.meta.url).pathname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".qubb": "application/octet-stream",
};

// /react/<Name> 같은 라우팅 경로용 부트 셸. _boot.js가 location 마지막 세그먼트를 뷰명으로 읽는다.
const bootPage = (bootSrc, name) =>
  `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>${name}</title></head>
<body>
  <div id="root"></div>
  <script type="module" src="${bootSrc}"></script>
</body></html>`;

const send = (res, status, body, type) => {
  res.writeHead(status, { "content-type": type ?? "text/plain" });
  res.end(body);
};

const serveFile = async (res, absPath) => {
  const buf = await readFile(absPath).catch(() => null);
  if (!buf) {
    send(res, 404, "not found");
    return;
  }
  send(res, 200, buf, MIME[extname(absPath)] ?? "application/octet-stream");
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);

  for (const [prefix, dist] of [["/react/", "react/dist"], ["/svelte/", "svelte/dist"]]) {
    if (path.startsWith(prefix + "assets/")) {
      await serveFile(res, join(ROOT, dist, path.slice(prefix.length)));
      return;
    }
    if (path.startsWith(prefix)) {
      const name = path.slice(prefix.length) || "index";
      send(res, 200, bootPage(`${prefix}assets/_boot.js`, name), MIME[".html"]);
      return;
    }
  }

  if (path.startsWith("/dist/")) {
    await serveFile(res, join(ROOT, "dist", path.slice("/dist/".length)));
    return;
  }

  send(res, 404, "not found");
}).listen(PORT, () => console.log(`demo server: http://localhost:${PORT}`));
