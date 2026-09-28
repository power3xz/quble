// dist/를 서빙한다. 쿠키 enc(none|gzip|br)대로 응답을 압축하고, 캐시는 꺼서(no-store) 새로고침마다
// 실제로 다시 받게 한다. 압축 결과는 파일마다 한 번 만들어 메모리에 둔다(압축 시간이 로드에 섞이지 않게).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const PORT = Number(process.env.PORT ?? 8143);
const DIST = new URL(`./${process.env.DIST ?? "dist"}/`, import.meta.url).pathname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".qubb": "application/octet-stream",
};

const cache = new Map();
const bodyFor = (path, raw, enc) => {
  const key = `${path}|${enc}`;
  if (!cache.has(key)) {
    const body =
      enc === "gzip"
        ? gzipSync(raw, { level: 9 })
        : enc === "br"
          ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
          : raw;
    cache.set(key, body);
  }
  return cache.get(key);
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) {
    path += "index.html";
  }
  const raw = await readFile(join(DIST, path)).catch(() => null);
  if (!raw) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const enc = (req.headers.cookie ?? "").match(/(?:^|; )enc=(\w+)/)?.[1] ?? "none";
  const accepts = req.headers["accept-encoding"] ?? "";
  const use = (enc === "gzip" || enc === "br") && accepts.includes(enc) ? enc : "none";
  const headers = {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
    // Resource Timing이 파일 크기를 보여 주려면 필요하다(같은 origin이라 없어도 되지만 명시해 둔다).
    "timing-allow-origin": "*",
    // cross-origin isolation을 켜야 performance.now()가 0.1ms가 아니라 5us 단위로 잰다.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  };
  if (use !== "none") {
    headers["content-encoding"] = use;
    headers.vary = "cookie";
  }
  res.writeHead(200, headers);
  res.end(bodyFor(path, raw, use));
}).listen(PORT, () => console.log(`bench-expr: http://localhost:${PORT}`));
