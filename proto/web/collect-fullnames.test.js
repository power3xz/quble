// 임시 주석
// // collectEventFullnames 단위 테스트 - 루트에서 합성 트리를 걸어 발사 가능한 이벤트 fullname을
// // 정적으로 산출한다(인스펙터가 핸들러를 fullname으로 걸 때 쓴다). runtime의 pathPrefix 누적과
// // 같은 결과를 디코드 단계에서 뽑는지 본다.

// import { test, before } from "node:test";
// import assert from "node:assert/strict";
// import { buildFixture } from "./fixtures/build.js";

// const { decodeForTest, collectEventFullnames } = await import("./disasm.js").then((m) => ({
//   collectEventFullnames: m.collectEventFullnames,
//   decodeForTest: m.inspect,
// }));

// let module;
// before(() => {
//   const qubb = buildFixture("event_fullname");
//   module = decodeForTest(qubb).module;
// });

// test("리터럴 인자로 합성하면 payload 출처가 그 상수값으로 끊긴다", () => {
//   // Card(루트, comp 0) -> Toggle을 리터럴(label="A" on="off")로 합성. fullname "Toggle.TOGGLE",
//   // payload 출처는 부모 scope 값이 아니라 리터럴이라 { kind:"literal", value }.
//   const events = collectEventFullnames(module, 0);
//   assert.deepEqual(events, [
//     {
//       fullname: "Toggle.TOGGLE",
//       payload: [
//         { field: "label", source: { kind: "lit", value: "A" } },
//         { field: "on", source: { kind: "lit", value: "off" } },
//       ],
//       contexts: [],
//     },
//   ]);
// });

// test("루트 컴포넌트 자신의 이벤트는 payload 출처가 자기 prop arg offset", () => {
//   // Toggle을 루트(comp 1)로 직접 보면 합성 경로가 없어 "TOGGLE", 출처는 자기 prop arg offset.
//   const events = collectEventFullnames(module, 1);
//   assert.deepEqual(events, [
//     {
//       fullname: "TOGGLE",
//       payload: [
//         { field: "label", source: { kind: "arg", offset: 0 } },
//         { field: "on", source: { kind: "arg", offset: 1 } },
//       ],
//       contexts: [],
//     },
//   ]);
// });
