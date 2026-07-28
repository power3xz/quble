// 할 일 목록을 브라우저에서 확인하는 핸들러 - 회차 인덱스 반응성의 실사용 예. 추가(ADD)는 새 항목을
// 꼬리에 push하고, 삭제(@for 안 버튼이라 fullname은 익명 [$0].DEL)는 자기 회차 인덱스 $0으로 자기를 지운다.
// 중간 항목을 지우면 뒤 항목의 번호({i})가 당겨져 갱신되고, 그 뒤 항목의 삭제 버튼 $0도 당겨진 값이라
// 자기를 정확히 지운다(값 고정/위치 이동 설계의 인덱스 반응성).
type AddCtx = { props: Record<string, number>; push: (a: number, e: unknown) => void };
type DelCtx = { $0: number; props: Record<string, number>; removeAt: (a: number, i: number) => void };

let seq = 4; // 초기 3개 뒤 순번
const handlers = {
  ADD: (_data: Record<string, unknown>, ctx: AddCtx) => {
    ctx.push(ctx.props.todos, { text: `새 할 일 ${seq++}`, done: "o" });
  },
  "[$0].DEL": (_data: Record<string, unknown>, ctx: DelCtx) => {
    ctx.removeAt(ctx.props.todos, ctx.$0);
  },
};

export default handlers;
