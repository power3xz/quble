// heavyif.qubc 생성 — 무거운 가지(가지당 1000행)로 @if swap 비용을 React/Svelte와 비교한다.
// then 가지는 sharedA, else 가지는 sharedB를 보간(가지별로 다른 값·색). swap하면 색+숫자가 바뀐다.
// 각 행: div(class=..) { span#  span{shared..}  span tag }.

import { writeFileSync } from "node:fs";

const ROWS = 1000;

const rows = (rowClass, valueName, tagText) => {
  const out = [];
  for (let i = 0; i < ROWS; i++) {
    out.push(
      `      div(class="${rowClass}") {\n` +
        `        span(class="idx") { "#" }\n` +
        `        span(class="label") { {${valueName}} }\n` +
        `        span(class="tag") { "${tagText}" }\n` +
        `      }`,
    );
  }
  return out.join("\n");
};

const source =
  `component HeavyIf {\n` +
  `  props { show, sharedA, sharedB }\n` +
  `  template {\n` +
  `    div(class="heavy") {\n` +
  `      @if (show) {\n` +
  rows("row a", "sharedA", "A") +
  `\n      }\n` +
  `      @else {\n` +
  rows("row b", "sharedB", "B") +
  `\n      }\n` +
  `    }\n` +
  `  }\n` +
  `}\n`;

writeFileSync(new URL("./components/heavyif.qubc", import.meta.url), source);
console.log(`heavyif.qubc 생성: 가지당 ${ROWS}행 (then=sharedA, else=sharedB)`);
