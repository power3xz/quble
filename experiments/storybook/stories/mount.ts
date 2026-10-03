// story의 render. qubb 컴포넌트를 마운트하고, 핸들러가 받는 모든 fullname을 Actions 패널에 남긴다.
// 핸들러가 바꾼 상태는 args(Controls)에 되돌려 쓴다.
import { action } from "storybook/actions";
import { useArgs } from "storybook/preview-api";
import type { compile, THandlers } from "../../../core/web/runtime.ts";

type TComponent = ReturnType<typeof compile>;

// 키 순서와 무관하게 비교하려고 키를 정렬해 직렬화한다. args는 data.json 순서, snapshot은 props 선언 순서다.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

// 지금 화면. shown은 화면 상태와 같은 args의 직렬화다.
let current: { component: TComponent; host: HTMLElement; destroy: () => void; shown: string } | null = null;

export const mount = (component: TComponent, args: Record<string, unknown>, handlers: THandlers): HTMLElement => {
  const [, updateArgs] = useArgs();
  const shown = canonical(args);
  // 핸들러가 바꾼 값을 args에 되돌려 쓰면 Storybook이 render를 다시 부른다. 화면은 이미 그 상태라 그대로 둔다.
  if (current?.component === component && current.shown === shown) {
    return current.host;
  }
  current?.destroy();

  const syncArgs = () => {
    const next = inst.snapshot();
    const json = canonical(next);
    if (state.shown !== json) {
      state.shown = json;
      updateArgs(next);
    }
  };
  // 어떤 fullname이 와도 패널에 남기고, 그 이름의 핸들러가 있으면 이어서 부른다.
  const logged = new Proxy(handlers, {
    get: (target, key) => {
      if (typeof key !== "string") {
        return undefined;
      }
      return (data: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const loops = Object.fromEntries(Object.entries(ctx).filter(([name]) => name.startsWith("$")));
        // 패널이 인자를 배열 번호로 보여 주므로, 이름이 보이게 객체 하나로 넘긴다.
        action(key)({ data, context: ctx.context, ...loops });
        const result: unknown = target[key]?.(data, ctx);
        syncArgs();
        // await 뒤에 바꾼 값은 핸들러가 끝난 뒤에 반영한다.
        if (result instanceof Promise) {
          result.then(syncArgs, () => {});
        }
      };
    },
  });
  // 런타임이 data를 store로 옮기며 원본을 건드리지 않게 사본을 넘긴다(args는 Storybook 것이다).
  const inst = component(0)(structuredClone(args), logged);
  const host = document.createElement("div");
  host.append(...inst.nodes);
  const state = { component, host, destroy: inst.destroy, shown };
  current = state;
  return host;
};
