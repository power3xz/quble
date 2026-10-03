// NativeDemo의 초기 데이터. 브라우저 셸(main.ts)과 Android 앱(../native-app/App.tsx)이 같이 쓴다.
export const initial = {
  todos: [
    { text: "문서 작성", done: false },
    { text: "리뷰 반영", done: true },
    { text: "배포", done: false },
  ],
  tone: "good",
};
