// 서버 진입점이 낸 HTML을 브라우저 진입점이 hydrate하며 resume하는지. 노드를 새로 만들지 않고 핸들러만 붙어야 한다.

import "../runtime/test-helpers/dom.ts";

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { TQubleBytecode } from "../../../core/web/runtime-entry.ts";
import { createComponent as createBrowser } from "./react-browser.ts";
import { createComponent as createServer } from "./react-server.ts";
import { bytecodeOf } from "./test-helpers/bytecode.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let counter: TQubleBytecode;
before(async () => {
  counter = await bytecodeOf(join(FIXTURES, "counter.qubc"));
});

// 서버 진입점으로 그린 HTML을 호스트에 넣고 브라우저 진입점으로 hydrate한다.
const hydrate = async (props: Record<string, unknown>) => {
  const html = renderToString(createElement(createServer(counter), props as never));
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const serverButton = host.querySelector("button") as Element;
  const errors: unknown[] = [];
  const Browser = createBrowser(counter);
  const root = await act(async () =>
    hydrateRoot(host, createElement(Browser, props as never), {
      onRecoverableError: (error) => errors.push(error),
    }),
  );
  return { host, root, Browser, serverButton, errors };
};

test("서버가 그린 노드를 새로 만들지 않고 resume한다", async () => {
  const { host, serverButton, errors } = await hydrate({ label: "Go", count: 1 });
  assert.equal(host.querySelector("button"), serverButton, "서버가 그린 button이 그대로다");
  assert.equal(host.querySelector("p")?.textContent, "1");
  assert.deepEqual(errors, [], "hydration 불일치가 없다");
});

test("resume한 뒤 이벤트 핸들러가 동작한다", async () => {
  const clicks: unknown[] = [];
  const html = renderToString(createElement(createServer(counter), { label: "Go", count: 1 } as never));
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  await act(async () => {
    hydrateRoot(
      host,
      createElement(createBrowser(counter), {
        label: "Go",
        count: 1,
        handlers: { CLICK: (payload: unknown) => clicks.push(payload) },
      } as never),
    );
  });
  await act(async () => {
    (host.querySelector("button") as HTMLElement).click();
  });
  assert.equal(clicks.length, 1);
});

test("resume한 뒤 props가 바뀌면 같은 노드를 update한다", async () => {
  const { host, root, Browser } = await hydrate({ label: "Go", count: 1 });
  const text = host.querySelector("p") as Element;
  await act(async () => root.render(createElement(Browser, { label: "Go", count: 2 } as never)));
  assert.equal(host.querySelector("p"), text);
  assert.equal(text.textContent, "2");
});
