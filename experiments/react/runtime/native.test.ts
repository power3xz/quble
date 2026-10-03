import assert from "node:assert/strict";
import { test } from "node:test";
import { cls, QubleRoot, type TQ, textEvent, useQ } from "quble-react";
import { createElement, type FC } from "react";
import { renderToString } from "react-dom/server";

test("cls는 클래스마다 그 클래스를 가진 시트들의 스타일을 시트 순서로 모은다", () => {
  const a = { x: { color: "red" }, y: { gap: 1 } };
  const b = { x: { color: "blue" } };
  assert.deepEqual(cls([a, b], "x y"), [{ color: "red" }, { color: "blue" }, { gap: 1 }]);
});

test("cls는 공백을 여럿 둬도 나누고, 없는 클래스와 빈 문자열은 건너뛴다", () => {
  const a = { x: { color: "red" } };
  assert.deepEqual(cls([a], "  x   nope "), [{ color: "red" }]);
  assert.deepEqual(cls([a], ""), []);
  assert.deepEqual(cls([], "x"), []);
});

test("cls는 시트 객체의 프로토타입 키를 클래스로 보지 않는다", () => {
  assert.deepEqual(cls([{}], "constructor toString"), []);
});

test("textEvent는 핸들러가 event.target.value로 읽는 모양이다", () => {
  const event = textEvent("hello");
  event.stopPropagation();
  assert.equal((event.nativeEvent as unknown as { target: { value: string } }).target.value, "hello");
});

test("q.emit에 textEvent를 넘기면 핸들러의 event.target.value가 그 문자열이다", () => {
  let q: TQ | undefined;
  const Probe: FC<Record<string, unknown>> = () => {
    q = useQ();
    return null;
  };
  const seen: string[] = [];
  renderToString(
    createElement(QubleRoot, {
      component: Probe,
      initial: {},
      handlers: {
        EDIT: (_data, ctx) => {
          seen.push((ctx.event as unknown as { target: { value: string } }).target.value);
        },
      },
    }),
  );
  assert.ok(q);
  q.emit("EDIT", {}, textEvent("typed"));
  assert.deepEqual(seen, ["typed"]);
});
