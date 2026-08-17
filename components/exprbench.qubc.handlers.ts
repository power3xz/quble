// @if 표현식 부하 벤치의 핸들러 - 그룹을 순차로 돌며 각각 따로 잰다.
//
// 그룹마다 자기 잎만 set한다. 조건이 "잎을 다 바꿔야 뒤집힌다"로 짜여 있어, set 한 번마다
// 재평가가 돌고 마지막 set에서 가지가 교체된다 - 잎이 많은 그룹일수록 재평가 횟수가 는다
// (부분 재계산이 없다).
//
// cold와 hot을 둘 다 잰다. 예열은 JIT과 레이아웃 경로를 데우는데 그 이득이 그룹마다 같다는
// 보장이 없어, 예열이 무엇을 얼마나 가렸는지 숫자로 남긴다.
//   cold - 그 그룹의 첫 왕복. 실제 앱에서 조건이 어쩌다 한 번 뒤집힐 때에 가깝다.
//   hot  - 예열 4왕복 뒤의 1왕복. 반복 갱신이 이어질 때에 가깝다.
//
// 한 번 재는 단위는 왕복(on -> off)이다 - 조건이 "잎을 다 바꿔야 뒤집힌다"라서 한 방향만
// 바꾸면 상태가 반대로 남는다. 왕복이라야 다음 회차가 같은 출발점에서 시작한다.
//
// 그룹은 `showing`으로 하나씩만 DOM에 올린다 - 다섯이 다 떠 있으면 한 그룹을 교체해도
// 브라우저가 문서 전체를 레이아웃해 다른 그룹 비용이 섞인다. 켠 직후에는 @if의 lazy build가
// rows개 회차를 그 자리에서 짓느라 무거우니, 0.5초를 두고 그게 끝난 뒤에 재기 시작한다.
type RunCtx = {
  props: Record<string, number>;
  get: (leafIndex: number) => unknown;
  set: (leafIndex: number, value: unknown) => void;
};

// 그룹별 잎. bool 잎과 숫자 잎을 갈라 둔다 - 켜는 값이 다르다(true / 2).
const GROUPS = [
  { name: "base", flags: ["baseFlag"], nums: [] },
  { name: "real", flags: ["realFlag"], nums: ["realA"] },
  { name: "deep", flags: [], nums: ["deepA", "deepB"] },
  { name: "wide", flags: [], nums: ["wideA", "wideB", "wideC", "wideD", "wideE", "wideF", "wideG", "wideH"] },
  { name: "both", flags: [], nums: ["bothA", "bothB", "bothC", "bothD", "bothE", "bothF", "bothG", "bothH"] },
];

const WARMUP = 4; // 예열 왕복 수
const GAP_MS = 500; // 그룹 사이 간격

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 그룹의 잎을 한 방향으로 전부 set한다. 마지막 set에서 가지가 교체된다. */
const setGroup = (ctx: RunCtx, group: (typeof GROUPS)[number], on: boolean) => {
  for (const name of group.flags) {
    ctx.set(ctx.props[name], on);
  }
  for (const name of group.nums) {
    ctx.set(ctx.props[name], on ? 2 : 0);
  }
};

/** 왕복 한 번(on -> off)을 재고 set 합과 페인트까지의 시간을 돌려준다. */
const measure = async (ctx: RunCtx, group: (typeof GROUPS)[number]) => {
  const t0 = performance.now();
  setGroup(ctx, group, true);
  const afterOn = performance.now();
  await nextFrame();

  const t1 = performance.now();
  setGroup(ctx, group, false);
  const afterOff = performance.now();
  await nextFrame();

  return { set: afterOn - t0 + (afterOff - t1), painted: performance.now() - t0 };
};

const pad = (n: number) => n.toFixed(2).padStart(8);

export const handlers = {
  RUN: async (_data: Record<string, unknown>, ctx: RunCtx) => {
    const rows: string[] = [];

    for (const [index, group] of GROUPS.entries()) {
      const leafCount = group.flags.length + group.nums.length;

      // 이 그룹만 DOM에 올린다. 켜는 순간 lazy build가 rows개를 짓는다 - 그게 가라앉을 때까지
      // 기다린 뒤에 잰다(이 비용은 측정 대상이 아니다).
      ctx.set(ctx.props.showing, index);
      await nextFrame();
      await sleep(GAP_MS);

      const cold = await measure(ctx, group);
      for (let i = 0; i < WARMUP; i++) {
        await measure(ctx, group);
      }
      const hot = await measure(ctx, group);

      rows.push(
        `${group.name.padEnd(5)} 잎 ${String(leafCount).padStart(2)}` +
          `  cold set ${pad(cold.set)}ms 페인트 ${pad(cold.painted)}ms` +
          `  hot set ${pad(hot.set)}ms 페인트 ${pad(hot.painted)}ms`,
      );

      await sleep(GAP_MS);
    }

    ctx.set(ctx.props.showing, -1); // 다 재고 나면 내린다 - 다음 RUN도 같은 출발점에서 시작한다.
    console.log(`[bench] 왕복 1회 기준, 예열 ${WARMUP}회\n${rows.join("\n")}`);
  },
};
