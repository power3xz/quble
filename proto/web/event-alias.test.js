// 임시 주석

// // alias 단위 테스트 - `Alias: Comp(...)`는 fullname 세그먼트를 type-name 대신 alias로 박는다.
// // 같은 Button이라도 alias가 다르면 fullname이 갈리고(분리), alias가 없으면 type-name으로 공유한다.
// // disasm 라운드트립은 세그먼트≠type-name일 때 `Alias: Comp(...)`로 복원하는지 본다.

// import { test, before } from "node:test";
// import assert from "node:assert/strict";
// import { buildFixture } from "./fixtures/build.js";

// const { decodeForTest, collectEventFullnames, decompileComponent } = await import(
//   "./disasm.js"
// ).then((m) => ({
//   collectEventFullnames: m.collectEventFullnames,
//   decodeForTest: m.inspect,
//   decompileComponent: m.decompileComponent,
// }));

// let qubb;
// let module;
// before(() => {
//   qubb = buildFixture("event_alias");
//   module = decodeForTest(qubb).module;
// });

// test("alias가 다르면 같은 Button이라도 fullname이 갈리고, alias 없으면 type-name으로 공유한다", () => {
//   // Bar(루트, comp 0) -> Save:/Cancel: alias 둘 + 무명 Button 하나.
//   const events = collectEventFullnames(module, 0);
//   const fullnames = events.map((e) => e.fullname);
//   assert.deepEqual(fullnames, ["Save.CLICK", "Cancel.CLICK", "Button.CLICK"]);
// });

// test("disasm은 세그먼트가 type-name과 다르면 `Alias: Comp(...)`로, 같으면 무명으로 복원한다", () => {
//   const text = decompileComponent(module, 0); // Bar
//   assert.match(text, /Save: Button\(/, "alias 있는 합성은 `Save: Button(...)`");
//   assert.match(text, /Cancel: Button\(/, "alias 있는 합성은 `Cancel: Button(...)`");
//   // alias 없는 합성은 prefix 없이 type-name만.
//   assert.match(text, /\n\s*Button\(/, "alias 없는 합성은 `Button(...)`");
// });
