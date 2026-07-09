// 큰 payload(필드100/깊이5) 조립을 브라우저에서 확인하는 핸들러. 버튼 클릭 = SAVE 발생 =
// 큰 객체 조립. 조립된 data.big을 콘솔에 찍는다. (조립 시간 측정은 bench.html의 연타 버튼에서.)
const handlers = {
  SAVE: (data: Record<string, unknown>) => {
    const leafCount = JSON.stringify(data.big).match(/"v"/g)?.length ?? 0;
    console.log(`[SAVE] leaf ${leafCount}개 조립됨:`, data.big);
  },
};

export default handlers;
