import { Head, Html, Main, NextScript } from "next/document";

// vite 판 index.html과 같은 배치다 - 셸(Main)과 #preview를 같은 칸에 겹친다. #preview에는 run을 누르면 셸
// 핸들러가 사용자 소스를 qubb로 마운트한다.
export default function Document() {
  return (
    <Html lang="ko">
      <Head />
      <body>
        <div className="stack">
          <Main />
          <div className="stack__preview">
            <div className="preview-cell">
              <div id="preview" />
            </div>
          </div>
        </div>
        <NextScript />
      </body>
    </Html>
  );
}
