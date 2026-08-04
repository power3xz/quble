// .qubc 컴포넌트의 핸들러 타입은 ts-plugin이 붙인다 - 편집 중인 handlers.ts에 디스크 파일도
// import도 없이 얹는다(editors/ts-plugin). 확장이 하는 일은 등록(package.json의
// typescriptServerPlugins)과 wasm 경로 전달뿐이다.
//
// plugin은 tsserver 안에서 돌아 자기가 어디 설치됐는지 모른다. 그래서 확장이 .wasm 경로를
// 넘겨야 한다 - 확장에 동봉하므로 레포 위치에 매이지 않는다.

import { join } from "node:path";
import * as vscode from "vscode";

// 번들이 CJS라 import.meta.url이 비어 패키지 기본값(wasmPath())을 못 쓴다 - 빌드가 dist/에
// 복사해 둔 것을 __dirname으로 짚는다.
const WASM = join(__dirname, "compiler_wasm.wasm");

// 진단용 출력 채널 - "출력" 패널에서 Quble 선택. 실패 원인을 여기에 찍는다.
const log = vscode.window.createOutputChannel("Quble");

/**
 * ts-plugin에 wasm 경로를 넘긴다. 내장 TS 확장이 이 API를 통해 설정을 전달한다.
 *
 * 이 설정은 tsserver가 파일을 연 뒤에 도착할 수 있다(확장 activate가 그보다 늦다) - plugin이
 * 그 경우를 처리한다.
 */
const configureTsPlugin = async () => {
  const ts = vscode.extensions.getExtension("vscode.typescript-language-features");
  if (ts === undefined) {
    log.appendLine("TS 확장을 찾지 못해 핸들러 타입 주입이 꺼집니다.");
    return;
  }
  await ts.activate();
  const api = ts.exports?.getAPI?.(0);
  if (api?.configurePlugin === undefined) {
    log.appendLine(`TS 확장 API를 쓸 수 없습니다(exports=${typeof ts.exports}, api=${typeof api}).`);
    return;
  }
  // package.json의 typescriptServerPlugins에 적은 이름과 같아야 한다.
  api.configurePlugin("quble-ts-plugin", { wasmPath: WASM });
  log.appendLine(`ts-plugin에 wasm 경로를 넘겼습니다: ${WASM}`);
};

export const activate = () => {
  void configureTsPlugin();
};
