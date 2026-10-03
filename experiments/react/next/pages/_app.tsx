import "../../../../core/web/styles/reset.css";
import "../../../../core/web/styles/global.css";
import "../stack.css";
// 산출 셸이 import하는 CSS의 사본(next.sh가 복사). 셸의 import는 next.config.mjs가 빈 모듈로 바꾼다.
import "../../dist/next-shell-css/playground.css";
import "../../dist/next-shell-css/completion.css";
import "../../dist/next-shell-css/filerow.css";
import "../../dist/next-shell-css/logrow.css";
import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
