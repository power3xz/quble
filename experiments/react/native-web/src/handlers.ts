// NativeDemo(fixtures/native_demo.qubc)의 핸들러. @for 안 버튼은 요소에서 바로 발화하므로 익명 마디
// `[$0]`가 붙고, $0이 그 회차 번호다.
import type { THandlers } from "quble-react";

let seq = 4; // 초기 3개 뒤 순번

// 입력은 uncontrolled라 store에 안 되먹이고 여기 둔다 - 추가 버튼이 읽는다.
let draft = "";

export const handlers: THandlers = {
  // 입력한 글자는 DOM이 아니라 RN의 onChangeText가 주므로 textEvent가 event.target.value로 감싼다.
  EDIT: (_data, ctx) => {
    draft = (ctx.event as unknown as { target: { value: string } }).target.value;
  },
  ADD: (_data, ctx) => {
    ctx.push(ctx.props.todos, { text: draft || `새 할 일 ${seq++}`, done: false });
  },
  "[$0].TOGGLE": (_data, ctx) => {
    const done = ctx.props.todos[ctx.$0].done;
    ctx.set(done, !ctx.get(done));
  },
  "[$0].DEL": (_data, ctx) => {
    ctx.removeAt(ctx.props.todos, ctx.$0);
  },
};
