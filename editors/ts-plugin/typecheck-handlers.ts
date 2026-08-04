// *.qubc.handlers.ts를 에디터 밖에서 타입 검사한다. package.json의 typecheck가 tsc 뒤에 부른다.
//
// 이 파일들은 tsc로 볼 수 없다 - 핸들러 표의 타입(짝 .qubc의 Handlers)을 plugin이 편집기
// 스냅샷에만 주입하므로, 주입 없이 열면 ctx가 unknown이 되어 그것을 쓰는 곳이 전부 터진다.
// 손으로 적어 메우면 주입된 것과 어긋나 그쪽에서 다시 걸린다 - 출처가 둘일 수 없다.
// tsconfig의 plugins는 language service 전용이라 tsc가 무시한다(적어도 안 걸린다).
//
// 그래서 tsc 대신 LanguageService를 세우고 plugin을 올려, 편집기가 보는 것과 같은 주입본에
// 진단을 묻는다.
//
// plugin의 create가 host.getScriptSnapshot을 프록시한 뒤에 service를 만들어야 주입본이 보인다
// (proxy.test.ts와 같은 순서).

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tsModule from "typescript";
import type ts from "typescript/lib/tsserverlibrary";
import { pluginInit } from "./src/plugin.ts";

// biome-ignore lint/suspicious/noExplicitAny: tsserverlibrary 타입으로 받지만 런타임은 같은 모듈이다.
const tsAny = tsModule as any;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const WASM = join(ROOT, "core", "wasm-compiler", "compiler_wasm.wasm");

const targets: string[] = tsAny.sys
  .readDirectory(join(ROOT, "core"), [".ts"], ["node_modules"], undefined)
  .filter((path: string) => path.endsWith(".qubc.handlers.ts"));

if (targets.length === 0) {
  console.error("검사 대상(*.qubc.handlers.ts)이 없습니다.");
  process.exit(1);
}

// 루트 tsconfig와 같은 설정으로 본다 - 다른 기준으로 재면 여기서만 나는 오류가 생긴다.
const configFile = tsAny.readConfigFile(join(ROOT, "tsconfig.json"), tsAny.sys.readFile);
const { options } = tsAny.parseJsonConfigFileContent(configFile.config, tsAny.sys, ROOT);

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => targets,
  getScriptVersion: () => "0",
  getScriptSnapshot: (fileName) => {
    try {
      return tsAny.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
    } catch {
      return undefined;
    }
  },
  getCurrentDirectory: () => ROOT,
  getCompilationSettings: () => options,
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
  project: {
    projectService: { logger: { info: () => {} } },
    updateGraph: () => {},
    refreshDiagnostics: () => {},
  },
  config: { wasmPath: WASM },
} as unknown as ts.server.PluginCreateInfo;

const service: ts.LanguageService = tsAny.createLanguageService(host);
info.languageService = service;
const proxy = plugin.create(info);

// 진단의 위치는 plugin이 원본 기준으로 되돌려 준다 - 그대로 줄/열로 바꾸면 편집기와 같은 자리다.
let failed = 0;
for (const target of targets) {
  const source = readFileSync(target, "utf8");
  const lineStarts = tsAny.computeLineStarts(source);
  for (const diagnostic of [...proxy.getSemanticDiagnostics(target), ...proxy.getSyntacticDiagnostics(target)]) {
    failed++;
    const message = tsAny.flattenDiagnosticMessageText(diagnostic.messageText, "\n  ");
    const at =
      diagnostic.start === undefined
        ? ""
        : (() => {
            const { line, character } = tsAny.computeLineAndCharacterOfPosition(lineStarts, diagnostic.start);
            return `(${line + 1},${character + 1})`;
          })();
    console.error(`${relative(ROOT, target)}${at}: error TS${diagnostic.code}: ${message}`);
  }
}

console.error(failed === 0 ? `handlers: ${targets.length}개 파일, 오류 없음` : `handlers: 오류 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
