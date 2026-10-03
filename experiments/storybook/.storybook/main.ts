import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/html-vite";
import { qubc } from "../qubc-plugin.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

const config: StorybookConfig = {
  framework: "@storybook/html-vite",
  stories: ["../stories/*.stories.ts"],
  viteFinal: (vite) => ({
    ...vite,
    plugins: [...(vite.plugins ?? []), qubc()],
    // 런타임(core/web), 컴포넌트(components/, core/playground)는 이 디렉터리 밖이다.
    server: { ...vite.server, fs: { ...vite.server?.fs, allow: [REPO, join(HERE, "..")] } },
  }),
};

export default config;
