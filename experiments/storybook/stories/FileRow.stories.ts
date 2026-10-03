// playground 셸의 파일 목록 행. props를 Controls로 바꾸면 다시 마운트한다.
import type { Meta, StoryObj } from "@storybook/html-vite";
import FileRow from "../../../core/playground/filerow.qubc?qubb";
import { mount } from "./mount.ts";

type TArgs = { name: string; isEntry: boolean; isEditing: boolean; isPreviewing: boolean; hasError: boolean };

const meta: Meta<TArgs> = {
  title: "playground/FileRow",
  render: (args) => mount(FileRow, args),
  // 셸 배경이 어두워 행 스타일이 그 위에서 맞춰져 있다.
  parameters: { backgrounds: { default: "dark" } },
  globals: { backgrounds: { value: "dark" } },
};
export default meta;

type TStory = StoryObj<TArgs>;

export const Entry: TStory = {
  args: { name: "board.qubc", isEntry: true, isEditing: true, isPreviewing: false, hasError: false },
};

export const Previewing: TStory = {
  args: { name: "board.qubc", isEntry: true, isEditing: false, isPreviewing: true, hasError: false },
};

export const WithError: TStory = {
  args: { name: "card.qubc", isEntry: true, isEditing: false, isPreviewing: false, hasError: true },
};

export const Resource: TStory = {
  args: { name: "board.css", isEntry: false, isEditing: false, isPreviewing: false, hasError: false },
};
