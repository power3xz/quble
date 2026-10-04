// 모든 story에 전역 스타일을 깐다. playground(core/playground/index.html)와 같은 두 파일이다.
/// <reference types="vite/client" />
import "../../../core/web/styles/reset.css";
import "../../../core/web/styles/global.css";
import type { Preview } from "@storybook/html-vite";

const preview: Preview = {
  parameters: {
    // 기본값 padded는 story 둘레에 padding 1rem을 넣는다. 전역 스타일만 보이게 뺀다.
    layout: "fullscreen",
    // 패널에 Code 탭을 띄운다. 내용은 story 모듈이 넣는 원본(qubc-plugin.ts)이다.
    docs: { codePanel: true },
    // 흰 배경 컴포넌트(팝업 등)의 경계가 보이도록 회색 배경과 격자를 기본으로 켠다.
    backgrounds: { options: { gray: { name: "Gray", value: "#d9d9d9" } } },
  },
  initialGlobals: { backgrounds: { value: "gray", grid: true } },
};

export default preview;
