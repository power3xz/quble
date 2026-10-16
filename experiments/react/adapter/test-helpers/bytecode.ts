import type { TQubleBytecode } from "../../../../core/web/runtime-entry.ts";
import { compileToModule } from "../vite-plugin.ts";

// 플러그인이 낸 모듈 소스에서 CSS import는 번들러 몫이라 떼고, 나머지를 실제 ESM으로 import해 기본 export를 얻는다.
export const evaluate = async (code: string): Promise<TQubleBytecode> => {
  const withoutCss = code.replace(/^import ".*";\n/gm, "");
  const url = `data:text/javascript;base64,${Buffer.from(withoutCss).toString("base64")}`;
  return (await import(url)).default;
};

// .qubc 파일을 플러그인과 같은 경로로 컴파일한 TQubleBytecode.
export const bytecodeOf = async (entryPath: string): Promise<TQubleBytecode> =>
  evaluate((await compileToModule(entryPath)).code);
