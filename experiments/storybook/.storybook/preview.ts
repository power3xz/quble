// 모든 story에 전역 스타일을 깐다. playground(core/playground/index.html)와 같은 두 파일이다.
/// <reference types="vite/client" />
import "../../../core/web/styles/reset.css";
import "../../../core/web/styles/global.css";
import type { Preview } from "@storybook/html-vite";

const preview: Preview = {
  // 기본값 padded는 story 둘레에 padding 1rem을 넣는다. 전역 스타일만 보이게 뺀다.
  parameters: { layout: "fullscreen" },
};

export default preview;
