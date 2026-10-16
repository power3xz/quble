// `import X from "./x.qubc"`의 타입. 기본 export가 번들러 플러그인(vite-plugin.ts)이 낸 바이트코드다.
// 앰비언트 모듈 선언 안에서는 상대 경로 import를 못 쓰므로 TQubleBytecode와 같은 Uint8Array로 적는다.
declare module "*.qubc" {
  const bytecode: Uint8Array;
  export default bytecode;
}
