// Home/End/PageUp/PageDown이 캐럿을 옮길 목표 위치 계산.
//
// 편집기가 이 키들을 브라우저에 맡기지 못하는 사정은 부르는 쪽(playground.qubc.handlers.ts)에
// 적혀 있다. 여기서는 "어디로 갈 것인가"만 정한다 - DOM을 보지 않으므로 한 페이지가 몇 줄인지는
// 인자로 받는다.

/**
 * @param key        KeyboardEvent.key
 * @param text       편집 중인 전체 텍스트
 * @param from       기준 캐럿 위치(선택 확장 중이면 움직이는 끝)
 * @param toDocEdge  Ctrl/Cmd 조합 - 줄이 아니라 문서의 처음/끝으로
 * @param pageLines  한 페이지로 볼 줄 수(보이는 창 기준)
 * @returns          목표 위치. 다루지 않는 키면 null
 */
export const caretTarget = (
  key: string,
  text: string,
  from: number,
  { toDocEdge, pageLines }: { toDocEdge: boolean; pageLines: number },
): number | null => {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;

  if (key === "Home") {
    return toDocEdge ? 0 : lineStart;
  }
  if (key === "End") {
    const br = text.indexOf("\n", from);
    return toDocEdge ? text.length : br === -1 ? text.length : br;
  }
  if (key !== "PageUp" && key !== "PageDown") {
    return null;
  }

  // 열을 유지한 채 pageLines줄 위/아래로. 목표 줄이 짧으면 그 줄 끝에 멈춘다.
  const lines = text.split("\n");
  const cur = text.slice(0, from).split("\n").length - 1;
  const column = from - lineStart;
  const dir = key === "PageUp" ? -1 : 1;
  const target = Math.min(lines.length - 1, Math.max(0, cur + dir * pageLines));
  const offset = lines.slice(0, target).reduce((sum, line) => sum + line.length + 1, 0);
  return offset + Math.min(column, lines[target].length);
};
