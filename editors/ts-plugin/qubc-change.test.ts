// .qubc를 고쳐 저장하면 handlers.ts의 타입이 따라오는지. 이 경로가 끊긴 적이 있다 -
// handlers.ts 자신은 그대로인데 .qubc만 바뀌므로, 파일 버전에 짝의 버전을 섞지 않으면
// TS가 스냅샷을 다시 읽지 않아 주입이 옛 d.ts에 머문다.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import tsModule from "typescript";
import type ts from "typescript/lib/tsserverlibrary";
import { pluginInit } from "./src/plugin.ts";

// biome-ignore lint/suspicious/noExplicitAny: 런타임은 같은 모듈이다.
const tsAny = tsModule as any;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WASM = join(HERE, "..", "..", "core", "wasm-compiler", "compiler_wasm.wasm");

const DIR = mkdtempSync(join(tmpdir(), "quble-repro-"));
const FILE = join(DIR, "app.qubc.handlers.ts");
const QUBC = join(DIR, "app.qubc");
after(() => rmSync(DIR, { recursive: true, force: true }));

// 두 번째 인자는 템플릿에 두는 발생 지점 - d.ts는 실제로 쏘는 이벤트만 낸다(선언만으론 안 나온다).
const componentWith = (events: string, fires: string) =>
  ["component App {", `  events { ${events} }`, "  template {", `    ${fires}`, "  }", "}"].join("\n");

writeFileSync(QUBC, componentWith("CLICK({ }) LATER({ })", "div(@click:CLICK /)"));
writeFileSync(FILE, 'export const handlers = { CLICK: () => {}, LATER: () => {} };');

// 편집기처럼 파일 버전을 관리한다 - 저장할 때마다 올린다.
const versions = new Map<string, string>();
const bump = (file: string) => versions.set(file, String(Number(versions.get(file) ?? "0") + 1));

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => [FILE],
  getScriptVersion: (f) => versions.get(f) ?? "0",
  getScriptSnapshot: (f) => {
    const text = tsAny.sys.readFile(f);
    return text === undefined ? undefined : tsAny.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => DIR,
  getCompilationSettings: () => ({
    target: tsAny.ScriptTarget.ES2022,
    module: tsAny.ModuleKind.ESNext,
    strict: true,
    noEmit: true,
    // d.ts가 Event를 쓰므로 DOM lib이 있어야 한다 - 없으면 2304(이름 없음)로 덮인다.
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  }),
  getDefaultLibFileName: (o) => tsAny.getDefaultLibFilePath(o),
  fileExists: tsAny.sys.fileExists,
  readFile: tsAny.sys.readFile,
  readDirectory: tsAny.sys.readDirectory,
  getDirectories: tsAny.sys.getDirectories,
};

const plugin = pluginInit({ typescript: tsAny });
const info = {
  languageServiceHost: host,
  languageService: null as unknown as ts.LanguageService,
  project: { projectService: { logger: { info: () => {} } }, updateGraph: () => {}, refreshDiagnostics: () => {} },
  config: { wasmPath: WASM },
} as unknown as ts.server.PluginCreateInfo;
const service: ts.LanguageService = tsAny.createLanguageService(host);
info.languageService = service;
const proxy = plugin.create(info);

/** 지금 handlers.ts에 뜨는 진단 코드들. 2353 = 없는 이벤트명(초과 속성). */
const errorCodes = () => proxy.getSemanticDiagnostics(FILE).map((d) => d.code);

/** .qubc를 고쳐 저장한다 - 편집기가 하는 것과 같이 버전도 올린다. */
const saveQubc = (events: string, fires: string) => {
  writeFileSync(QUBC, componentWith(events, fires));
  bump(QUBC);
};

test("없는 이벤트를 핸들러에 적으면 오류다", () => {
  // LATER는 선언돼 있지만 아무도 안 쏜다 - 쏘는 것만 d.ts에 실리므로 핸들러에 적으면 걸린다.
  assert.deepEqual(errorCodes(), [2353]);
});

test(".qubc에 발생 지점을 더하면 그 오류가 사라진다", () => {
  saveQubc("CLICK({ }) LATER({ })", "div(@click:CLICK /) span(@click:LATER /)");
  assert.deepEqual(errorCodes(), [], "handlers.ts는 그대로인데 .qubc만 바뀌면 주입이 옛 d.ts에 머문다");
});

test(".qubc에서 발생 지점을 빼면 다시 오류다", () => {
  saveQubc("CLICK({ }) LATER({ })", "div(@click:CLICK /)");
  assert.deepEqual(errorCodes(), [2353], "지운 방향도 따라와야 한다");
});
