import { flushSync, mount } from "svelte";
import { runTarget } from "./harness.ts";
import Orders from "./Orders.svelte";

runTarget({
  id: "svelte",
  label: "Svelte 5",
  mount: (root, data) => {
    root.replaceChildren();
    mount(Orders, { target: root, props: { data } });
    flushSync();
  },
});
