<script>
  // playground.qubc의 셸을 그대로 옮긴 것. playground.css를 재사용하므로 마크업의 클래스와
  // 구조(.pg > aside/main/console)가 원본과 같아야 한다.
  //
  // 원본과 다른 점: 자동완성이 없다. 컴파일/미리보기/진단은 원본과 같은 절차다(preview.js).
  import { parseDiagnostic } from "../../core/playground/diagnostic.ts";
  import { lineCountOf, lineNumbersFor, markError, tokenize } from "../../core/playground/tokenize.ts";
  import FileRow from "./FileRow.svelte";
  import LogRow from "./LogRow.svelte";
  import { runPreview } from "./preview.js";
  import { loadFiles } from "./sources.js";

  let files = $state([]);
  let editingName = $state("");
  let logs = $state([]);
  let caretTop = $state(0);
  let caretHidden = $state(false);
  let area;
  let previewEl;

  // 마지막 컴파일 에러. 편집기가 그 파일을 싣고 있을 때만 줄 표시가 뜨고, 파일 목록의 표시는
  // 이름을 맞춰 켠다(에러가 난 파일이 편집 중이 아니어도 보인다).
  let diagnostic = $state("");
  let failure = $state(null);
  // 지금 미리보기 중인 파일 - 목록의 표시를 되살리려면 이름으로 들고 있어야 한다.
  let previewingName = $state(null);

  // 편집 중인 파일. 목록이 아직 안 왔으면 없다.
  const editing = $derived(files.find((f) => f.name === editingName));
  const source = $derived(editing?.source ?? "");

  // 화면에 그릴 줄들. 소스가 바뀌면 다시 쪼갠다 - 원본 핸들러의 showText가 하던 일이다.
  // 에러가 이 파일에 있으면 그 줄에 메시지를 얹는다.
  const lines = $derived.by(() => {
    const split = tokenize(source, editingName);
    return failure?.path === editingName
      ? markError(split, failure.line, failure.message)
      : split;
  });
  const lineNumbers = $derived(lineNumbersFor(source));
  const lineCount = $derived(lineCountOf(source));

  loadFiles().then((loaded) => {
    files = loaded;
    editingName = loaded.find((f) => f.isEntry)?.name ?? loaded[0].name;
    logs = [{ level: "info", text: "demo 소스를 불러왔습니다" }];
    // 첫 화면에서도 막대가 1번 줄에 놓이도록 - DOM이 붙은 다음 프레임에 잰다.
    requestAnimationFrame(trackCaret);
  });

  // 파일 전환 - 소스는 files에 살아 있으므로 이름만 바꾸면 편집하던 내용이 그대로 돌아온다.
  const selectFile = (name) => {
    editingName = name;
    // textarea는 uncontrolled라 값이 자동으로 안 따라온다 - 원본 showText와 같은 이유다.
    // 캐럿은 맨 앞으로 보내고 강조 막대도 그 자리에 맞춘다(전 파일 자리에 남으면 안 된다).
    requestAnimationFrame(() => {
      if (area) {
        area.value = source;
        area.selectionStart = area.selectionEnd = 0;
        area.closest(".pg__code").scrollTop = 0;
        trackCaret();
      }
    });
  };

  // 입력 - textarea의 값이 원본이다. 화면은 여기서 파생된다.
  const editSource = () => {
    if (editing) {
      editing.source = area.value;
    }
    trackCaret();
  };

  // 커서가 있는 줄로 강조 막대를 옮기고, 커서가 화면 밖이면 보이도록 최소한만 스크롤한다.
  // 줄 높이와 padding은 실측한다 - CSS(line-height: inherit, padding: 1rem)를 여기 옮겨 적으면
  // 한쪽만 바뀔 때 어긋난다.
  const trackCaret = () => {
    const code = area?.closest(".pg__code");
    if (!code) {
      return;
    }

    // 캐럿이 줄 끝에 있을 때 다음 줄로 새지 않도록 마지막 개행 앞까지로 센다.
    const before = area.value.slice(0, area.selectionStart);
    const lastBreak = before.lastIndexOf("\n");
    const line = lastBreak === -1 ? 0 : before.slice(0, lastBreak).split("\n").length;

    const style = getComputedStyle(area);
    const lineH = Number.parseFloat(style.lineHeight);
    const top = Number.parseFloat(style.paddingTop) + line * lineH;

    // 선택 중에는 숨긴다 - 선택 영역과 겹쳐 어느 쪽이 무엇인지 읽기 어렵다.
    caretHidden = area.selectionStart !== area.selectionEnd;
    caretTop = top;

    if (top < code.scrollTop) {
      code.scrollTop = top;
    } else if (top + lineH > code.scrollTop + code.clientHeight) {
      code.scrollTop = top + lineH - code.clientHeight;
    }
  };

  // 커서만 움직인 경우(화살표/클릭) - 브라우저가 커서를 옮긴 다음 프레임에 읽는다.
  const followCaret = () => requestAnimationFrame(trackCaret);

  const clearLogs = () => {
    logs = [];
  };

  // 미리보기 - 엔트리를 컴파일해 오른쪽에 두 번째 quble 인스턴스를 올린다.
  // 편집기에도 그 파일을 싣는다 - 미리보기와 편집 대상이 다르면 어느 소스가 그려진 것인지
  // 알 수 없다(원본 runPreview와 같은 이유).
  const run = async (name) => {
    selectFile(name);
    failure = null;
    diagnostic = "";

    const result = await runPreview(files, name, previewEl);
    if (result.ok) {
      previewingName = name;
      return;
    }
    diagnostic = result.diagnostic;
    failure = parseDiagnostic(result.diagnostic);
    previewingName = null;
  };

  // 진단을 눌러 에러가 난 파일의 그 줄로 간다. 다른 파일에서 난 에러(use로 딸려온 파일)는
  // 편집기에 표시할 자리가 없어 이게 유일한 이동 수단이다.
  const jumpToError = () => {
    if (!failure) {
      return;
    }
    if (failure.path !== editingName) {
      selectFile(failure.path);
    }
    // 그 줄 첫 칸으로 캐럿을 옮긴다 - selectFile이 다음 프레임에 값을 넣으므로 그 뒤에.
    requestAnimationFrame(() => {
      const upto = area.value.split("\n").slice(0, failure.line - 1).join("\n");
      area.selectionStart = area.selectionEnd = upto.length + (failure.line > 1 ? 1 : 0);
      area.focus();
      trackCaret();
    });
  };

  // 미리보기 앱이 부른 console.*를 셸의 로그로 옮긴다. 미리보기는 같은 문서에서 돌아
  // 가로채지 않으면 브라우저 콘솔로 흘러간다.
  const LEVELS = ["log", "info", "warn", "error"];
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      logs = [...logs, { level, text: args.map(textOf).join(" ") }];
      scrollLogsToEnd();
    };
  }

  // 객체는 JSON으로 편다 - 순환 참조가 있으면 못 펴므로 그때는 String으로 떨어뜨린다.
  const textOf = (value) => {
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };

  // 새 로그가 붙으면 콘솔을 맨 아래로. DOM이 붙은 뒤여야 스크롤 높이가 잡히므로 다음 프레임에.
  const scrollLogsToEnd = () => {
    requestAnimationFrame(() => {
      const body = document.querySelector(".pg__console-body");
      if (body) {
        body.scrollTop = body.scrollHeight;
      }
    });
  };
</script>

<div class="pg">
  <aside class="pg__files">
    {#each files as f (f.name)}
      <FileRow
        name={f.name}
        isEntry={f.isEntry}
        isEditing={f.name === editingName}
        isPreviewing={f.name === previewingName}
        hasError={failure?.path === f.name}
        onselect={() => selectFile(f.name)}
        onrun={() => run(f.name)}
      />
    {/each}
  </aside>

  <main class="pg__main">
    <header class="pg__editing">{editingName}</header>

    <div class="pg__code">
      <pre class="pg__gutter">{lineNumbers}</pre>
      <div class="pg__sheet">
        <div
          class="pg__caretline"
          style={caretHidden ? "display: none" : `transform: translateY(${caretTop}px)`}
        ></div>
        <pre class="pg__view">{#each lines as line}<div
              class="pg__line"
              data-error={line.hasError}
            >{#each line.tokens as t}<span class={t.cls}>{t.text}</span>{/each}</div>{/each}</pre>
        <textarea
          class="pg__area"
          spellcheck="false"
          rows={lineCount}
          bind:this={area}
          value={source}
          oninput={editSource}
          onkeydown={followCaret}
          onclick={followCaret}
        ></textarea>
      </div>
    </div>

    {#if diagnostic}
      <button class="pg__diag" onclick={jumpToError}>{diagnostic}</button>
    {/if}
  </main>

  <!-- 오른쪽 위 칸. .pg__preview-head와 .pg__guide가 각자 grid-area: preview를 갖고 있어
       감싸지 않고 셸의 직계 자식으로 둔다(감싸면 그 규칙이 안 걸린다).
       마운트 대상도 같은 칸에 얹되 헤더 아래로 내린다. -->
  {#if previewingName}
    <header class="pg__preview-head">preview: {previewingName}</header>
  {:else}
    <div class="pg__guide">
      <p class="pg__guide-title">미리보기가 여기 나옵니다</p>
      <p class="pg__guide-hint">
        왼쪽 파일 목록에서 .qubc 옆 <span class="pg__guide-run">run</span> 을 누르세요
      </p>
    </div>
  {/if}
  <div class="pg__preview-body" class:pg__preview-body--live={previewingName} bind:this={previewEl}></div>

  <section class="pg__console">
    <header class="pg__console-head">
      <h2 class="pg__console-title">console</h2>
      <button class="pg__console-clear" onclick={clearLogs}>clear</button>
    </header>
    <div class="pg__console-body">
      {#each logs as l}
        <LogRow text={l.text} level={l.level} />
      {/each}
    </div>
  </section>
</div>
