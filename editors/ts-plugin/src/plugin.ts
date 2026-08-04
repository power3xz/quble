// TS Language Service plugin. `*.qubc.handlers.ts`에 짝 `.qubc`의 Handlers 타입을 붙인다 -
// 디스크에 d.ts를 쓰지도, 사용자가 import를 적지도 않는다.
//
// 짝 .qubc를 컴파일한 d.ts를 handlers.ts 스냅샷 앞에 한 줄로 얹고, `handlers` 선언에 그
// 타입을 표기한다. tsserver만 이 스냅샷을 보고 디스크와 편집기 화면은 원본 그대로다.
//
// tsserver 안에서 도므로 vscode API를 쓸 수 없다. 확장은 등록만 하고(contributes.
// typescriptServerPlugins) 여기로 wasm 경로를 넘긴다.

import { existsSync } from "node:fs";
import type ts from "typescript/lib/tsserverlibrary";
import { dtsFor } from "./compiler.ts";
import {
  callHierarchyItemToOriginal,
  fileEditsToOriginal,
  injectionFor,
  isInjected,
  locationToOriginal,
  positionOrRangeToInjected,
  spanToOriginal,
  type TInjection,
  toInjected,
  toOriginal,
} from "./inject.ts";

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

/**
 * plugin 본체. tsserver가 부르는 진입점(`index.ts`)이 이것을 그대로 내보낸다 - 그쪽은
 * `export =`(CJS)라야 하는데 그 형식은 named export와 함께 쓸 수 없어, 테스트가 잡을 수
 * 있도록 로직을 이 파일에 두고 진입점은 한 줄짜리 shim으로 남긴다.
 */
export const pluginInit = ({ typescript: tsModule }: { typescript: typeof ts }) => {
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
    // 캐시 판정과 아래 버전 문자열이 이것을 함께 쓴다.
    const originalGetScriptVersion = host.getScriptVersion.bind(host);
    const qubcVersion = (qubcPath: string) => originalGetScriptVersion(qubcPath);

    // 주입 내용이 바뀌었음을 TS에 알리는 통로. TS는 두 단으로 거른다: 프로젝트 버전이
    // 그대로면 파일 버전을 묻지도 않고, 파일 버전이 그대로면 스냅샷을 다시 안 읽는다.
    // wasm 경로가 생기면 세대를 올려 두 단을 모두 통과시킨다.
    let generation = 0;

    // handlers.ts의 버전에 짝 .qubc의 버전을 섞는다. handlers.ts 자신은 그대로인데 .qubc만
    // 바뀌는 경우가 흔한데(이벤트 추가/삭제), 그때 버전이 그대로면 TS가 스냅샷을 다시 읽지
    // 않아 주입이 옛 d.ts에 머문다 - 편집기에서 .qubc를 고쳐도 타입이 안 따라온다.
    host.getScriptVersion = (fileName) => {
      const version = originalGetScriptVersion(fileName);
      const qubc = qubcFor(fileName);
      return qubc === null ? version : `${version}#${generation}#${qubcVersion(qubc)}`;
    };

    // 프로젝트 버전에도 같은 것이 필요하다 - 파일 버전이 바뀌어도 프로젝트 버전이 그대로면
    // TS가 파일 버전을 묻지도 않는다. 어느 .qubc가 바뀌었는지는 여기서 모르므로 짝이 있는
    // 파일들의 버전을 모아 잇는다.
    const originalGetProjectVersion = host.getProjectVersion?.bind(host);
    if (originalGetProjectVersion !== undefined) {
      host.getProjectVersion = () => {
        const qubcVersions = (host.getScriptFileNames() ?? [])
          .map(qubcFor)
          .filter((qubc): qubc is string => qubc !== null)
          .map(qubcVersion)
          .join(",");
        return `${originalGetProjectVersion()}#${generation}#${qubcVersions}`;
      };
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

    // 오프셋을 줄/열로 바꾸는 자리. tsserver가 응답을 만들 때 두 갈래로 나뉜다:
    // textSpan은 열린 파일 버퍼(scriptInfo, 원본)로 세고, definitions/references는 이것으로
    // 센다(주입본). 우리가 스팬을 원본 기준으로 되돌려 내보내므로 이쪽도 원본으로 세야
    // 한다 - 그러지 않으면 정의 위치만 lead만큼 밀려 엉뚱한 줄로 점프한다.
    proxy.toLineColumnOffset = (fileName, position) => {
      const injection = injections.get(fileName);
      const base = service.toLineColumnOffset?.(fileName, position);
      if (injection === undefined || base === undefined) {
        return base ?? { line: 0, character: 0 };
      }
      return service.toLineColumnOffset?.(fileName, toInjected(injection, position)) ?? base;
    };

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

    // 위치를 하나 받아 위치 목록을 내는 것들(정의/타입정의/구현/참조/강조)은 보정이 같다:
    // 들어가는 position은 주입본으로, 나오는 스팬은 원본으로. 주입한 d.ts로 떨어지는 결과는
    // 갈 곳이 없어(디스크에 없는 텍스트다) 버린다.
    const atPosition = <T extends { fileName?: string; textSpan: ts.TextSpan; contextSpan?: ts.TextSpan }>(
      fileName: string,
      position: number,
      query: (at: number) => readonly T[] | undefined,
    ) => {
      const injection = injections.get(fileName);
      const found = query(injection === undefined ? position : toInjected(injection, position));
      if (found === undefined || injection === undefined) {
        return found;
      }
      const ours = (item: T) => item.fileName === undefined || item.fileName === fileName;
      return found
        .filter((item) => !ours(item) || !inLead(injection, item.textSpan.start))
        .map((item) => locationToOriginal(injection, fileName, item));
    };

    proxy.getDefinitionAtPosition = (fileName, position) =>
      atPosition(fileName, position, (at) => service.getDefinitionAtPosition(fileName, at));

    // 편집기(VS Code)가 Go to Definition에 실제로 쓰는 것은 이쪽이다 - definitions만 고쳐
    // 두면 정작 점프가 주입본 좌표로 나가 엉뚱한 자리에 내려앉는다.
    proxy.getDefinitionAndBoundSpan = (fileName, position) => {
      const injection = injections.get(fileName);
      const result = service.getDefinitionAndBoundSpan(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (result === undefined || injection === undefined) {
        return result;
      }
      const definitions = result.definitions
        ?.filter((definition) => definition.fileName !== fileName || !inLead(injection, definition.textSpan.start))
        .map((definition) => locationToOriginal(injection, fileName, definition));
      // textSpan은 커서 밑 낱말의 범위다 - 이것이 어긋나면 밑줄과 클릭 판정이 밀린다.
      return { ...result, definitions, textSpan: spanToOriginal(injection, result.textSpan) };
    };

    proxy.getTypeDefinitionAtPosition = (fileName, position) =>
      atPosition(fileName, position, (at) => service.getTypeDefinitionAtPosition(fileName, at));

    proxy.getImplementationAtPosition = (fileName, position) =>
      atPosition(fileName, position, (at) => service.getImplementationAtPosition(fileName, at));

    proxy.getReferencesAtPosition = (fileName, position) => {
      const found = atPosition(fileName, position, (at) => service.getReferencesAtPosition(fileName, at));
      return found === undefined ? undefined : [...found];
    };

    // 참조는 한 겹 더 싸여 있다 - 심볼마다 references 배열을 들고, 그 심볼의 정의 위치도
    // 따로 갖는다(definition.textSpan). 둘 다 되돌려야 목록과 미리보기가 맞는다.
    proxy.findReferences = (fileName, position) => {
      const injection = injections.get(fileName);
      const symbols = service.findReferences(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (symbols === undefined || injection === undefined) {
        return symbols;
      }
      return symbols.map((symbol) => ({
        ...symbol,
        definition: locationToOriginal(injection, fileName, symbol.definition),
        references: symbol.references
          .filter((reference) => reference.fileName !== fileName || !inLead(injection, reference.textSpan.start))
          .map((reference) => locationToOriginal(injection, fileName, reference)),
      }));
    };

    // 같은 심볼 강조. 파일마다 스팬 묶음이 오므로 우리 파일 것만 되돌린다.
    proxy.getDocumentHighlights = (fileName, position, filesToSearch) => {
      const injection = injections.get(fileName);
      const highlights = service.getDocumentHighlights(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
        filesToSearch,
      );
      if (highlights === undefined || injection === undefined) {
        return highlights;
      }
      return highlights.map((entry) =>
        entry.fileName !== fileName
          ? entry
          : {
              ...entry,
              highlightSpans: entry.highlightSpans
                .filter((span) => !inLead(injection, span.textSpan.start))
                .map((span) => ({
                  ...span,
                  textSpan: spanToOriginal(injection, span.textSpan),
                  ...(span.contextSpan === undefined
                    ? {}
                    : { contextSpan: spanToOriginal(injection, span.contextSpan) }),
                })),
            },
      );
    };

    // 이름 바꾸기. 여기가 어긋나면 색이 아니라 소스가 실제로 깨진다 - 편집기가 이 위치를
    // 그대로 고쳐쓴다. 우리가 넣은 텍스트에 걸린 자리는 원본에 없으므로 반드시 버린다.
    proxy.getRenameInfo = (fileName, position, options) => {
      const injection = injections.get(fileName);
      const info = service.getRenameInfo(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
        options,
      );
      if (injection === undefined || info.canRename !== true) {
        return info;
      }
      return { ...info, triggerSpan: spanToOriginal(injection, info.triggerSpan) };
    };

    proxy.findRenameLocations = (
      fileName,
      position,
      findInStrings,
      findInComments,
      preferences?: boolean | ts.UserPreferences,
    ) => {
      const injection = injections.get(fileName);
      const locations = service.findRenameLocations(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
        findInStrings,
        findInComments,
        // 오버로드가 boolean/UserPreferences 두 갈래다 - 받은 것을 그대로 넘긴다.
        preferences as boolean,
      );
      if (locations === undefined || injection === undefined) {
        return locations;
      }
      return locations
        .filter((location) => location.fileName !== fileName || !isInjected(injection, location.textSpan.start))
        .map((location) => locationToOriginal(injection, fileName, location));
    };

    // 리팩터/빠른수정(전구 아이콘). 커서 자리를 보정하지 않으면 앞에 얹은 d.ts 길이만큼
    // 밀린 곳을 보고 목록을 낸다 - 엉뚱한 자리의 리팩터가 뜨고, 고르면 그 자리가 고쳐진다.
    // 표시만 어긋나는 것과 달리 소스가 실제로 깨지므로 편집 스팬도 함께 되돌린다.
    proxy.getApplicableRefactors = (
      fileName,
      positionOrRange,
      preferences,
      triggerReason,
      kind,
      includeInteractiveActions,
    ) => {
      const injection = injections.get(fileName);
      return service.getApplicableRefactors(
        fileName,
        injection === undefined ? positionOrRange : positionOrRangeToInjected(injection, positionOrRange),
        preferences,
        triggerReason,
        kind,
        includeInteractiveActions,
      );
    };

    proxy.getEditsForRefactor = (
      fileName,
      formatOptions,
      positionOrRange,
      refactorName,
      actionName,
      preferences,
      interactiveRefactorArguments,
    ) => {
      const injection = injections.get(fileName);
      const edits = service.getEditsForRefactor(
        fileName,
        formatOptions,
        injection === undefined ? positionOrRange : positionOrRangeToInjected(injection, positionOrRange),
        refactorName,
        actionName,
        preferences,
        interactiveRefactorArguments,
      );
      if (edits === undefined || injection === undefined) {
        return edits;
      }
      return {
        ...edits,
        edits: fileEditsToOriginal(injection, fileName, edits.edits),
        ...(edits.renameLocation === undefined ? {} : { renameLocation: toOriginal(injection, edits.renameLocation) }),
      };
    };

    proxy.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
      const injection = injections.get(fileName);
      const fixes = service.getCodeFixesAtPosition(
        fileName,
        injection === undefined ? start : toInjected(injection, start),
        injection === undefined ? end : toInjected(injection, end),
        errorCodes,
        formatOptions,
        preferences,
      );
      if (injection === undefined) {
        return fixes;
      }
      return fixes.map((fix) => ({ ...fix, changes: fileEditsToOriginal(injection, fileName, fix.changes) }));
    };

    // 같은 종류의 오류를 파일 전체에서 한 번에 고치는 것 - 위치를 받지 않지만 결과는 편집이다.
    proxy.getCombinedCodeFix = (scope, fixId, formatOptions, preferences) => {
      const combined = service.getCombinedCodeFix(scope, fixId, formatOptions, preferences);
      const injection = injections.get(scope.fileName);
      if (injection === undefined) {
        return combined;
      }
      return { ...combined, changes: fileEditsToOriginal(injection, scope.fileName, combined.changes) };
    };

    // import 정리. 위치를 받지 않지만 파일 전체를 고쳐쓰므로 편집 자리가 어긋나면 import가
    // 아니라 엉뚱한 코드가 잘린다 - 실제로 그랬다.
    proxy.organizeImports = (args, formatOptions, preferences) => {
      const changes = service.organizeImports(args, formatOptions, preferences);
      const injection = injections.get(args.fileName);
      return injection === undefined ? changes : fileEditsToOriginal(injection, args.fileName, changes);
    };

    // 파일 이름이 바뀌면 그것을 가리키던 import를 고친다 - 우리 파일도 대상이 될 수 있다.
    proxy.getEditsForFileRename = (oldFilePath, newFilePath, formatOptions, preferences) => {
      const changes = service.getEditsForFileRename(oldFilePath, newFilePath, formatOptions, preferences);
      // 어느 파일이 고쳐질지 모르므로 주입된 것 전부를 되돌린다.
      let mapped = changes;
      for (const [fileName, injection] of injections) {
        mapped = fileEditsToOriginal(injection, fileName, mapped);
      }
      return mapped;
    };

    // 붙여넣기가 부족한 import를 채워 준다. 넣을 자리가 밀리면 코드 한복판에 import가 박힌다.
    // 붙여넣을 위치는 TextSpan이 아니라 TextRange(pos/end)로 온다.
    proxy.getPasteEdits = (args, formatOptions) => {
      const injection = injections.get(args.targetFile);
      const pasted = service.getPasteEdits(
        injection === undefined
          ? args
          : {
              ...args,
              pasteLocations: args.pasteLocations.map((range) => ({
                pos: toInjected(injection, range.pos),
                end: toInjected(injection, range.end),
              })),
            },
        formatOptions,
      );
      return injection === undefined
        ? pasted
        : { ...pasted, edits: fileEditsToOriginal(injection, args.targetFile, pasted.edits) };
    };

    // 코드 액션 실행 - 편집을 그대로 적용하므로 위치가 어긋나면 소스가 깨진다.
    // 오버로드가 여럿이라 인자를 그대로 넘긴다.
    // biome-ignore lint/suspicious/noExplicitAny: applyCodeActionCommand는 오버로드가 6개다.
    proxy.applyCodeActionCommand = ((...args: any[]) => (service.applyCodeActionCommand as any)(...args)) as never;

    // 회색 힌트(쓰지 않는 변수 등). 진단과 같은 보정이다 - 안 하면 파일 끝 밖으로 밀려
    // 화면에 아예 안 그려진다.
    proxy.getSuggestionDiagnostics = (fileName) => {
      const diagnostics = service.getSuggestionDiagnostics(fileName);
      const injection = injections.get(fileName);
      if (injection === undefined) {
        return diagnostics;
      }
      return diagnostics
        .filter((diagnostic) => !inLead(injection, diagnostic.start))
        .map((diagnostic) => {
          const start = toOriginal(injection, diagnostic.start);
          return { ...diagnostic, start, length: toOriginal(injection, diagnostic.start + diagnostic.length) - start };
        });
    };

    // 심볼 검색(Cmd+T). 여러 파일의 결과가 섞여 오므로 주입된 것만 되돌린다.
    proxy.getNavigateToItems = (searchValue, maxResultCount, fileName, excludeDtsFiles, excludeLibFiles) => {
      const items = service.getNavigateToItems(searchValue, maxResultCount, fileName, excludeDtsFiles, excludeLibFiles);
      return items.map((item) => {
        const injection = injections.get(item.fileName);
        return injection === undefined ? item : { ...item, textSpan: spanToOriginal(injection, item.textSpan) };
      });
    };

    // 호출 계층. 항목의 파일 키가 fileName이 아니라 file이라 따로 되돌린다.
    proxy.prepareCallHierarchy = (fileName, position) => {
      const injection = injections.get(fileName);
      const prepared = service.prepareCallHierarchy(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (prepared === undefined || injection === undefined) {
        return prepared;
      }
      return Array.isArray(prepared)
        ? prepared.map((item) => callHierarchyItemToOriginal(injection, fileName, item))
        : callHierarchyItemToOriginal(injection, fileName, prepared);
    };

    proxy.provideCallHierarchyIncomingCalls = (fileName, position) => {
      const injection = injections.get(fileName);
      const calls = service.provideCallHierarchyIncomingCalls(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (injection === undefined) {
        return calls;
      }
      // fromSpans는 호출하는 쪽 파일(call.from.file)의 자리다 - 그 파일의 주입으로 되돌린다.
      return calls.map((call) => {
        const caller = injections.get(call.from.file);
        return {
          from: callHierarchyItemToOriginal(injection, fileName, call.from),
          fromSpans: caller === undefined ? call.fromSpans : call.fromSpans.map((span) => spanToOriginal(caller, span)),
        };
      });
    };

    proxy.provideCallHierarchyOutgoingCalls = (fileName, position) => {
      const injection = injections.get(fileName);
      const calls = service.provideCallHierarchyOutgoingCalls(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
      );
      if (injection === undefined) {
        return calls;
      }
      // outgoing의 fromSpans는 호출하는 쪽(= 이 파일)의 자리다.
      return calls.map((call) => ({
        to: callHierarchyItemToOriginal(injection, fileName, call.to),
        fromSpans: call.fromSpans.map((span) => spanToOriginal(injection, span)),
      }));
    };

    // "다른 파일로 옮기기"의 후보 목록 - 위치를 받아 판단하므로 입력만 보정하면 된다.
    proxy.getMoveToRefactoringFileSuggestions = (fileName, positionOrRange, preferences, triggerReason, kind) => {
      const injection = injections.get(fileName);
      return service.getMoveToRefactoringFileSuggestions(
        fileName,
        injection === undefined ? positionOrRange : positionOrRangeToInjected(injection, positionOrRange),
        preferences,
        triggerReason,
        kind,
      );
    };

    // 시그니처 도움말 - 인자를 치는 동안 뜨는 것이라 위치가 밀리면 엉뚱한 인자를 짚는다.
    proxy.getSignatureHelpItems = (fileName, position, options) => {
      const injection = injections.get(fileName);
      const help = service.getSignatureHelpItems(
        fileName,
        injection === undefined ? position : toInjected(injection, position),
        options,
      );
      if (help === undefined || injection === undefined) {
        return help;
      }
      return { ...help, applicableSpan: spanToOriginal(injection, help.applicableSpan) };
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

    // 시맨틱 하이라이팅. 스팬은 (start, length, 분류) 3개씩 평평하게 온다.
    //
    // syntactic 쪽은 프록시하지 않는다 - 에디터의 자동 들여쓰기/괄호 짝맞추기가 그 결과를
    // 먹고 파일을 고쳐써서, 위치가 어긋나면 소스가 실제로 깨진다. 색만 쓰는 semantic만 맞춘다.
    proxy.getEncodedSemanticClassifications = (fileName, span, format) => {
      const injection = injections.get(fileName);
      if (injection === undefined) {
        return service.getEncodedSemanticClassifications(fileName, span, format);
      }
      const start = toInjected(injection, span.start);
      const classifications = service.getEncodedSemanticClassifications(
        fileName,
        { start, length: toInjected(injection, span.start + span.length) - start },
        format,
      );
      // 우리가 넣은 텍스트에 걸린 스팬은 원본에 자리가 없다 - 되돌리면 엉뚱한 곳을 칠한다.
      const spans: number[] = [];
      for (let index = 0; index < classifications.spans.length; index += 3) {
        const at = classifications.spans[index];
        if (isInjected(injection, at)) {
          continue;
        }
        spans.push(toOriginal(injection, at), classifications.spans[index + 1], classifications.spans[index + 2]);
      }
      return { ...classifications, spans };
    };

    // 같은 것의 비인코딩 판. VS Code는 인코딩 쪽만 쓰지만 다른 클라이언트가 이것을 부를 수
    // 있어 함께 맞춘다 - 한쪽만 고쳐 두면 부르는 쪽에 따라 색이 밀린다.
    proxy.getSemanticClassifications = ((
      fileName: string,
      span: ts.TextSpan,
      format?: ts.SemanticClassificationFormat,
    ) => {
      const injection = injections.get(fileName);
      if (injection === undefined) {
        return service.getSemanticClassifications(fileName, span, format as ts.SemanticClassificationFormat);
      }
      const start = toInjected(injection, span.start);
      const classified = service.getSemanticClassifications(
        fileName,
        { start, length: toInjected(injection, span.start + span.length) - start },
        format as ts.SemanticClassificationFormat,
      );
      return classified
        .filter((entry) => !isInjected(injection, entry.textSpan.start))
        .map((entry) => ({ ...entry, textSpan: spanToOriginal(injection, entry.textSpan) }));
      // biome-ignore lint/suspicious/noExplicitAny: 오버로드가 둘이라 그대로 통과시킨다.
    }) as any;

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
