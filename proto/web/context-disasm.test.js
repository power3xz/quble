// 임시 주석

// // @with 컨텍스트 disasm 복원 테스트 - qubb를 qubc로 디컴파일할 때 contexts 블록과 @with 본문이
// // 살아나는지 본다. 변수명은 소실돼 argN으로 복원된다(disasm 전반의 동작).

// import { test, before } from "node:test";
// import assert from "node:assert/strict";
// import { buildFixture } from "./fixtures/build.js";

// const { inspect, decompileComponent } = await import("./disasm.js");

// let module;
// before(() => {
//   module = inspect(buildFixture("event_context")).module;
// });

// test("contexts 블록이 복원된다 - 리터럴은 문자열, 변수는 argN", () => {
//   const text = decompileComponent(module, 0);
//   assert.match(text, /contexts \{ Area \{ section: "actions", userId: arg0 \} \}/);
// });

// test("@with 블록이 들여쓴 본문으로 복원된다", () => {
//   const text = decompileComponent(module, 0);
//   assert.match(text, /@with Area \{/, "@with 블록 열림");
//   // @with 안의 button이 한 단계 더 들여써진다(template 1단 + @with 1단 = 2단 = 6칸).
//   assert.match(text, /\n {6}button\(@click:TOGGLE\)/, "@with 본문은 한 단계 더 들여씀");
// });

// test("컨텍스트가 참조한 scope가 props에 포함된다", () => {
//   const text = decompileComponent(module, 0);
//   assert.match(text, /props \{ arg0 \}/, "userId: arg0가 props에 잡힌다");
// });
