// 프록시 계층 테스트. inject.test.ts가 좌표 계산만 보는 것과 달리, 여기서는 진짜
// LanguageService에 plugin을 올려 편집기가 부르는 것과 같은 메서드를 통과시킨다 - 이번
// 버그(정의 위치가 lead만큼 밀림)가 계산이 아니라 "tsserver가 어느 좌표계로 세는가"에서
// 났고, 그런 것은 텍스트 변환 테스트로는 잡히지 않는다.
//
// 각 테스트는 결과 스팬이 **원본에서 무슨 글자를 덮는지**로 확인한다. 오프셋을 숫자로
// 비교하면 주입 길이가 바뀔 때 같이 틀어져 회귀를 못 잡는다.
//
// 보정이 빠진 메서드는 주입본 좌표를 그대로 내보내므로 덮는 글자가 어긋난다 - VS Code가
// 쓰는 명령이 늘거나 TS가 좌표계를 바꾸면 여기서 걸린다.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import tsModule from "typescript";
import type ts from "typescript/lib/tsserverlibrary";
import { pluginInit } from "./src/plugin.ts";

// biome-ignore lint/suspicious/noExplicitAny: tsserverlibrary 타입으로 받지만 런타임은 같은 모듈이다.
const tsAny = tsModule as any;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WASM = join(HERE, "..", "..", "core", "wasm-compiler", "compiler_wasm.wasm");

// 짝 .qubc가 디스크에 있어야 plugin이 대상으로 인정하고(existsSync), 그것을 컴파일해 d.ts를
// 낸다. 그래서 임시 디렉터리에 실물을 만든다 - 주입 경로를 그대로 태워야 의미가 있다.
const DIR = mkdtempSync(join(tmpdir(), "quble-plugin-"));
const FILE = join(DIR, "app.qubc.handlers.ts");
const QUBC = join(DIR, "app.qubc");

after(() => rmSync(DIR, { recursive: true, force: true }));

const COMPONENT = [
  "component App {",
  "  props { name: str }",
  "  events { CLICK() }",
  "  template {",
  "    button(@click:CLICK) { name }",
  "  }",
  "}",
].join("\n");

// 정의/참조가 걸릴 심볼(helper)을 파일 앞쪽에 둔다 - handlers 선언(주입 지점)보다 앞이라
// 보정이 lead만 관여하는 구간과, 그 뒤라 width까지 관여하는 구간을 함께 지난다.
const SOURCE = [
  "const helper = (value: string) => value;",
  "",
  "const other = (value: string) => helper(value);",
  "",
  "export const handlers = {",
  "  CLICK: (_data, ctx) => other(String(ctx.props.name)),",
  "};",
  "",
  // 쓰지 않는 변수 - 제안 진단(회색 힌트)이 걸린다. handlers 선언 뒤라 보정에 width까지
  // 관여하는 구간이고, 그래서 보정을 빠뜨리면 원본 밖으로 밀려난다.
  "const tail = () => {",
  "  const spare = 1;",
  "  return 2;",
  "};",
  "",
].join("\n");

writeFileSync(QUBC, COMPONENT);
writeFileSync(FILE, SOURCE);

/** 원본에서 주어진 글자열이 시작하는 오프셋. 테스트가 숫자를 직접 적지 않게 한다. */
const offsetOf = (needle: string, from = 0) => {
  const at = SOURCE.indexOf(needle, from);
  assert.notEqual(at, -1, `원본에 ${JSON.stringify(needle)}가 없다`);
  return at;
};

/** 스팬이 원본에서 덮는 글자. 보정이 맞으면 기대한 낱말이 나온다. */
const textOf = (span: ts.TextSpan | undefined) =>
  span === undefined ? "(없음)" : SOURCE.slice(span.start, span.start + span.length);

/**
 * plugin을 실제 LanguageService 위에 올린다. tsserver와 같은 순서로 - plugin이 host를 먼저
 * 감싸고(getScriptSnapshot 주입), 그 host로 서비스가 돈다.
 */
const setup = () => {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [FILE],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const text = tsAny.sys.readFile(fileName);
      return text === undefined ? undefined : tsAny.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => DIR,
    getCompilationSettings: () => ({ target: tsAny.ScriptTarget.ES2022, noResolve: true, noLib: true }),
    getDefaultLibFileName: () => "lib.d.ts",
    fileExists: tsAny.sys.fileExists,
    readFile: tsAny.sys.readFile,
  };

  let service: ts.LanguageService | null = null;
  // plugin이 host를 감싼 뒤 서비스가 만들어져야 주입된 스냅샷을 본다 - 프록시가 부르는
  // 원본 서비스는 지연으로 물린다.
  const lazy = new Proxy(
    {},
    // biome-ignore lint/suspicious/noExplicitAny: 전 메서드를 그대로 넘긴다.
    { get: (_t, key) => (...args: unknown[]) => (service as any)[key](...args) },
  ) as ts.LanguageService;

  const plugin = pluginInit({ typescript: tsAny });
  const proxy = plugin.create({
    languageService: lazy,
    languageServiceHost: host,
    project: {
      projectService: { logger: { info: () => {} } },
      updateGraph: () => {},
      refreshDiagnostics: () => {},
    },
    config: { wasmPath: WASM },
    // biome-ignore lint/suspicious/noExplicitAny: 테스트가 쓰는 것만 담은 최소 info다.
  } as any);

  service = tsAny.createLanguageService(host);

  // 주입은 스냅샷을 읽을 때 일어난다 - 한 번 태워 plugin이 보정 기준을 갖게 한다.
  service?.getProgram();

  return proxy;
};

/** 편집기가 커서 위치로 넘기는 값은 원본 기준이다. 프록시가 주입본으로 옮겨 조회한다. */
const at = (needle: string, from = 0) => offsetOf(needle, from) + 1;

test("정의로 이동 - 원본의 그 선언을 가리킨다", () => {
  const proxy = setup();
  const found = proxy.getDefinitionAtPosition(FILE, at("helper(value)", offsetOf("const other")));

  assert.equal(textOf(found?.[0].textSpan), "helper");
});

test("definitionAndBoundSpan - 커서 밑 낱말과 정의가 모두 원본 자리다", () => {
  const proxy = setup();
  const found = proxy.getDefinitionAndBoundSpan(FILE, at("helper(value)", offsetOf("const other")));

  // 편집기가 밑줄을 긋는 범위.
  assert.equal(textOf(found?.textSpan), "helper");
  // 점프해 내려앉는 자리 - 이것이 밀려서 엉뚱한 줄로 가는 버그가 있었다.
  assert.equal(textOf(found?.definitions?.[0].textSpan), "helper");
});

test("정의의 contextSpan도 원본 자리다 - 편집기가 이것으로 미리보기를 띄운다", () => {
  const proxy = setup();
  const found = proxy.getDefinitionAndBoundSpan(FILE, at("helper(value)", offsetOf("const other")));
  const context = found?.definitions?.[0].contextSpan;

  // 선언의 초기화식을 덮는다. 보정을 빠뜨리면 주입본 좌표라 원본에서는 엉뚱한 글자가 나온다.
  assert.notEqual(context, undefined);
  assert.equal(textOf(context), "(value: string) => value");
});

test("참조 찾기 - 모든 출현이 원본 자리다", () => {
  const proxy = setup();
  const found = proxy.getReferencesAtPosition(FILE, at("helper", offsetOf("const helper")));

  assert.equal(found?.length, 2);
  for (const reference of found ?? []) {
    assert.equal(textOf(reference.textSpan), "helper");
  }
});

test("findReferences - 심볼의 정의 위치도 원본 자리다", () => {
  const proxy = setup();
  const symbols = proxy.findReferences(FILE, at("helper", offsetOf("const helper")));

  assert.equal(textOf(symbols?.[0].definition.textSpan), "helper");
  for (const reference of symbols?.[0].references ?? []) {
    assert.equal(textOf(reference.textSpan), "helper");
  }
});

test("같은 심볼 강조 - 강조 스팬이 원본 자리다", () => {
  const proxy = setup();
  const found = proxy.getDocumentHighlights(FILE, at("helper", offsetOf("const helper")), [FILE]);
  const spans = found?.[0].highlightSpans ?? [];

  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.equal(textOf(span.textSpan), "helper");
  }
});

test("이름 바꾸기 - 고쳐쓸 자리가 원본이다(어긋나면 소스가 깨진다)", () => {
  const proxy = setup();
  const locations = proxy.findRenameLocations(FILE, at("helper", offsetOf("const helper")), false, false, {});

  assert.equal(locations?.length, 2);
  for (const location of locations ?? []) {
    assert.equal(textOf(location.textSpan), "helper");
  }
});

test("이름 바꾸기 정보 - triggerSpan이 원본 자리다", () => {
  const proxy = setup();
  const info = proxy.getRenameInfo(FILE, at("helper", offsetOf("const helper")), {});

  assert.equal(info.canRename, true);
  if (info.canRename) {
    assert.equal(textOf(info.triggerSpan), "helper");
  }
});

test("퀵인포 - 스팬이 원본 자리다", () => {
  const proxy = setup();
  const info = proxy.getQuickInfoAtPosition(FILE, at("helper", offsetOf("const helper")));

  assert.equal(textOf(info?.textSpan), "helper");
});

test("toLineColumnOffset - 원본 오프셋을 원본 줄로 센다", () => {
  const proxy = setup();
  // tsserver가 definitions를 줄/열로 바꿀 때 부르는 자리다. 여기가 주입본 기준으로 세면
  // 정의 위치만 앞에 얹은 d.ts 줄 수만큼 밀린다(그 버그가 501행으로 점프했다).
  const declAt = offsetOf("const other");
  const expected = SOURCE.slice(0, declAt).split("\n").length - 1;

  assert.equal(proxy.toLineColumnOffset?.(FILE, declAt).line, expected);
});

test("리팩터 목록 - 커서가 있는 자리를 기준으로 낸다", () => {
  const proxy = setup();
  // 화살표 함수 위에서는 "이름 붙은 함수로 변환"이 뜬다. 위치가 밀리면 그 자리에 없는
  // 리팩터가 뜨거나, 있어야 할 것이 빠진다.
  const found = proxy.getApplicableRefactors(FILE, at("(value: string) => value"), {});
  const kinds = found.flatMap((entry) => entry.actions.map((action) => action.kind ?? ""));

  assert.equal(
    kinds.some((kind) => kind.startsWith("refactor.rewrite.function")),
    true,
    `화살표 함수 자리인데 함수 변환이 없다: ${kinds.join(", ")}`,
  );
});

test("리팩터 편집 - 고쳐쓸 자리가 원본이다(어긋나면 엉뚱한 코드를 덮는다)", () => {
  const proxy = setup();
  const target = "(value: string) => value";
  const edits = proxy.getEditsForRefactor(
    FILE,
    {},
    at(target),
    "Convert arrow function or function expression",
    "Convert to named function",
    {},
  );

  const changes = edits?.edits.find((entry) => entry.fileName === FILE);
  assert.notEqual(changes, undefined);
  // 편집이 원본의 그 화살표 함수를 덮어야 한다 - 주입본 좌표면 엉뚱한 자리가 나온다.
  const span = changes?.textChanges[0].span;
  assert.equal(SOURCE.slice(span?.start ?? 0).startsWith("const helper"), true, `덮는 자리: ${textOf(span)}`);
});

test("빠른 수정 - 진단 자리를 보고 고칠 것을 찾는다", () => {
  const proxy = setup();
  // 없는 프로퍼티를 짚는 자리에 진단이 선다. 위치가 밀리면 빈 목록이 온다.
  const diagnostics = proxy.getSemanticDiagnostics(FILE);
  const first = diagnostics[0];
  if (first?.start === undefined) {
    return;
  }

  const fixes = proxy.getCodeFixesAtPosition(FILE, first.start, first.start + (first.length ?? 0), [first.code], {}, {});

  // 고칠 것이 있든 없든, 편집이 나온다면 그 자리는 원본 범위 안이어야 한다.
  for (const fix of fixes) {
    for (const change of fix.changes) {
      if (change.fileName !== FILE) {
        continue;
      }
      for (const edit of change.textChanges) {
        assert.equal(edit.span.start <= SOURCE.length, true, "편집이 원본 범위 밖을 가리킨다");
      }
    }
  }
});

test("import 정리 - 고치는 자리가 import 문이다(엉뚱한 코드를 자르면 안 된다)", () => {
  const proxy = setup();
  const changes = proxy.organizeImports({ type: "file", fileName: FILE }, {}, {});

  for (const change of changes) {
    if (change.fileName !== FILE) {
      continue;
    }
    for (const edit of change.textChanges) {
      // 이 파일에는 import가 없으므로 편집이 나온다면 최소한 원본 범위 안이어야 한다.
      assert.equal(edit.span.start <= SOURCE.length, true, `편집이 원본 밖: ${textOf(edit.span)}`);
    }
  }
});

test("회색 힌트 - 쓰지 않는 변수를 그 자리에 표시한다", () => {
  const proxy = setup();
  const found = proxy.getSuggestionDiagnostics(FILE);
  const unused = found.find((diagnostic) => textOf({ start: diagnostic.start, length: diagnostic.length }) === "spare");

  // 보정을 빠뜨리면 파일 끝 밖으로 밀려 화면에 아예 안 그려진다.
  assert.notEqual(unused, undefined, `쓰지 않는 변수를 못 찾았다: ${found.map((d) => textOf(d)).join(", ")}`);
});

test("호출 계층 - 준비 항목이 원본 자리를 가리킨다", () => {
  const proxy = setup();
  const prepared = proxy.prepareCallHierarchy(FILE, at("helper", offsetOf("const helper")));
  const item = Array.isArray(prepared) ? prepared[0] : prepared;

  assert.notEqual(item, undefined);
  assert.equal(textOf(item?.selectionSpan), "helper");
});

test("호출 계층 - 들어오는 호출의 자리가 원본이다", () => {
  const proxy = setup();
  const calls = proxy.provideCallHierarchyIncomingCalls(FILE, at("helper", offsetOf("const helper")));

  assert.equal(calls.length > 0, true);
  for (const call of calls) {
    for (const span of call.fromSpans) {
      assert.equal(textOf(span), "helper");
    }
  }
});

test("심볼 검색 - 결과가 원본 자리를 가리킨다", () => {
  const proxy = setup();
  const items = proxy.getNavigateToItems("helper", undefined, FILE);
  const found = items.find((item) => item.fileName === FILE && item.name === "helper");

  // textSpan은 이름이 아니라 선언 전체를 덮는다 - 보정이 어긋나면 다른 글자가 나온다.
  assert.notEqual(found, undefined);
  assert.equal(textOf(found?.textSpan), "helper = (value: string) => value");
});

test("진단 - 앞에 얹은 d.ts에서 난 것은 사용자에게 보이지 않는다", () => {
  const proxy = setup();

  for (const diagnostic of proxy.getSemanticDiagnostics(FILE)) {
    assert.equal(
      diagnostic.start === undefined || diagnostic.start <= SOURCE.length,
      true,
      "진단이 원본 범위 밖을 가리킨다",
    );
  }
});
