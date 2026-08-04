# ts-plugin 구현

`*.qubc.handlers.ts`에 짝 `.qubc`의 핸들러 타입을 붙이는 TS Language Service plugin. 사용자
관점(무엇이 되는지, 어떻게 설치하는지)은 `../vscode/README.md`에 있다. 이 문서는 **왜 이렇게
만들었는지**와 **고칠 때 무엇을 조심해야 하는지**를 남긴다.

## 왜 텍스트 주입인가

tsserver도 AST를 들고 있지만 plugin이 그것을 갈아끼울 자리가 없다. plugin에 주어지는 확장
지점은 둘뿐이다.

- `languageServiceHost` - 파일 내용을 공급한다(텍스트 단위)
- `languageService` - 질의 결과를 가로챈다(결과 단위)

`SourceFile`은 그 사이에서 TS가 스냅샷 텍스트로부터 만들어 내부에 보관한다. `getProgram()`으로
읽을 수는 있어도 바꿔치기할 API가 없고, `program`은 갱신마다 새로 만들어지며 그 경로에 훅이
없다. AST 노드를 억지로 변형해도 소용없다 - `pos`/`end`가 텍스트 오프셋을 참조하므로 텍스트를
그대로 두면 둘이 어긋나 더 나빠진다.

그래서 `getScriptSnapshot`에서 **텍스트를 바꿔치기**한다. 이것이 plugin이 쓸 수 있는 유일한
수단이고, 대가가 좌표 어긋남이다. 아래 절반이 그 대가를 치르는 이야기다.

대안으로 Volar(가상 파일 + 소스맵)가 있다. 개념은 같고 매핑을 프레임워크가 관리해 준다. 지금
규모(주입이 한 줄, 매핑이 값 셋)에서는 직접 하는 편이 가볍다고 보고 쓰지 않았다.

## 주입 방식

`inject.ts`가 주입본 텍스트와 되돌리기에 필요한 값을 만든다(`TInjection`).

```
[ d.ts 한 줄 ][ 원본 앞부분 ][ : Partial<__qubleHandlers> ][ 원본 뒷부분 ]
 <-- lead --->               <-- at -->  <-- width -->
```

- `lead` - 원본 앞에 놓인 d.ts의 길이. 원본 전체가 이만큼 밀린다
- `at` - `handlers` 선언의 이름 끝(원본 기준). 여기에 타입 표기를 심는다
- `width` - 심은 표기의 길이. `at` **뒤쪽만** 추가로 밀린다

정한 이유가 각각 있다.

**d.ts를 앞에 두는 이유** - 뒤에 두면 리터럴이 안 닫힌 상태(타이핑 중)에서 미완성 문자열
안으로 빨려 들어간다. 정작 후보가 필요한 순간에 망가진다.

**d.ts를 한 줄로 접는 이유** - 개행이 들어가면 원본의 모든 줄 번호가 그만큼 밀린다. 한 줄이면
`at` 이전 구간의 줄 번호가 원본과 같아서, 줄 기준으로 도는 것들이 저절로 맞는다. 줄 주석은
접으면 뒤를 통째로 삼키므로 `localize`가 먼저 지운다.

**선언 자리에 표기를 심는 이유** - 뒤에 `satisfies`로 붙이면 리터럴이 닫힌 뒤에만 걸려, 키를
치는 동안에는 완성이 안 뜬다. 이 plugin의 목적이 그 완성이다.

**`__quble` 접두** - d.ts 본문을 이 파일 안의 지역 선언으로 만들면서 사용자 이름과 부딪히지
않게 한다. `export`도 뗀다 - 남으면 handlers.ts의 모듈 형태를 건드린다.

**`Partial`로 붙이는 이유** - 이벤트를 다 구현할 의무는 없다. 잡아야 할 것은 없는 이벤트명이지
안 쓴 이벤트가 아니다.

**`handlers` 선언을 파서로 찾는 이유** - 정규식은 주석이나 문자열 안의 같은 글자에 속는다.
`export` 여부는 보지 않는다(나중에 묶어 내보내는 경우도 대상이다). 이미 타입 표기가 있으면
건드리지 않는다 - 사람이 적은 것을 덮으면 안 된다.

## 좌표 보정: 여기가 핵심이다

주입본과 원본은 좌표계가 다르다. plugin은 **들어가는 위치는 주입본으로 옮기고, 나오는 위치는
원본으로 되돌린다**. `plugin.ts`의 프록시 절반이 이 일을 한다.

### tsserver는 응답을 두 좌표계로 만든다

실제로 겪은 버그의 원인이라 따로 적는다. `getDefinitionAndBoundSpan` 응답을 만드는 코드가
이렇다(TS 내부, `typescript.js`).

```js
textSpan:    toProtocolTextSpan(textSpan, scriptInfo)     // 열린 파일 버퍼 = 원본 기준
definitions: this.mapDefinitionInfo(definitions, project)  // -> ls.toLineColumnOffset = 주입본 기준
```

같은 응답 안에서 갈린다. 우리가 둘 다 원본으로 되돌려 보내면 `textSpan`은 맞고 `definitions`만
`lead`만큼 다시 밀린다. 실제로 680행 정의가 501행으로 나갔다(`21936 - 5423 = 16513`).

그래서 **`toLineColumnOffset`도 프록시한다**. 원본 오프셋을 받아 `toInjected`로 옮겨 세게 하면
`lead`가 한 줄이라 원본 줄 번호와 맞는다. 이 한 조각이 빠져서 정의 이동이 깨져 있었다.

### 스팬은 길이를 다시 잰다

`spanToOriginal`은 양 끝을 각각 되돌려 길이를 다시 계산한다. 스팬이 삽입 지점을 걸치면 그 안에
표기 길이가 끼어 있어, `start`만 옮기고 길이를 두면 뒤가 넘친다.

### 우리가 넣은 텍스트에 걸린 결과는 버린다

앞의 d.ts나 타입 표기 안으로 떨어지는 위치는 원본에 자리가 없다. 되돌리면 엉뚱한 곳을
가리키므로 `isInjected`/`inLead`로 걸러 낸다. 편집을 만드는 것(`fileEditsToOriginal`)에서는
특히 중요하다 - 남겨 두면 엉뚱한 코드를 덮어쓴다.

### 결과 모양마다 손댈 곳이 다르다

| 모양 | 헬퍼 | 비고 |
| --- | --- | --- |
| `TextSpan` | `spanToOriginal` | 길이 재계산 포함 |
| `textSpan` + `contextSpan` | `locationToOriginal` | `contextSpan`을 빠뜨리면 점프가 엉뚱한 자리에 내려앉는다 |
| `FileTextChanges[]` | `fileEditsToOriginal` | 소스를 실제로 고쳐쓰는 것들 |
| `CallHierarchyItem` | `callHierarchyItemToOriginal` | 파일 키가 `fileName`이 아니라 **`file`**이다 |
| 위치 또는 범위 입력 | `positionOrRangeToInjected` | 리팩터류가 둘 다 받는다 |

인코딩 분류(`getEncodedSemanticClassifications`)만 예외다. `(start, length, 분류)` 3개씩 평평한
숫자 배열이라 인덱스 산술로 다룬다. 비인코딩 판(`getSemanticClassifications`)도 함께 맞춘다 -
한쪽만 고치면 부르는 쪽에 따라 색이 밀린다.

## 두 개의 tsserver

VS Code는 tsserver를 둘 띄우고 명령을 나눠 보낸다. 이것이 "무엇을 보정할지"를 정한다.

- **semantic 서버** - 전체 기능
- **syntax 서버** (`--serverMode partialSemantic`) - 문법만. 프로젝트 로딩 중에도 빠르게
  응답하려고 둔다

plugin의 `create`는 **양쪽 모두에서 돈다**(로그에 `[quble] 활성화`가 각각 찍힌다). 하지만
**syntax 서버는 주입하지 않는다** - wasm 경로를 못 받기 때문이다.

### wasm 경로가 semantic에만 가는 이유

VS Code TS 확장의 라우터에 박혀 있다(`typescript-language-features/dist/extension.js`).

```js
static syntaxAlwaysCommands = new Set(["navtree", "getOutliningSpans", "jsxClosingTag",
                                       "selectionRange", "format", "formatonkey",
                                       "docCommentTemplate", "linkedEditingRange"]);
static semanticCommands = new Set(["geterr", "geterrForProject", "projectInfo", "configurePlugin"]);
static syntaxAllowedCommands = new Set(["completions", "completionEntryDetails", "completionInfo",
                                        "definition", "definitionAndBoundSpan", "documentHighlights",
                                        "implementation", "navto", "quickinfo", "references",
                                        "rename", "signatureHelp"]);

// 라우팅
syntaxAlwaysCommands.has(cmd) ? true                                        // 항상 syntax
  : semanticCommands.has(cmd) ? false                                       // 항상 semantic
  : !!(n && this.projectLoading && syntaxAllowedCommands.has(cmd));         // 로딩 중에만 syntax
```

`configurePlugin`이 `semanticCommands`에 있다. 확장이 `api.configurePlugin(...)`으로 wasm
경로를 넘겨도 **VS Code가 semantic 서버로만 보낸다**. 우리 코드로 바꿀 수 있는 것이 아니다.

그래서 syntax 서버의 plugin 인스턴스는 `wasmPath === ""` 상태로 남고, `getScriptSnapshot`이
주입 없이 원본을 그대로 돌려준다.

### 그래서 보정이 저절로 꺼진다

주입이 없으면 `injections` 맵이 비고, 모든 프록시가 이 분기를 탄다.

```ts
const injection = injections.get(fileName);
if (injection === undefined) {
  return /* 보정 없이 원본 결과 그대로 */;
}
```

즉 보정 코드를 추가해도 syntax 서버에서는 **건너뛰어진다 - 해가 없다**. 다만 그 명령이 semantic
서버로 오지 않으므로 **의미도 없다**. `syntaxAlwaysCommands` 8개(아웃라인, 코드 접기, 포맷,
주석 토글 등)를 보정하지 않는 이유는 위험해서가 아니라 불필요해서다.

### 로딩 중에는 기능이 잠깐 약해진다

`syntaxAllowedCommands` 12개는 `projectLoading` 동안 syntax 서버로 간다. 우리가 보정한 것들이
여럿 들어 있다(정의 이동, 참조, 이름 바꾸기, 완성...). 그때는 주입이 없으므로

- 타입이 안 붙는다(fullname 완성이 안 뜬다)
- 주입이 없으니 좌표는 원래부터 맞다 - **깨지지 않는다**

로딩이 끝나면 semantic으로 넘어가 정상화된다.

### 무엇이 semantic 전용인가

TS 소스의 `invalidPartialSemanticModeCommands` + `invalidSyntacticModeCommands`의 합집합이
semantic 전용이다(`typescript.js`). 새 메서드를 보정할지 판단할 때 여기를 본다.

현재 **semantic 전용 명령은 전부 보정돼 있다**(32개 프록시).

`getCompilerOptionsDiagnostics`는 tsconfig 진단이라 우리 파일 위치와 무관해 대상이 아니다.

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | tsserver 진입점. `export =`(CJS) 한 줄 shim |
| `src/plugin.ts` | 본체. host/LanguageService 프록시 |
| `src/inject.ts` | 주입본 생성과 좌표 변환. tsserver 없이 테스트된다 |
| `src/compiler.ts` | 짝 `.qubc`를 wasm으로 컴파일해 d.ts를 얻는다 |

**본체가 `plugin.ts`에 있는 이유** - 진입점은 `export =`라야 하는데(tsserver가 `require`로 싣고
`module.exports`가 함수 자체이길 기대한다) 그 형식은 named export와 함께 쓸 수 없다. 테스트가
본체를 이름으로 가져와야 해서 갈랐다.

## 캐시와 갱신

컴파일이 이 plugin에서 제일 비싸다. 두 단으로 아낀다.

- `dtsCache` - 짝 `.qubc`가 그대로면 재컴파일하지 않는다(`.qubc`의 버전으로 판단한다 -
  handlers.ts 버전으로는 알 수 없다)
- `injectionCache` - 원본과 `.qubc` 버전이 그대로면 다시 파싱하지 않는다. `getScriptSnapshot`이
  아주 자주 불려 `createSourceFile`이 매번 도는 것을 막는다

**`generation`** - wasm 경로는 확장이 `configurePlugin`으로 나중에 넘긴다(확장 activate가 파일
열기보다 늦을 수 있다). 그전에 만든 스냅샷은 주입이 안 된 것이라 버려야 하는데, TS는 두 단으로
거른다: 프로젝트 버전이 그대로면 파일 버전을 묻지 않고, 파일 버전이 그대로면 스냅샷을 다시 읽지
않는다. 세대를 올려 두 단을 모두 통과시킨다.

경로가 없는 동안에도 **프록시는 항상 건다**. 없다고 그만두면 나중에 경로가 와도 프록시가 없어
영영 안 붙는다.

컴파일이 실패하면 빈 `Handlers`를 얹는다(`emptyDts`). 타입을 아예 안 얹으면 `any`가 되어
반대로 다 통과한다.

## 테스트

| 파일 | 무엇을 보나 |
| --- | --- |
| `inject.test.ts` | 좌표 계산. tsserver 없이 텍스트 변환만 |
| `proxy.test.ts` | 실제 `LanguageService`에 plugin을 올려 편집기가 부르는 메서드를 통과시킨다 |

`proxy.test.ts`가 이 plugin의 안전망이다. 이번 버그가 계산이 아니라 "tsserver가 어느 좌표계로
세는가"에서 났고, 그런 것은 텍스트 변환 테스트로 잡히지 않는다.

**결과를 오프셋 숫자가 아니라 원본에서 덮는 글자로 확인한다.** 숫자로 비교하면 주입 길이가
바뀔 때 기대값도 같이 틀어져 회귀를 못 잡는다.

임시 디렉토리에 실제 `.qubc`와 handlers 파일을 만들어 **주입 경로를 그대로 태운다**(wasm 컴파일
포함). 가짜 주입이면 실제 동작과 갈라진다.

새 메서드를 보정할 때는 **프록시를 지웠을 때 그 테스트가 실패하는지** 확인한다. 통과만 보면
보정이 실제로 걸렸는지 알 수 없다.

## 고칠 때 주의

- **편집을 만드는 것**(코드액션, 리팩터, import 정리, 붙여넣기)은 위치가 어긋나면 색이 아니라
  소스가 깨진다. 실제로 `organizeImports`가 import 대신 함수 본문을 자르고 있었다
- **`Object.keys(service)` 루프가 먼저 돌고 개별 덮어쓰기가 뒤에 온다.** 순서를 뒤집으면 보정이
  통째로 사라진다
- 보정을 더할 때는 그 명령이 semantic 서버로 오는지 먼저 본다. `syntaxAlwaysCommands`에 있는
  것은 보정해도 닿지 않는다(해는 없지만 죽은 코드가 된다)
- 새 TS 버전에서 응답 조립 방식이나 VS Code의 라우팅 규칙이 바뀔 수 있다. `proxy.test.ts`가 그
  감지 장치다
