// TS Language Service plugin. `*.qubc.handlers.ts`에 짝 `.qubc`의 Handlers 타입을 붙인다 -
// 디스크에 d.ts를 쓰지도, 사용자가 import를 적지도 않는다.
//
// 짝 .qubc를 컴파일한 d.ts를 handlers.ts 스냅샷 앞에 한 줄로 얹고, `export const handlers`에
// 그 타입을 표기한다. tsserver만 이 스냅샷을 보고 디스크와 편집기 화면은 원본 그대로다.
//
// tsserver 안에서 도므로 vscode API를 쓸 수 없다. 확장은 등록만 하고(contributes.
// typescriptServerPlugins) 여기로 wasm 경로를 넘긴다.

import { existsSync } from "node:fs";
import type ts from "typescript/lib/tsserverlibrary";
import { dtsFor } from "./compiler.ts";
import { injectionFor, type TInjection, toInjected, toOriginal } from "./inject.ts";

const HANDLERS_SUFFIX = ".qubc.handlers.ts";

// 짝 .qubc가 있는지는 파일명당 한 번만 본다 - getScriptVersion/fileExists가 아주 자주 불려
// 그때마다 디스크를 치면 손해다. 없던 짝이 생기는 경우는 캐시하지 않는다(다음에 다시 본다).
const pairCache = new Map<string, string>();

/** 짝 .qubc의 경로. 대상이 아니면 null. */
const qubcFor = (fileName: string) => {
  if (!fileName.endsWith(HANDLERS_SUFFIX)) {
    return null;
  }
  const cached = pairCache.get(fileName);
  if (cached !== undefined) {
    return cached;
  }
  const qubc = fileName.slice(0, -".handlers.ts".length);
  if (!existsSync(qubc)) {
    return null;
  }
  pairCache.set(fileName, qubc);
  return qubc;
};

const init = ({ typescript: tsModule }: { typescript: typeof ts }) => {
  // tsserver는 configurePlugin을 plugin 모듈에 한 번만 전한다(프로젝트별이 아니다) -
  // create가 프로젝트마다 돌므로 그 핸들러를 모아 두고 전부에 뿌린다.
  const configListeners = new Set<(config: unknown) => void>();

  const create = (info: ts.server.PluginCreateInfo) => {
    const { languageServiceHost: host, project } = info;
    const log = (message: string) => project.projectService.logger.info(`[quble] ${message}`);

    // wasm 경로는 확장이 configurePlugin으로 넘긴다 - plugin은 자기가 어디 설치됐는지 모른다.
    // 확장 activate가 파일 열기보다 늦을 수 있어 create 시점에는 대개 비어 있다. 없다고
    // 그만두면 나중에 경로가 와도 프록시가 없어 영영 안 붙으므로, 프록시는 항상 걸고
    // 경로가 생길 때까지 주입만 건너뛴다.
    let wasmPath = "";

    // 가상 d.ts의 내용. 짝 .qubc가 그대로면 재컴파일하지 않는다 - 컴파일이 이 plugin에서
    // 제일 비싼 일이다.
    const dtsCache = new Map<string, { version: string; text: string }>();

    // handlers.ts의 주입 결과. getScriptSnapshot은 아주 자주 불리므로 원본이 그대로면
    // 다시 파싱하지 않는다(createSourceFile이 매 호출마다 도는 것을 막는다).
    const injections = new Map<string, TInjection>();
    const injectionCache = new Map<string, { source: string; version: string; injection: TInjection | null }>();

    // 짝 .qubc가 바뀌었는지는 handlers.ts 버전으로 알 수 없다 - .qubc 자체의 버전을 본다.
    const originalGetScriptVersion = host.getScriptVersion.bind(host);
    const qubcVersion = (qubcPath: string) => originalGetScriptVersion(qubcPath);

    // 주입 내용이 바뀌었음을 TS에 알리는 통로. TS는 두 단으로 거른다: 프로젝트 버전이
    // 그대로면 파일 버전을 묻지도 않고, 파일 버전이 그대로면 스냅샷을 다시 안 읽는다.
    // wasm 경로가 생기면 세대를 올려 두 단을 모두 통과시킨다.
    let generation = 0;

    host.getScriptVersion = (fileName) => {
      const version = originalGetScriptVersion(fileName);
      return qubcFor(fileName) === null ? version : `${version}#${generation}`;
    };

    const originalGetProjectVersion = host.getProjectVersion?.bind(host);
    if (originalGetProjectVersion !== undefined) {
      host.getProjectVersion = () => `${originalGetProjectVersion()}#${generation}`;
    }

    const dtsTextFor = (qubcPath: string) => {
      const version = qubcVersion(qubcPath);
      const cached = dtsCache.get(qubcPath);
      if (cached?.version === version) {
        return cached.text;
      }
      const text = dtsFor(qubcPath, wasmPath);
      dtsCache.set(qubcPath, { version, text });
      return text;
    };

    // --- host 프록시: handlers.ts 스냅샷을 주입본으로 바꿔치기한다 ---

    const originalGetScriptSnapshot = host.getScriptSnapshot.bind(host);
    host.getScriptSnapshot = (fileName) => {
      const snapshot = originalGetScriptSnapshot(fileName);
      const qubc = qubcFor(fileName);
      if (snapshot === undefined || qubc === null || wasmPath === "") {
        return snapshot;
      }

      // .qubc가 바뀌면 d.ts도 달라지므로 주입 캐시는 원본과 그 버전을 함께 본다.
      const source = snapshot.getText(0, snapshot.getLength());
      const version = qubcVersion(qubc);
      const cached = injectionCache.get(fileName);
      const fresh = cached?.source === source && cached.version === version;
      const injection = fresh ? cached.injection : injectionFor(tsModule, source, dtsTextFor(qubc));
      if (!fresh) {
        injectionCache.set(fileName, { source, version, injection });
      }

      if (injection === null) {
        injections.delete(fileName);
        return snapshot;
      }
      injections.set(fileName, injection);
      return tsModule.ScriptSnapshot.fromString(injection.text);
    };

    // --- 위치 보정: 주입한 줄의 컬럼이 밀린 것을 되돌린다 ---

    const service = info.languageService;
    const proxy: ts.LanguageService = Object.create(null);
    for (const key of Object.keys(service) as (keyof ts.LanguageService)[]) {
      const member = service[key];
      // biome-ignore lint/suspicious/noExplicitAny: LanguageService 전 메서드를 그대로 통과시킨다.
      (proxy as any)[key] = typeof member === "function" ? (member as any).bind(service) : member;
    }

    // 앞에 붙인 d.ts 안에서 난 진단은 사용자 코드가 아니므로 버린다.
    const inLead = (injection: TInjection, start: number | undefined) => start !== undefined && start < injection.lead;

    proxy.getSemanticDiagnostics = (fileName) => {
      const diagnostics = service.getSemanticDiagnostics(fileName);
      const injection = injections.get(fileName);
      if (injection === undefined) {
        return diagnostics;
      }
      return diagnostics
        .filter((diagnostic) => !inLead(injection, diagnostic.start))
        .map((diagnostic) =>
          diagnostic.start === undefined
            ? diagnostic
            : { ...diagnostic, start: toOriginal(injection, diagnostic.start) },
        );
    };

    proxy.getSyntacticDiagnostics = (fileName) => {
      const diagnostics = service.getSyntacticDiagnostics(fileName);
      const injection = injections.get(fileName);
      if (injection === undefined) {
        return diagnostics;
      }
      return diagnostics
        .filter((diagnostic) => !inLead(injection, diagnostic.start))
        .map((diagnostic) => ({ ...diagnostic, start: toOriginal(injection, diagnostic.start) }));
    };

    // 이 plugin의 목적 - 키 자리에서 fullname 후보를 띄운다.
    proxy.getCompletionsAtPosition = (fileName, position, options, formatting) => {
      const injection = injections.get(fileName);
      return service.getCompletionsAtPosition(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
        options,
        formatting,
      );
    };

    proxy.getCompletionEntryDetails = (fileName, position, entryName, formatting, sourceName, preferences, data) => {
      const injection = injections.get(fileName);
      return service.getCompletionEntryDetails(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
        entryName,
        formatting,
        sourceName,
        preferences,
        data,
      );
    };

    proxy.getDefinitionAtPosition = (fileName, position) => {
      const injection = injections.get(fileName);
      const definitions = service.getDefinitionAtPosition(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (definitions === undefined || injection === undefined) {
        return definitions;
      }
      // 주입한 d.ts로 가는 정의는 갈 곳이 없다(디스크에 없는 텍스트다) - 뺀다.
      return definitions
        .filter((definition) => definition.fileName !== fileName || !inLead(injection, definition.textSpan.start))
        .map((definition) =>
          definition.fileName === fileName
            ? {
                ...definition,
                textSpan: { ...definition.textSpan, start: toOriginal(injection, definition.textSpan.start) },
              }
            : definition,
        );
    };

    proxy.getQuickInfoAtPosition = (fileName, position) => {
      // 들어가는 위치는 주입본 기준으로 옮기고, 나오는 위치는 원본 기준으로 되돌린다.
      const injection = injections.get(fileName);
      const info = service.getQuickInfoAtPosition(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (info === undefined || injection === undefined) {
        return info;
      }
      return {
        ...info,
        textSpan: { ...info.textSpan, start: toOriginal(injection, info.textSpan.start) },
      };
    };

    // 확장이 configurePlugin으로 경로를 넘기면 여기로 온다. 그전에 만든 스냅샷은 주입이
    // 안 된 것이므로 캐시를 비우고 프로젝트를 다시 계산시킨다.
    const applyConfiguration = (config: unknown) => {
      const next = String((config as { wasmPath?: unknown } | undefined)?.wasmPath ?? "");
      if (next === wasmPath) {
        return;
      }
      if (next !== "" && !existsSync(next)) {
        log(`wasm 경로가 없습니다: ${next}`);
        return;
      }
      wasmPath = next;
      dtsCache.clear();
      injectionCache.clear();
      injections.clear();
      // 경로가 없던 동안 만든 스냅샷은 주입이 안 된 것이다 - 세대를 올려 버전을 바꾸고
      // 그래프를 다시 돌려 그 파일들을 다시 읽게 한다.
      generation += 1;
      project.updateGraph();
      project.refreshDiagnostics();
      log(`wasm 경로를 받았습니다: ${wasmPath}`);
    };

    configListeners.add(applyConfiguration);
    // create 시점에 이미 와 있는 경우도 있다(플러그인이 늦게 붙으면).
    applyConfiguration(info.config);

    log("활성화.");
    return proxy;
  };

  // tsserver가 부르는 자리는 여기다(plugin.module.onConfigurationChanged) - create가 돌려준
  // LanguageService가 아니다.
  const onConfigurationChanged = (config: unknown) => {
    for (const listener of configListeners) {
      listener(config);
    }
  };

  return { create, onConfigurationChanged };
};

export = init;
