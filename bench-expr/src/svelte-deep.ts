import { flushSync, mount } from "svelte";
import { runTarget } from "./harness.ts";
import OrdersDeep from "./OrdersDeep.svelte";

runTarget({
  id: "svelte-deep",
  label: "Svelte 5 (deep)",
  mount: (root, data) => {
    root.replaceChildren();
    mount(OrdersDeep, { target: root, props: { data } });
    flushSync();
  },
});
