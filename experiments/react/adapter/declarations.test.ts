// .qubc의 타입 선언(x.qubc.d.ts)을 미리 만드는 단계 - 서버가 모듈을 불러오기를 기다리지 않는다.
// 옆에 쓰는 기본 경로와 typesDir로 옮긴 경로가 모두 tsc에서 import를 해석하는지까지 본다.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarationOf, writeDeclarations } from "./declarations.ts";

const HERE = dirname(fileURLToPath(import.meta.url)); // experiments/react/adapter
const TMP = join(HERE, "..", "dist", "adapter-test");
const TSC = join(HERE, "..", "..", "..", "node_modules", ".bin", "tsc");
mkdirSync(TMP, { recursive: true });

const COUNTER = "component C { props { n: number } events { GO({ n }) } template { button(@click:GO) { ${n} } } }";

// root 아래에 파일을 만든다.
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(TMP, "decl-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
};

test("선언은 TQubleBytecode<THandlers>를 기본 export로 낸다", async () => {
  const root = project({ "c.qubc": COUNTER });
  const dts = await declarationOf(join(root, "c.qubc"), join(root, "c.qubc.d.ts"));
  assert.match(dts, /^import type \{ TQubleBytecode \} from "[./]+.*core\/web\/decode";/);
  assert.match(dts, /export interface THandlers \{/);
  assert.match(dts, /declare const bytecode: TQubleBytecode<THandlers>;\nexport default bytecode;\n$/);
});

test("decode import 경로는 선언 파일이 놓이는 곳 기준이다", async () => {
  const root = project({ "c.qubc": COUNTER });
  const beside = await declarationOf(join(root, "c.qubc"), join(root, "c.qubc.d.ts"));
  const moved = await declarationOf(join(root, "c.qubc"), join(root, ".quble", "types", "c.qubc.d.ts"));
  const pathOf = (dts: string) => /from "([^"]+)"/.exec(dts)?.[1] as string;
  assert.notEqual(pathOf(beside), pathOf(moved));
  assert.ok(pathOf(moved).startsWith("../../"), "두 단계 더 깊다");
});

test("프로젝트의 .qubc 전부에 옆에 선언을 쓴다", async () => {
  const root = project({ "a.qubc": COUNTER, "sub/b.qubc": COUNTER });
  const { written, failed } = await writeDeclarations(root);
  assert.deepEqual(written.sort(), [join(root, "a.qubc.d.ts"), join(root, "sub", "b.qubc.d.ts")]);
  assert.deepEqual(failed, []);
  assert.ok(existsSync(join(root, "sub", "b.qubc.d.ts")));
});

test("node_modules, dist, 점으로 시작하는 디렉터리는 건너뛴다", async () => {
  const root = project({
    "a.qubc": COUNTER,
    "node_modules/pkg/x.qubc": COUNTER,
    "dist/y.qubc": COUNTER,
    ".hidden/z.qubc": COUNTER,
  });
  const { written } = await writeDeclarations(root);
  assert.deepEqual(written, [join(root, "a.qubc.d.ts")]);
});

test("컴파일되지 않는 파일은 건너뛰고 실패로 알린다", async () => {
  const root = project({ "ok.qubc": COUNTER, "bad.qubc": "component Bad {" });
  const { written, failed } = await writeDeclarations(root);
  assert.deepEqual(written, [join(root, "ok.qubc.d.ts")]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].path, join(root, "bad.qubc"));
  assert.match(failed[0].diagnostic, /bad\.qubc/);
});

test("내용이 같으면 다시 쓰지 않는다", async () => {
  const root = project({ "a.qubc": COUNTER });
  await writeDeclarations(root);
  const first = readFileSync(join(root, "a.qubc.d.ts"), "utf8");
  const { written } = await writeDeclarations(root);
  assert.deepEqual(written, [], "바뀐 것이 없다");
  assert.equal(readFileSync(join(root, "a.qubc.d.ts"), "utf8"), first);
});

test("typesDir를 주면 같은 상대 경로로 그곳에 쓰고 옆에는 쓰지 않는다", async () => {
  const root = project({ "a.qubc": COUNTER, "sub/b.qubc": COUNTER });
  const { written } = await writeDeclarations(root, ".quble/types");
  assert.deepEqual(written.sort(), [
    join(root, ".quble", "types", "a.qubc.d.ts"),
    join(root, ".quble", "types", "sub", "b.qubc.d.ts"),
  ]);
  assert.equal(existsSync(join(root, "a.qubc.d.ts")), false);
});

test("typesDir 안의 파일은 소스로 다시 찾지 않는다", async () => {
  const root = project({ "a.qubc": COUNTER });
  await writeDeclarations(root, "types");
  await writeDeclarations(root, "types");
  const { written } = await writeDeclarations(root, "types");
  assert.deepEqual(written, []);
});

// 소비자 코드가 선언을 실제로 찾는지 tsc로 확인한다. rootDirs로 typesDir를 소스 트리에 겹친다.
const typecheck = (root: string, rootDirs: string[]): string | null => {
  // 핸들러 맵 타입이 실려야 GO가 키로 통과한다.
  writeFileSync(
    join(root, "use.ts"),
    `import C from "./c.qubc";\nexport const key: keyof NonNullable<(typeof C)["__handlers"]> = "GO";\n`,
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        moduleResolution: "bundler",
        module: "ES2022",
        target: "ES2022",
        rootDirs,
        types: [],
      },
      include: ["use.ts"],
    }),
  );
  try {
    execFileSync(TSC, ["-p", join(root, "tsconfig.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
};

test("옆에 쓴 선언을 tsc가 해석한다", async () => {
  const root = project({ "c.qubc": COUNTER });
  await writeDeclarations(root);
  assert.equal(typecheck(root, ["."]), null);
});

test("typesDir에 쓴 선언을 rootDirs로 tsc가 해석한다", async () => {
  const root = project({ "c.qubc": COUNTER });
  await writeDeclarations(root, ".quble/types");
  assert.equal(typecheck(root, [".", ".quble/types"]), null);
});

test("rootDirs가 없으면 typesDir의 선언을 찾지 못한다", async () => {
  const root = project({ "c.qubc": COUNTER });
  await writeDeclarations(root, ".quble/types");
  assert.match(typecheck(root, ["."]) ?? "", /TS2307|TS2792|TS7016/);
});
