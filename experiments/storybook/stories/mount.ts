// story의 render. qubb 컴포넌트를 마운트하고, 핸들러가 받는 모든 fullname을 Actions 패널에 남긴다.
import { action } from "storybook/actions";
import type { compile, THandlers } from "../../../core/web/runtime.ts";

type TComponent = ReturnType<typeof compile>;

// args가 바뀌면 render가 다시 불린다. 이전 인스턴스를 해체해야 document 위임 리스너가 쌓이지 않는다.
let current: { destroy: () => void } | null = null;

export const mount = (component: TComponent, data: unknown, handlers: THandlers = {}): HTMLElement => {
  current?.destroy();
  // 어떤 fullname이 와도 패널에 남기고, 그 이름의 핸들러가 있으면 이어서 부른다.
  const logged = new Proxy(handlers, {
    get: (target, key) => {
      if (typeof key !== "string") {
        return undefined;
      }
      return (data: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const loops = Object.fromEntries(Object.entries(ctx).filter(([name]) => name.startsWith("$")));
        action(key)(data, { context: ctx.context, ...loops });
        target[key]?.(data, ctx);
      };
    },
  });
  // 런타임이 data를 store로 옮기며 원본을 건드리지 않게 사본을 넘긴다(args는 Storybook 것이다).
  const inst = component(0)(structuredClone(data), logged);
  current = inst;
  const host = document.createElement("div");
  host.append(...inst.nodes);
  return host;
};
