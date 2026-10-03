import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/html-vite";
import { pairsOf, qubc } from "../qubc-plugin.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

// story로 띄울 .qubc 디렉터리. 레포 루트 기준, 쉼표로 나눈다. QUBLE_STORY_DIRS=components,core/playground
const STORY_DIRS = (process.env.QUBLE_STORY_DIRS ?? "components").split(",").filter(Boolean);

const config: StorybookConfig = {
  framework: "@storybook/html-vite",
  stories: STORY_DIRS.map((dir) => ({ directory: join(REPO, dir), files: "*.qubc", titlePrefix: dir })),
  // 짝 data와 핸들러가 둘 다 있는 .qubc 하나가 story 하나다. 내용은 qubc-plugin.ts가 story 모듈(CSF)로 만든다.
  experimental_indexers: async (indexers) => [
    ...(indexers ?? []),
    {
      test: /\.qubc$/,
      createIndex: async (fileName, { makeTitle }) =>
        pairsOf(fileName) ? [{ type: "story", importPath: fileName, exportName: "Default", title: makeTitle() }] : [],
    },
  ],
  viteFinal: (vite) => ({
    ...vite,
    plugins: [...(vite.plugins ?? []), qubc()],
    // 런타임(core/web), 컴포넌트(components/, core/playground)는 이 디렉터리 밖이다.
    server: { ...vite.server, fs: { ...vite.server?.fs, allow: [REPO, join(HERE, "..")] } },
  }),
};

export default config;
