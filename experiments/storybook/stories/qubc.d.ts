// qubc-plugin.ts가 `.qubc?qubb` import를 런타임 compile 결과로 바꾼다.
declare module "*.qubc?qubb" {
  const component: ReturnType<typeof import("../../../core/web/runtime.ts").compile>;
  export default component;
}
