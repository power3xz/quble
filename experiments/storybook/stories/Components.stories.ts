// components/의 예제를 짝 data와 핸들러로 띄운다. 클릭하면 핸들러가 상태를 바꾸고 fullname이 Actions에 남는다.
// 짝 핸들러는 타입을 직접 적은 것만 싣는다. ctx 타입을 ts-plugin이 주입해야 하는 파일은 이 실험의 타입 검사를
// 통과하지 못한다.
import type { Meta, StoryObj } from "@storybook/html-vite";
import todoData from "../../../components/todo_list.data.json";
import TodoList from "../../../components/todo_list.qubc?qubb";
import { handlers as todoHandlers } from "../../../components/todo_list.qubc.handlers.ts";
import type { THandlers } from "../../../core/web/runtime.ts";
import { mount } from "./mount.ts";

const meta: Meta = { title: "components" };
export default meta;

// 짝 핸들러의 ctx 타입은 그 파일이 필요한 만큼만 적은 것이라 런타임의 THandlers로 맞춘다.
export const Todo: StoryObj = {
  render: () => mount(TodoList, todoData, todoHandlers as unknown as THandlers),
};
