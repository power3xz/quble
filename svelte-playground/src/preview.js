// 미리보기 - 파일을 모두 등록하고 엔트리 .qubc를 wasm으로 컴파일해 두 번째 quble 인스턴스를
// 만든다. playground.qubc.handlers.ts의 runPreview를 셸에서 떼어낸 것으로, 컴파일과 마운트
// 절차는 그쪽과 같다(핸들러/data는 엔트리와 짝인 것만 쓴다).
//
// 셸이 Svelte라 store 대신 파일 배열을 그대로 받는다 - 그 외에는 원본과 같은 순서다.
import { lazyCompiler } from "quble-wasm-compiler/browser.ts";
import { compile as decodeQubb } from "../../core/web/runtime.ts";
// .wasm은 gitignore라 레포에 없다(cargo가 낸다). Vite가 자산으로 다루도록 URL로 받는다 -
// 빌드하면 해시 붙은 파일로 dist에 실린다.
import wasmUrl from "../../core/wasm-compiler/compiler_wasm.wasm?url";

const getCompiler = lazyCompiler(wasmUrl);

// 지금 떠 있는 인스턴스와 그때 만든 Blob URL들. 다시 컴파일할 때 정리한다.
// 스타일시트는 LOAD_RES가 document.head에 <link>로 달아 둔 것이라, URL만 revoke하면 죽은
// href를 가진 link가 head에 쌓인다 - 떼어낼 대상을 따로 들고 있는다.
let live = null;
let urls = [];
let linkedUrls = [];

/** 떠 있는 미리보기를 내리고 그때 만든 URL과 <link>를 정리한다. */
export const clearPreview = () => {
  live?.destroy();
  live = null;
  for (const url of linkedUrls) {
    document.querySelector(`link[href="${url}"]`)?.remove();
  }
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
  urls = [];
  linkedUrls = [];
};

// 컴파일러가 보는 파일만 - .qubc와 .css.
const compilerFiles = (files) =>
  Object.fromEntries(
    files.filter((f) => f.name.endsWith(".qubc") || f.name.endsWith(".css")).map((f) => [f.name, f.source]),
  );

const sourceOf = (files, name) => files.find((f) => f.name === name)?.source ?? "";

/**
 * 엔트리를 컴파일해 target에 마운트한다.
 * @param files   편집 중인 파일 전체(이름/소스)
 * @param entry   엔트리 .qubc 이름
 * @param target  마운트할 요소
 * @returns       성공이면 { ok: true }, 실패면 { ok: false, diagnostic }
 */
export const runPreview = async (files, entry, target) => {
  const stem = entry.replace(/\.qubc$/, "");
  const { compile } = await getCompiler();

  const result = compile(compilerFiles(files), entry);
  if (!result.ok) {
    return { ok: false, diagnostic: result.diagnostic };
  }

  // 사용자 핸들러는 브라우저에서 모듈로 평가한다(Blob URL + 동적 import).
  const handlersUrl = URL.createObjectURL(
    new Blob([sourceOf(files, `${stem}.qubc.handlers.js`) || "export const handlers = {}"], {
      type: "text/javascript",
    }),
  );
  let handlers = {};
  let initialData = {};
  try {
    handlers = (await import(/* @vite-ignore */ handlersUrl)).handlers ?? {};
    initialData = JSON.parse(sourceOf(files, `${stem}.data.json`) || "{}");
  } catch (e) {
    URL.revokeObjectURL(handlersUrl);
    return { ok: false, diagnostic: e.message };
  }

  // 여기부터 실패 지점이 없다 - 이전 미리보기를 내리고 새것을 올린다.
  clearPreview();
  urls.push(handlersUrl);

  // 리소스 경로(resId 순)를 그 내용의 Blob URL로 - LOAD_RES가 <link>로 단다.
  const resourceUrls = result.resources.map((path) => {
    const url = URL.createObjectURL(new Blob([sourceOf(files, path)], { type: "text/css" }));
    urls.push(url);
    linkedUrls.push(url);
    return url;
  });

  try {
    live = decodeQubb(result.bytecode, resourceUrls)(0)(initialData, handlers);
    target.replaceChildren(...live.nodes);
    return { ok: true };
  } catch (e) {
    return { ok: false, diagnostic: `mount: ${e.message}` };
  }
};
