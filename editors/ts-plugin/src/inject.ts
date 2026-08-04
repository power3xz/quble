// handlers.ts 스냅샷에 타입 표기를 심는다. tsserver만 이 결과를 보고, 디스크와 편집기 화면은
// 원본 그대로다.
//
// 선언 자리에 넣는 이유: 리터럴이 닫히기 전에도 타입이 붙어 있어야 타이핑 중에 키 완성이 뜬다.
// 뒤에 `satisfies`로 붙이면 리터럴이 닫힌 뒤에만 걸려 정작 치는 동안에는 아무것도 안 뜬다.
//
// 개행을 넣지 않으므로 줄 번호는 밀리지 않는다 - 삽입한 그 줄의 컬럼만 밀린다(toOriginal이 되돌린다).

import type ts from "typescript/lib/tsserverlibrary";

/**
 * 주입 결과. 위치를 원본 기준으로 되돌리는 데 두 값이 필요하다.
 * - `lead`: 원본 앞에 놓인 d.ts 한 줄의 길이(원본 전체가 이만큼 밀린다)
 * - `at`/`width`: 선언 줄에 심은 타입 표기의 자리와 길이(그 뒤만 추가로 밀린다)
 */
export type TInjection = { text: string; lead: number; at: number; width: number };

/**
 * `handlers` 선언의 이름 끝 오프셋. 없으면 -1.
 *
 * export 여부는 보지 않는다 - 나중에 묶어 내보내는 경우(`export { handlers }`)에도 붙어야 하고,
 * 타입이 필요한 이유는 그 이름이 핸들러 표라는 것이지 모듈 밖으로 나가는지가 아니다.
 *
 * 정규식이 아니라 파서로 찾는다 - 주석이나 문자열 안의 같은 글자에 속지 않는다.
 * 이미 타입 표기가 있으면 건드리지 않는다(-1) - 사람이 적은 것을 덮으면 안 된다.
 */
const handlersNameEnd = (tsModule: typeof ts, source: string) => {
  const file = tsModule.createSourceFile("h.ts", source, tsModule.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!tsModule.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (tsModule.isIdentifier(declaration.name) && declaration.name.text === "handlers") {
        return declaration.type === undefined ? declaration.name.end : -1;
      }
    }
  }
  return -1;
};

// d.ts 본문을 이 파일 안의 지역 선언으로 만든다. export를 떼야 handlers.ts의 모듈 형태를
// 건드리지 않고, 사용자가 같은 이름을 써도 부딪히지 않게 접두를 붙인다.
const PREFIX = "__quble";

// 개행을 지워 한 줄로 만든다 - 원본 앞에 놓이므로 줄이 늘면 원본의 모든 줄 번호가 밀린다.
// 줄 주석은 한 줄로 접으면 뒤를 통째로 삼키므로 먼저 지운다.
const localize = (dts: string) =>
  dts
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^export\s+/gm, "")
    .replace(/\b(LeafIndex|Handler|Handlers)\b/g, `${PREFIX}$1`)
    .replace(/\s*\n\s*/g, " ")
    .trim();

/**
 * 스냅샷에 넣을 타입 표기와 d.ts 본문을 만든다. 대상이 아니면 null.
 *
 * d.ts는 원본 **앞에** 한 줄로 놓인다. 뒤에 두면 리터럴이 안 닫힌 상태(타이핑 중)에서 그
 * 안으로 삼켜진다.
 *
 * @param source  handlers.ts 원본
 * @param dts     짝 .qubc가 낸 d.ts 텍스트
 */
export const injectionFor = (tsModule: typeof ts, source: string, dts: string): TInjection | null => {
  const at = handlersNameEnd(tsModule, source);
  if (at < 0) {
    return null;
  }
  // Partial로 붙인다 - 이벤트를 다 구현할 의무는 없다. 잡아야 할 것은 없는 이벤트명이지
  // 안 쓴 이벤트가 아니다.
  const annotation = `: Partial<${PREFIX}Handlers>`;
  const body = `${source.slice(0, at)}${annotation}${source.slice(at)}`;
  // 끝에 공백 하나를 둬 d.ts의 마지막 토큰과 원본 첫 토큰이 붙지 않게 한다.
  const lead = `${localize(dts)} `;
  return {
    text: `${lead}${body}`,
    lead: lead.length,
    at,
    width: annotation.length,
  };
};

/** 주입본 기준 오프셋을 원본 기준으로 되돌린다. */
export const toOriginal = (injection: TInjection, position: number) => {
  const withoutLead = Math.max(0, position - injection.lead);
  return withoutLead <= injection.at ? withoutLead : Math.max(injection.at, withoutLead - injection.width);
};

/** 원본 기준 오프셋을 주입본 기준으로 옮긴다. */
export const toInjected = (injection: TInjection, position: number) =>
  injection.lead + (position <= injection.at ? position : position + injection.width);

/**
 * 주입본 기준 오프셋이 우리가 넣은 텍스트(앞의 d.ts 또는 타입 표기) 안인지. 원본에 없는
 * 자리라 되돌릴 곳이 없다 - 하이라이팅 스팬이 여기 걸리면 버려야 한다.
 */
export const isInjected = (injection: TInjection, position: number) => {
  if (position < injection.lead) {
    return true;
  }
  const withoutLead = position - injection.lead;
  return withoutLead > injection.at && withoutLead < injection.at + injection.width;
};

/**
 * 스팬 하나를 원본 기준으로 되돌린다. 길이는 양 끝을 각각 되돌려 다시 잰다 - 스팬이 삽입
 * 지점을 걸치면 그 안에 표기 길이가 끼어 있어, start만 옮기고 길이를 그대로 두면 뒤가 넘친다.
 */
export const spanToOriginal = (injection: TInjection, span: ts.TextSpan): ts.TextSpan => {
  const start = toOriginal(injection, span.start);
  return { start, length: toOriginal(injection, span.start + span.length) - start };
};

/**
 * `textSpan`/`contextSpan`을 가진 결과 하나를 원본 기준으로 되돌린다. 주입한 파일에서 온
 * 것만 손대고 다른 파일의 위치는 그대로 둔다 - 그쪽은 주입본이 아니다.
 *
 * `contextSpan`을 빠뜨리면 편집기가 그것으로 점프해 엉뚱한 자리에 내려앉는다.
 */
export const locationToOriginal = <T extends { fileName?: string; textSpan: ts.TextSpan; contextSpan?: ts.TextSpan }>(
  injection: TInjection,
  fileName: string,
  location: T,
): T => {
  if (location.fileName !== undefined && location.fileName !== fileName) {
    return location;
  }
  return {
    ...location,
    textSpan: spanToOriginal(injection, location.textSpan),
    ...(location.contextSpan === undefined ? {} : { contextSpan: spanToOriginal(injection, location.contextSpan) }),
  };
};
