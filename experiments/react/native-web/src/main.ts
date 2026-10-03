// native_demo.qubc를 `quble-react --native`로 컴파일한 React Native 컴포넌트를 react-native-web으로 그린다.
// 산출 native_demo.tsx는 native-web.sh가 만든다.
import { QubleRoot } from "quble-react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { NativeDemo } from "../../dist/native/native_demo.tsx";
import { handlers } from "./handlers.ts";

const root = document.getElementById("root");
if (!root) {
  throw new Error("#root가 없다");
}

createRoot(root).render(
  createElement(QubleRoot<Parameters<typeof NativeDemo>[0]>, {
    component: NativeDemo,
    initial: {
      todos: [
        { text: "문서 작성", done: false },
        { text: "리뷰 반영", done: true },
        { text: "배포", done: false },
      ],
      tone: "good",
    },
    handlers,
  }),
);
